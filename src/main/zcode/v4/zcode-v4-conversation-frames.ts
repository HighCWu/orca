// Conversation-topic frames: the row-based projection ZCode's v4 gateway pushes for a
// subscribed session. Ported as a loose subset from the CLI's
// `@zcode/shared/zcode-protocol-v4` (rows/delta/snapshot): fields Orca's journal grammar
// needs are typed, everything else stays loose so an additive CLI change cannot fail a
// parse. Delta ops are a closed set — any structural change the row model cannot express
// ships as a snapshot resync instead.

import { z } from 'zod'
import { zcodeV4TimestampSchema } from './zcode-v4-protocol-messages'

// ── Rows ──

const rowBaseSchema = z
  .object({
    rowId: z.number(),
    turnId: z.string(),
    entityId: z.string().min(1).optional(),
    createdAt: zcodeV4TimestampSchema
  })
  .loose()

export const zcodeV4TurnStateSchema = z.enum([
  'running',
  'completedSuccess',
  'completedInterrupted',
  'failed'
])
export type ZcodeV4TurnState = z.infer<typeof zcodeV4TurnStateSchema>

export const zcodeV4ConversationRowSchema = z
  .object({
    ...rowBaseSchema.shape,
    kind: z.string(),
    // turnHeader
    state: z.string().optional(),
    startedAt: zcodeV4TimestampSchema.optional(),
    endedAt: zcodeV4TimestampSchema.optional(),
    activeMs: z.number().optional(),
    outputTokens: z.number().optional(),
    // userInput
    text: z.string().optional(),
    sourceCommandId: z.string().optional(),
    origin: z.string().optional(),
    // assistantText / reasoning
    model: z.string().optional(),
    // toolCall
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
    // subagent
    subagentType: z.string().optional(),
    childSessionId: z.string().optional(),
    summaryText: z.string().optional(),
    parentToolCallId: z.string().optional()
  })
  .loose()
export type ZcodeV4ConversationRow = z.infer<typeof zcodeV4ConversationRowSchema>

// ── State patch (the keys Orca reads) ──

const streamablePathSchema = z.string()

export const zcodeV4SessionControlSchema = z
  .object({
    phase: z.string(),
    sessionEnded: z.boolean(),
    canStop: z.boolean(),
    apiRetry: z
      .looseObject({ attempt: z.number().optional(), maxAttempts: z.number().optional() })
      .nullable()
      .optional(),
    lastError: z
      .looseObject({
        code: z.string(),
        message: z.string(),
        source: z.string().optional(),
        attribution: z.looseObject({
          statusCode: z.number().optional(),
          providerErrorCode: z.string().optional()
        })
      })
      .nullable()
      .optional()
  })
  .loose()
export type ZcodeV4SessionControl = z.infer<typeof zcodeV4SessionControlSchema>

export const zcodeV4UsageStateSchema = z
  .object({
    contextWindow: z
      .looseObject({ usedTokens: z.number(), maxTokens: z.number() })
      .nullable()
      .optional(),
    cumulative: z
      .looseObject({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number()
      })
      .optional()
  })
  .loose()
export type ZcodeV4UsageState = z.infer<typeof zcodeV4UsageStateSchema>

export const zcodeV4BackgroundWorkSchema = z
  .object({
    workId: z.string(),
    kind: z.string(),
    title: z.string(),
    status: z.string(),
    endedAt: zcodeV4TimestampSchema.optional()
  })
  .loose()
export type ZcodeV4BackgroundWork = z.infer<typeof zcodeV4BackgroundWorkSchema>

export const zcodeV4StatePatchSchema = z
  .object({
    revision: z.number().optional(),
    control: zcodeV4SessionControlSchema.optional(),
    usage: zcodeV4UsageStateSchema.optional(),
    backgroundWorks: z.array(zcodeV4BackgroundWorkSchema).optional()
  })
  .loose()
export type ZcodeV4StatePatch = z.infer<typeof zcodeV4StatePatchSchema>

// ── Deltas ──

const projectedConversationDeltaSchema = z.discriminatedUnion('op', [
  z.looseObject({ op: z.literal('row.appended'), row: zcodeV4ConversationRowSchema }),
  z.looseObject({ op: z.literal('row.upserted'), row: zcodeV4ConversationRowSchema }),
  z.looseObject({ op: z.literal('row.removed'), fromRowId: z.number() }),
  z.looseObject({
    op: z.literal('row.delta'),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string()
  }),
  z.looseObject({ op: z.literal('state.updated'), patch: zcodeV4StatePatchSchema })
])

const ignoredConversationDeltaSchema = z.looseObject({
  op: z.enum([
    'pluginUi.resourceUpdated',
    'pluginUi.resourceListChanged',
    'pluginUi.instanceClosed',
    'pluginUi.appToolCall',
    'workflowRun.updated',
    'workflowRun.removed'
  ])
})

export const zcodeV4ConversationDeltaSchema = z.union([
  projectedConversationDeltaSchema,
  ignoredConversationDeltaSchema
])
export type ZcodeV4ConversationDelta = z.infer<typeof zcodeV4ConversationDeltaSchema>

// The real CLI frames a snapshot's rows as a window ({window, totalCount, firstRowId}); a
// plain array stays accepted for the fixtures and any earlier wire that shipped one.
const zcodeV4SnapshotRowsSchema = z.union([
  z.array(zcodeV4ConversationRowSchema),
  z.looseObject({ window: z.array(zcodeV4ConversationRowSchema) }).transform((rows) => rows.window)
])

export const zcodeV4ConversationSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionId: z.string(),
    logEpoch: z.string(),
    seq: z.number(),
    revision: z.number().optional(),
    control: zcodeV4SessionControlSchema.optional(),
    usage: zcodeV4UsageStateSchema.optional(),
    rows: zcodeV4SnapshotRowsSchema
  })
  .loose()
export type ZcodeV4ConversationSnapshot = z.infer<typeof zcodeV4ConversationSnapshotSchema>

export const zcodeV4ConversationSnapshotPayloadSchema = z
  .object({ kind: z.literal('snapshot'), snapshot: zcodeV4ConversationSnapshotSchema })
  .loose()
export const zcodeV4ConversationDeltasPayloadSchema = z
  .object({ kind: z.literal('deltas'), deltas: z.array(zcodeV4ConversationDeltaSchema) })
  .loose()

export const zcodeV4ConversationLogicalFrameSchema = z
  .object({
    topic: z.string(),
    subscriptionId: z.string(),
    fromSeq: z.number(),
    toSeq: z.number(),
    sentAt: zcodeV4TimestampSchema,
    payload: z.discriminatedUnion('kind', [
      zcodeV4ConversationSnapshotPayloadSchema,
      zcodeV4ConversationDeltasPayloadSchema
    ])
  })
  .loose()
  .superRefine((frame, context) => {
    if (!frame.topic.startsWith('conversation/')) {
      context.addIssue({ code: 'custom', message: 'invalid conversation topic', path: ['topic'] })
    }
  })
export type ZcodeV4ConversationLogicalFrame = z.infer<typeof zcodeV4ConversationLogicalFrameSchema>
