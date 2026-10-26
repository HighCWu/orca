import { describe, expect, it } from 'vitest'
import { V4_WIRE_PROTOCOL_VERSION } from './zcode-v4-protocol-messages'
import type { ZcodeV4WireFrameCandidate } from './zcode-v4-protocol-messages'
import { crc32WireBytes, ZcodeV4FrameReassembler } from './zcode-v4-frame-reassembly'

const LOGICAL_FRAME = {
  topic: 'sessions-index/ws-1',
  subscriptionId: 'sub-1',
  fromSeq: 0,
  toSeq: 2,
  sentAt: 1_792_800_000_000,
  payload: {
    kind: 'snapshot',
    snapshot: {
      protocolVersion: 1,
      workspaceId: 'ws-1',
      logEpoch: 'epoch-1',
      sessions: [
        {
          sessionId: 'session_a',
          workspaceId: 'ws-1',
          title: 'First',
          sessionEnded: false,
          hasBackgroundWork: false,
          lastActivityAt: 1_792_800_000_000,
          createdAt: 1_792_800_000_000
        }
      ]
    }
  }
}

type WireHead = Pick<
  Extract<ZcodeV4WireFrameCandidate, { kind: 'complete' }>,
  | 'wireVersion'
  | 'deliveryKind'
  | 'logicalFrameId'
  | 'logicalFrameOrdinal'
  | 'topic'
  | 'subscriptionId'
>

function frameHead(): WireHead {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    deliveryKind: 'initial',
    logicalFrameId: 'frame-1',
    logicalFrameOrdinal: 1,
    topic: 'sessions-index/ws-1',
    subscriptionId: 'sub-1'
  }
}

function encodedFragment(
  head: WireHead,
  index: number,
  count: number,
  bytes: Uint8Array,
  logicalBytes: number,
  checksum: string
): ZcodeV4WireFrameCandidate {
  return {
    ...head,
    kind: 'fragment',
    fragmentIndex: index,
    fragmentCount: count,
    logicalBytes,
    checksum: { algorithm: 'crc32', value: checksum },
    dataBase64: Buffer.from(bytes).toString('base64')
  }
}

describe('crc32WireBytes', () => {
  it('hashes the standard CRC-32 check vector', () => {
    expect(crc32WireBytes(new TextEncoder().encode('123456789'))).toBe('cbf43926')
    expect(crc32WireBytes(new TextEncoder().encode(''))).toBe('00000000')
  })
})

describe('ZcodeV4FrameReassembler', () => {
  it('passes a complete frame straight through', () => {
    const result = new ZcodeV4FrameReassembler().feed({
      ...frameHead(),
      kind: 'complete',
      frame: LOGICAL_FRAME
    })
    expect(result).toEqual({ status: 'complete', frame: LOGICAL_FRAME })
  })

  it('reassembles fragmented frames in order and verifies the checksum', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    const checksum = crc32WireBytes(bytes)
    const reassembler = new ZcodeV4FrameReassembler()
    expect(
      reassembler.feed(
        encodedFragment(frameHead(), 1, 2, bytes.subarray(1), bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'pending' })
    expect(
      reassembler.feed(
        encodedFragment(frameHead(), 0, 2, bytes.subarray(0, 1), bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'complete', frame: LOGICAL_FRAME })
  })

  it('fails closed on a checksum mismatch, a bad wire version, and a non-frame payload', () => {
    const reassembler = new ZcodeV4FrameReassembler()
    expect(
      reassembler.feed({
        ...frameHead(),
        kind: 'complete',
        frame: { topic: 'conversation/x' }
      })
    ).toEqual({ status: 'failed', reason: 'not-logical-frame' })
    // A deliberately malformed frame arrives as untyped JSON on the wire, so the
    // round-trip (not a cast) is what builds it.
    const staleWire: ZcodeV4WireFrameCandidate = JSON.parse(
      JSON.stringify({ ...frameHead(), wireVersion: 99, kind: 'complete', frame: LOGICAL_FRAME })
    )
    expect(reassembler.feed(staleWire)).toEqual({ status: 'failed', reason: 'wire-version' })

    const bytes = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    expect(
      reassembler.feed(encodedFragment(frameHead(), 0, 1, bytes, bytes.byteLength, 'deadbeef'))
    ).toEqual({ status: 'failed', reason: 'checksum' })
  })

  it('returns a typed failure for checksum-valid fragmented malformed JSON', () => {
    const bytes = new TextEncoder().encode('{not-json')
    const result = new ZcodeV4FrameReassembler().feed(
      encodedFragment(frameHead(), 0, 1, bytes, bytes.byteLength, crc32WireBytes(bytes))
    )

    expect(result).toEqual({ status: 'failed', reason: 'not-logical-frame' })
  })

  it('drops incomplete assemblies when the subscription is cleared', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    const checksum = crc32WireBytes(bytes)
    const reassembler = new ZcodeV4FrameReassembler()
    const first = encodedFragment(
      frameHead(),
      0,
      2,
      bytes.subarray(0, 1),
      bytes.byteLength,
      checksum
    )
    expect(reassembler.feed(first)).toEqual({ status: 'pending' })

    reassembler.clear()

    expect(reassembler.feed(first)).toEqual({ status: 'pending' })
  })

  it('expires an incomplete assembly after the protocol timeout', () => {
    let now = 0
    const reassembler = new ZcodeV4FrameReassembler(() => now)
    const bytes = new TextEncoder().encode('{}')
    const fragment = encodedFragment(frameHead(), 0, 2, bytes, 2, crc32WireBytes(bytes))
    expect(reassembler.feed(fragment)).toEqual({ status: 'pending' })
    now = 30_000
    expect(
      reassembler.feed({
        ...frameHead(),
        logicalFrameId: 'frame-2',
        kind: 'complete',
        frame: LOGICAL_FRAME
      })
    ).toEqual({ status: 'failed', reason: 'assembly-timeout' })
  })

  it('rejects invalid ordinals and fragment envelope identity changes', () => {
    expect(
      new ZcodeV4FrameReassembler().feed({
        ...frameHead(),
        logicalFrameOrdinal: 0,
        kind: 'complete',
        frame: LOGICAL_FRAME
      })
    ).toEqual({ status: 'failed', reason: 'frame-ordinal' })

    const bytes = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    const checksum = crc32WireBytes(bytes)
    const reassembler = new ZcodeV4FrameReassembler()
    expect(
      reassembler.feed(
        encodedFragment(frameHead(), 0, 2, bytes.subarray(0, 1), bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'pending' })
    expect(
      reassembler.feed(
        encodedFragment(
          { ...frameHead(), logicalFrameOrdinal: 2 },
          1,
          2,
          bytes.subarray(1),
          bytes.byteLength,
          checksum
        )
      )
    ).toEqual({ status: 'failed', reason: 'fragment-metadata' })
  })

  it('rejects fragment metadata changes and bytes beyond the declared length', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    const checksum = crc32WireBytes(bytes)
    const reassembler = new ZcodeV4FrameReassembler()
    expect(
      reassembler.feed(
        encodedFragment(frameHead(), 0, 2, bytes.subarray(0, 1), bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'pending' })
    expect(
      reassembler.feed(
        encodedFragment(frameHead(), 1, 3, bytes.subarray(1), bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'failed', reason: 'fragment-metadata' })

    const prefixed = new TextEncoder().encode(JSON.stringify(LOGICAL_FRAME))
    const overflow = new Uint8Array(prefixed.byteLength + 1)
    overflow.set(prefixed)
    expect(
      new ZcodeV4FrameReassembler().feed(
        encodedFragment(
          { ...frameHead(), logicalFrameId: 'overflow' },
          0,
          1,
          overflow,
          prefixed.byteLength,
          crc32WireBytes(prefixed)
        )
      )
    ).toEqual({ status: 'failed', reason: 'length' })
  })

  it('rejects non-canonical base64 and more fragments than logical bytes', () => {
    const bytes = new TextEncoder().encode('{}')
    const checksum = crc32WireBytes(bytes)
    const invalidBase64 = encodedFragment(frameHead(), 0, 1, bytes, bytes.byteLength, checksum)
    if (invalidBase64.kind === 'fragment') {
      invalidBase64.dataBase64 = 'e30'
    }
    expect(new ZcodeV4FrameReassembler().feed(invalidBase64)).toEqual({
      status: 'failed',
      reason: 'fragment-shape'
    })
    expect(
      new ZcodeV4FrameReassembler().feed(
        encodedFragment(frameHead(), 0, 3, bytes, bytes.byteLength, checksum)
      )
    ).toEqual({ status: 'failed', reason: 'fragment-count' })
  })

  it('rejects a duplicate fragment and an out-of-range index', () => {
    const bytes = new TextEncoder().encode('{}')
    const fragment = encodedFragment(frameHead(), 0, 2, bytes, 2, crc32WireBytes(bytes))
    const reassembler = new ZcodeV4FrameReassembler()
    expect(reassembler.feed(fragment)).toEqual({ status: 'pending' })
    expect(reassembler.feed(fragment)).toEqual({ status: 'failed', reason: 'duplicate-fragment' })
    expect(reassembler.feed({ ...fragment, fragmentIndex: 5 })).toEqual({
      status: 'failed',
      reason: 'fragment-index'
    })
  })
})
