// Reassembles ZCode v4 physical wire frames into logical topic frames. Complete frames
// pass through; fragments stage per logicalFrameId until the declared count arrives, then
// the decoded byte concatenation is checksummed and parsed. Everything fails into a typed
// reason so a caller can resync (drop the subscription) instead of waiting forever.

import { z } from 'zod'
import {
  V4_WIRE_PROTOCOL_VERSION,
  zcodeV4LogicalFrameEnvelopeSchema
} from './zcode-v4-protocol-messages'
import type {
  ZcodeV4LogicalFrameEnvelope,
  ZcodeV4WireFrameCandidate
} from './zcode-v4-protocol-messages'

/** Standard CRC-32 (IEEE, reflected, poly 0xEDB88320) — the algorithm ZCode's own
 *  `crc32WireBytes` implements; "123456789" must hash to cbf43926. */
export function crc32WireBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024
const MAX_FRAGMENTS = 1024
const MAX_STAGED_ASSEMBLIES = 32
const MAX_STAGED_BYTES = 32 * 1024 * 1024
const ASSEMBLY_TIMEOUT_MS = 30_000

const fragmentHeadSchema = z.object({
  fragmentIndex: z.number().int().nonnegative(),
  fragmentCount: z.number().int().positive(),
  logicalBytes: z.number().int().positive(),
  checksum: z
    .object({ algorithm: z.literal('crc32'), value: z.string().regex(/^[0-9a-f]{8}$/u) })
    .strict(),
  dataBase64: z
    .string()
    .min(4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
})

export type ZcodeV4ReassemblyFailure =
  | 'wire-version'
  | 'frame-ordinal'
  | 'fragment-shape'
  | 'fragment-count'
  | 'fragment-index'
  | 'fragment-metadata'
  | 'duplicate-fragment'
  | 'assembly-too-large'
  | 'staged-bytes'
  | 'assembly-timeout'
  | 'checksum'
  | 'length'
  | 'not-logical-frame'

export type ZcodeV4ReassemblyResult =
  | { status: 'complete'; frame: ZcodeV4LogicalFrameEnvelope }
  | { status: 'pending' }
  | { status: 'failed'; reason: ZcodeV4ReassemblyFailure }

type StagedAssembly = {
  fragmentCount: number
  logicalBytes: number
  checksum: string
  logicalFrameOrdinal: number
  deliveryKind: ZcodeV4WireFrameCandidate['deliveryKind']
  createdAt: number
  stagedBytes: number
  parts: Map<number, Buffer>
}

export class ZcodeV4FrameReassembler {
  private readonly staged = new Map<string, StagedAssembly>()

  constructor(private readonly now: () => number = Date.now) {}

  clear(): void {
    this.staged.clear()
  }

  /** Feeds one physical frame; a complete frame resolves immediately, a fragmented one
   *  stays `pending` until its last part lands. */
  feed(candidate: ZcodeV4WireFrameCandidate): ZcodeV4ReassemblyResult {
    if (this.dropExpired()) {
      return { status: 'failed', reason: 'assembly-timeout' }
    }
    if (candidate.wireVersion !== V4_WIRE_PROTOCOL_VERSION) {
      return { status: 'failed', reason: 'wire-version' }
    }
    if (
      !Number.isSafeInteger(candidate.logicalFrameOrdinal) ||
      candidate.logicalFrameOrdinal <= 0
    ) {
      return { status: 'failed', reason: 'frame-ordinal' }
    }
    if (candidate.kind === 'complete') {
      return this.parseLogical(candidate.frame)
    }
    return this.feedFragment(candidate)
  }

  private feedFragment(
    candidate: Extract<ZcodeV4WireFrameCandidate, { kind: 'fragment' }>
  ): ZcodeV4ReassemblyResult {
    const head = fragmentHeadSchema.safeParse(candidate)
    if (!head.success) {
      return { status: 'failed', reason: 'fragment-shape' }
    }
    const { fragmentIndex, fragmentCount, logicalBytes, checksum, dataBase64 } = head.data
    if (
      fragmentCount > MAX_FRAGMENTS ||
      fragmentCount > logicalBytes ||
      logicalBytes > MAX_ASSEMBLY_BYTES
    ) {
      return { status: 'failed', reason: 'fragment-count' }
    }
    if (fragmentIndex >= fragmentCount) {
      return { status: 'failed', reason: 'fragment-index' }
    }

    const staged = this.stage(candidate.logicalFrameId, {
      fragmentCount,
      logicalBytes,
      checksum: checksum.value,
      logicalFrameOrdinal: candidate.logicalFrameOrdinal,
      deliveryKind: candidate.deliveryKind
    })
    if (
      staged.fragmentCount !== fragmentCount ||
      staged.logicalBytes !== logicalBytes ||
      staged.checksum !== checksum.value ||
      staged.logicalFrameOrdinal !== candidate.logicalFrameOrdinal ||
      staged.deliveryKind !== candidate.deliveryKind
    ) {
      this.staged.delete(candidate.logicalFrameId)
      return { status: 'failed', reason: 'fragment-metadata' }
    }
    if (staged.parts.has(fragmentIndex)) {
      return { status: 'failed', reason: 'duplicate-fragment' }
    }
    const part = Buffer.from(dataBase64, 'base64')
    if (this.totalStagedBytes() + part.byteLength > MAX_STAGED_BYTES) {
      this.staged.delete(candidate.logicalFrameId)
      return { status: 'failed', reason: 'staged-bytes' }
    }
    staged.parts.set(fragmentIndex, part)
    staged.stagedBytes += part.byteLength
    if (staged.parts.size < staged.fragmentCount) {
      return { status: 'pending' }
    }
    return this.assemble(candidate.logicalFrameId, staged)
  }

  private stage(
    logicalFrameId: string,
    head: {
      fragmentCount: number
      logicalBytes: number
      checksum: string
      logicalFrameOrdinal: number
      deliveryKind: ZcodeV4WireFrameCandidate['deliveryKind']
    }
  ): StagedAssembly {
    const existing = this.staged.get(logicalFrameId)
    if (existing) {
      return existing
    }
    while (this.staged.size >= MAX_STAGED_ASSEMBLIES) {
      // Oldest insertion dies first; a publisher never interleaves more than a handful.
      const oldest = this.staged.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.staged.delete(oldest)
    }
    const staged: StagedAssembly = {
      ...head,
      createdAt: this.now(),
      stagedBytes: 0,
      parts: new Map()
    }
    this.staged.set(logicalFrameId, staged)
    return staged
  }

  private dropExpired(): boolean {
    let expired = false
    const now = this.now()
    for (const [id, assembly] of this.staged) {
      if (now - assembly.createdAt >= ASSEMBLY_TIMEOUT_MS) {
        this.staged.delete(id)
        expired = true
      }
    }
    return expired
  }

  private totalStagedBytes(): number {
    let total = 0
    for (const assembly of this.staged.values()) {
      total += assembly.stagedBytes
    }
    return total
  }

  private assemble(logicalFrameId: string, staged: StagedAssembly): ZcodeV4ReassemblyResult {
    this.staged.delete(logicalFrameId)
    const bytes = Buffer.alloc(staged.logicalBytes)
    let written = 0
    for (let index = 0; index < staged.fragmentCount; index += 1) {
      const part = staged.parts.get(index)
      if (!part) {
        return { status: 'failed', reason: 'fragment-count' }
      }
      if (written + part.byteLength > staged.logicalBytes) {
        return { status: 'failed', reason: 'length' }
      }
      part.copy(bytes, written)
      written += part.byteLength
    }
    if (written !== staged.logicalBytes) {
      return { status: 'failed', reason: 'length' }
    }
    if (crc32WireBytes(bytes) !== staged.checksum) {
      return { status: 'failed', reason: 'checksum' }
    }
    try {
      return this.parseLogical(JSON.parse(new TextDecoder().decode(bytes)))
    } catch {
      return { status: 'failed', reason: 'not-logical-frame' }
    }
  }

  private parseLogical(value: unknown): ZcodeV4ReassemblyResult {
    const parsed = zcodeV4LogicalFrameEnvelopeSchema.safeParse(value)
    if (!parsed.success) {
      return { status: 'failed', reason: 'not-logical-frame' }
    }
    return { status: 'complete', frame: parsed.data }
  }
}
