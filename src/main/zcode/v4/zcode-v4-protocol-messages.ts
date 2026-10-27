// The slice of ZCode's v4 wire contract Orca consumes, ported from the CLI's own
// `@zcode/shared/zcode-protocol-v4` (transport/command/sessions-index/core). Shapes are
// checked against CLI 3.16; fields Orca does not read stay loose so an additive CLI
// change cannot fail a parse.

import { z } from 'zod'

export const V4_WIRE_PROTOCOL_VERSION = 3

/** Unix ms, always the CLI's clock; clients never diff local clocks against it. */
export const zcodeV4TimestampSchema = z.number()
export type ZcodeV4Timestamp = z.infer<typeof zcodeV4TimestampSchema>

export const V4_METHODS = {
  conversationSubscribe: 'v4/conversation/subscribe',
  conversationUnsubscribe: 'v4/conversation/unsubscribe',
  conversationResync: 'v4/conversation/resync',
  conversationRowsRange: 'v4/conversation/rowsRange',
  attachmentBegin: 'v4/attachment/begin',
  attachmentChunk: 'v4/attachment/chunk',
  attachmentCommit: 'v4/attachment/commit',
  attachmentAbort: 'v4/attachment/abort',
  command: 'v4/command'
} as const

export const V4_NOTIFICATIONS = {
  conversationFrame: 'v4/conversation/frame'
} as const

export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`
}

export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`
}

export const zcodeV4SubscribeAckSchema = z
  .object({
    subscriptionId: z.string(),
    // resume = the caller's base watermark is valid, deltas follow; else a snapshot frame.
    mode: z.enum(['snapshot', 'resume']),
    logEpoch: z.string()
  })
  .loose()
export type ZcodeV4SubscribeAck = z.infer<typeof zcodeV4SubscribeAckSchema>

export const zcodeV4SubscribeResultSchema = z.union([
  zcodeV4SubscribeAckSchema,
  z.looseObject({ ack: zcodeV4SubscribeAckSchema }).transform((result) => result.ack)
])

export const zcodeV4ConversationRowsRangeParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    clientMode: z.enum(['desktop-continuous', 'web-remote-replayable']).optional(),
    beforeRowId: z.number().optional(),
    limit: z.number().int().min(1).max(200)
  })
  .loose()

export const zcodeV4ConversationRowsRangeResultSchema = z
  .object({
    rows: z.array(z.unknown()),
    atSeq: z.number(),
    atRevision: z.number().int().nonnegative(),
    atLogEpoch: z.string(),
    hasMore: z.boolean()
  })
  .loose()

export const zcodeV4ConversationSubscribeParamsSchema = z
  .object({
    topic: z.string().min(1),
    connectionId: z.string(),
    // Only trusted-host values; the CLI rejects others downstream.
    clientMode: z.enum(['desktop-continuous', 'web-remote-replayable']),
    // Watermark: send only when holding a consistent state at that seq.
    base: z.looseObject({ logEpoch: z.string(), seq: z.number() }).optional(),
    visibility: z.enum(['foreground', 'background']).optional(),
    // Cold-resume hint for a thought level the caller durably holds.
    resumeThoughtLevel: z.string().trim().min(1).optional()
  })
  .loose()
export type ZcodeV4ConversationSubscribeParams = z.infer<
  typeof zcodeV4ConversationSubscribeParamsSchema
>

// ── Physical frames ──

export const zcodeV4DeliveryKindSchema = z.enum(['initial', 'online', 'recovery'])
export type ZcodeV4DeliveryKind = z.infer<typeof zcodeV4DeliveryKindSchema>

export const zcodeV4WireChecksumSchema = z
  .object({ algorithm: z.literal('crc32'), value: z.string().regex(/^[0-9a-f]{8}$/u) })
  .strict()

const wireHead = {
  wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
  deliveryKind: zcodeV4DeliveryKindSchema,
  logicalFrameId: z.string().min(1),
  logicalFrameOrdinal: z.number(),
  topic: z.string().min(1),
  subscriptionId: z.string().min(1)
}

/** Outer shape only; the inner logical payload is validated after reassembly so a bad
 *  frame surfaces as a typed fault instead of an early warn-and-drop. */
export const zcodeV4WireFrameCandidateSchema = z.discriminatedUnion('kind', [
  z.looseObject({ ...wireHead, kind: z.literal('complete'), frame: z.unknown().optional() }),
  z.looseObject({
    ...wireHead,
    kind: z.literal('fragment'),
    fragmentIndex: z.unknown().optional(),
    fragmentCount: z.unknown().optional(),
    logicalBytes: z.unknown().optional(),
    checksum: z.unknown().optional(),
    dataBase64: z.unknown().optional()
  })
])
export type ZcodeV4WireFrameCandidate = z.infer<typeof zcodeV4WireFrameCandidateSchema>

export const zcodeV4FrameNotificationSchema = z
  .object({ method: z.literal('v4/conversation/frame'), params: zcodeV4WireFrameCandidateSchema })
  .loose()

// ── Logical frame envelope ──

export const zcodeV4LogicalFrameEnvelopeSchema = z
  .object({
    topic: z.string(),
    subscriptionId: z.string(),
    // Account (fromSeq, toSeq]; a snapshot frame pins fromSeq to 0.
    fromSeq: z.number(),
    toSeq: z.number(),
    sentAt: zcodeV4TimestampSchema,
    payload: z.discriminatedUnion('kind', [
      z.looseObject({ kind: z.literal('snapshot'), snapshot: z.unknown() }),
      z.looseObject({ kind: z.literal('deltas'), deltas: z.array(z.unknown()) })
    ])
  })
  .loose()
export type ZcodeV4LogicalFrameEnvelope = z.infer<typeof zcodeV4LogicalFrameEnvelopeSchema>

// ── Sessions-index topic (phase 1's read-only live source) ──

export const zcodeV4SessionSummarySchema = z
  .object({
    sessionId: z.string(),
    workspaceId: z.string(),
    parentSessionId: z.string().optional(),
    title: z.string(),
    phase: z.unknown(),
    sessionEnded: z.boolean(),
    hasBackgroundWork: z.boolean(),
    lastActivityAt: zcodeV4TimestampSchema,
    createdAt: zcodeV4TimestampSchema
  })
  .loose()
export type ZcodeV4SessionSummary = z.infer<typeof zcodeV4SessionSummarySchema>

export const zcodeV4SessionsIndexSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    workspaceId: z.string(),
    logEpoch: z.string(),
    sessions: z.array(zcodeV4SessionSummarySchema)
  })
  .loose()
export type ZcodeV4SessionsIndexSnapshot = z.infer<typeof zcodeV4SessionsIndexSnapshotSchema>

export const zcodeV4SessionsIndexDeltaSchema = z.discriminatedUnion('op', [
  z.looseObject({ op: z.literal('session.upserted'), session: zcodeV4SessionSummarySchema }),
  z.looseObject({ op: z.literal('session.removed'), sessionId: z.string() })
])
export type ZcodeV4SessionsIndexDelta = z.infer<typeof zcodeV4SessionsIndexDeltaSchema>

export const zcodeV4SessionsIndexLogicalFrameSchema = zcodeV4LogicalFrameEnvelopeSchema.superRefine(
  (frame, context) => {
    if (!frame.topic.startsWith('sessions-index/')) {
      context.addIssue({ code: 'custom', message: 'invalid sessions-index topic', path: ['topic'] })
    }
  }
)

// ── Commands ──

// ── Attachment upload transaction (begin → chunk* → commit; abort on failure) ──

export const zcodeV4AttachmentRefSchema = z
  .object({ ref: z.string(), fileName: z.string(), mime: z.string(), bytes: z.number() })
  .loose()
export type ZcodeV4AttachmentRef = z.infer<typeof zcodeV4AttachmentRefSchema>

export const ZCODE_V4_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const ZCODE_V4_ATTACHMENT_MAX_CHUNKS = 64

export const zcodeV4AttachmentBeginResultSchema = z.discriminatedUnion('state', [
  z.looseObject({
    state: z.literal('staging'),
    nextChunkIndex: z.number().int().nonnegative(),
    uploadId: z.string()
  }),
  z.looseObject({
    state: z.literal('committed'),
    nextChunkIndex: z.number().int().nonnegative(),
    ref: z.string().min(1),
    uploadId: z.string()
  })
])
export type ZcodeV4AttachmentBeginResult = z.infer<typeof zcodeV4AttachmentBeginResultSchema>

export const zcodeV4AttachmentChunkResultSchema = z
  .object({
    uploadId: z.string().min(1),
    nextChunkIndex: z.number().int().nonnegative()
  })
  .loose()

export const zcodeV4AttachmentCommitResultSchema = z.object({ ref: z.string().min(1) }).loose()
export type ZcodeV4AttachmentCommitResult = z.infer<typeof zcodeV4AttachmentCommitResultSchema>

export const zcodeV4CommandAckSchema = z
  .object({
    commandId: z.string(),
    // accepted commits; duplicate is a replayed cache hit and equally final.
    status: z.enum(['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed']),
    // rejected/stale/noop/failed carry a guard id or fault code.
    reasonCode: z.string().optional(),
    message: z.string().optional(),
    revisionAtDecision: z.number()
  })
  .loose()
export type ZcodeV4CommandAck = z.infer<typeof zcodeV4CommandAckSchema>

export const zcodeV4CommandEnvelopeSchema = z
  .object({
    // uuid v7, client-generated, retry-stable.
    commandId: z.string(),
    clientId: z.string(),
    // null only for createSession.
    sessionId: z.string().nullable(),
    // CAS watermark; required by most commands.
    baseRevision: z.number().optional(),
    type: z.string(),
    payload: z.unknown(),
    issuedAt: zcodeV4TimestampSchema
  })
  .loose()
export type ZcodeV4CommandEnvelope = z.infer<typeof zcodeV4CommandEnvelopeSchema>
