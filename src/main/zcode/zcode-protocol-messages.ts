// The subset of the ZCode Protocol (`zcode app-server --stdio`) an Orca client speaks.
//
// Shapes follow the reference implementation in the ZCode repo (packages/shared/src/zcode-protocol).
// Every read is lenient: the server validates its own side strictly, and a client that rejects an
// otherwise usable frame over an unknown extra field turns a compatible server into a broken one.

import { z } from 'zod'

/** One stdout line: a request, a notification, or a reply to one of ours. */
export const zcodeProtocolFrameSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional()
})

export type ZcodeProtocolFrame = z.infer<typeof zcodeProtocolFrameSchema>

const workspaceSchema = z.looseObject({
  workspacePath: z.string(),
  workspaceKey: z.string(),
  workspaceIdentity: z.string().optional()
})

export type ZcodeWorkspace = z.infer<typeof workspaceSchema>

export const zcodeSlashCommandSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputHint: z.string().optional()
})

/** `session/create` result: the protocol identity plus the whole session snapshot. */
export const zcodeSessionSnapshotSchema = z.looseObject({
  protocol: z.looseObject({ name: z.string(), version: z.number() }),
  session: z.looseObject({ sessionId: z.string() }),
  settings: z
    .looseObject({
      model: z
        .looseObject({
          current: z.unknown().nullable().optional(),
          available: z.array(z.unknown()).optional()
        })
        .optional(),
      mode: z.looseObject({ current: z.string().optional() }).optional()
    })
    .optional(),
  slashCommands: z.array(zcodeSlashCommandSchema).optional()
})

export type ZcodeSessionSnapshot = z.infer<typeof zcodeSessionSnapshotSchema>

export const zcodeSessionSendResultSchema = z.looseObject({
  sessionId: z.string(),
  accepted: z.boolean(),
  stateRevision: z.number().optional()
})

export type ZcodeSessionSendResult = z.infer<typeof zcodeSessionSendResultSchema>

/** `session/compact`: the RPC answers with the compaction's own summary and refreshed snapshot. */
export const zcodeSessionCompactResultSchema = z.looseObject({
  response: z.string(),
  compact: z
    .looseObject({
      state: z.enum(['accepted', 'already_running']).optional(),
      inputId: z.string().optional(),
      operationId: z.string().optional()
    })
    .optional()
})

/** `session/fork {target: {kind:'turn', turnIndex}}`: a persisted child carrying history up to and
 *  including that turn — the primitive a fork-based rewind continues in. */
export const zcodeSessionForkResultSchema = z.looseObject({
  forkedSessionId: z.string(),
  parentSessionId: z.string().optional(),
  targetMessageId: z.string().optional(),
  response: z.string().optional(),
  snapshot: z
    .looseObject({
      projection: z.looseObject({ turnCount: z.number().int().nonnegative().optional() }).optional()
    })
    .optional()
})

/** `session/subscribe` result: the replay through `eventSeq`, then live `session/event` frames. */
export const zcodeSessionSubscribeResultSchema = z.looseObject({
  sessionId: z.string(),
  eventSeq: z.number(),
  events: z.array(z.unknown()).default([]),
  snapshot: z.unknown().optional()
})

/** Storage startup progress, pushed until the session store is usable; writes hold until `ready`. */
export const zcodeStorageStateSchema = z.looseObject({
  phase: z.enum(['checking', 'waiting_for_lock', 'migrating', 'committing', 'ready', 'failed']),
  error: z.string().optional()
})

export const zcodeSessionEventEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  type: z.string(),
  turnId: z.string().optional(),
  payload: z.unknown()
})

export type ZcodeSessionEventEnvelope = z.infer<typeof zcodeSessionEventEnvelopeSchema>

/** `model.streaming`: provider text/thinking deltas, keyed by the message or part that holds them. */
export const zcodeModelStreamingSchema = z.looseObject({
  kind: z.string(),
  delta: z.string().optional(),
  assistantMessageId: z.string().optional(),
  partId: z.string().optional()
})

/** `tool.updated`: one tool call's whole current state per frame. The closed runtime carries
 *  output as `output`; the reference mapper carries it as `result.content` / `error.message`. */
export const zcodeToolUpdateSchema = z.looseObject({
  kind: z.enum(['scheduled', 'started', 'progress', 'result', 'error', 'batch', 'raw']),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  result: z.looseObject({ content: z.unknown().optional() }).optional(),
  error: z.looseObject({ message: z.string().optional() }).optional()
})

/** `session/subagents`: one child session the runtime reports. Statuses terminal on arrival:
 *  success/failed/cancelled/lost; running/waiting/blocked are still live. */
export const zcodeSessionSubagentSchema = z.looseObject({
  childSessionId: z.string(),
  subagentType: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  status: z
    .enum(['running', 'waiting', 'blocked', 'success', 'failed', 'cancelled', 'lost'])
    .optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional()
})

export const zcodeSessionSubagentsResultSchema = z.looseObject({
  running: z.array(zcodeSessionSubagentSchema).optional(),
  ended: z.looseObject({ items: z.array(zcodeSessionSubagentSchema).optional() }).optional()
})

/** `turn.failed`: the reference error payload carries `attribution` with the provider status
 *  code and business error code a GLM usage-limit failure is told apart by. */
export const zcodeTurnFailedSchema = z.looseObject({
  error: z
    .looseObject({
      type: z.string().optional(),
      message: z.string().optional(),
      attribution: z
        .looseObject({
          statusCode: z.number().optional(),
          providerErrorCode: z.union([z.string(), z.number()]).optional()
        })
        .optional()
    })
    .optional(),
  turnPhase: z.string().optional()
})

/** The context totals a session snapshot reports, so a resumed chat's meter is not blank
 *  until its next turn completes: `runtime.contextUsage` on the reference runtime. */
export const zcodeContextSeedSchema = z.looseObject({
  runtime: z
    .looseObject({
      contextUsage: z
        .looseObject({ used: z.number().optional(), size: z.number().optional() })
        .optional()
    })
    .optional(),
  projection: z
    .looseObject({ contextUsed: z.number().optional(), contextWindow: z.number().optional() })
    .optional()
})

/** `workspace/readPresentation`: the `/` surface without opening a session. */
export const zcodeWorkspacePresentationSchema = z.looseObject({
  slashCommands: z.array(zcodeSlashCommandSchema).optional()
})

export const zcodeTurnCompletedSchema = z.looseObject({
  resultType: z.string().optional(),
  duration: z.number().optional(),
  usage: z.unknown().optional()
})

/** A `session.updated` frame carrying a `model_complete` step payload: the per-model-step token
 *  accounting the desktop-continuous stream delivers between turn start and end. */
export const zcodeModelCompleteSchema = z.looseObject({
  usage: z.unknown().optional(),
  contextWindow: z.number().optional(),
  querySource: z.string().optional(),
  stopReason: z.string().optional()
})

/** Server→client `interaction/requestPermission`, re-announced with the same `requestId`. The
 *  wire options carry a required user-facing `name`; `label` is the closed runtime's variant. */
export const zcodePermissionRequestSchema = z.looseObject({
  requestId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  reason: z.string().optional(),
  riskLevel: z.string().optional(),
  input: z.unknown().optional(),
  options: z
    .array(
      z.looseObject({
        optionId: z.string(),
        kind: z.string(),
        name: z.string().optional(),
        label: z.string().optional(),
        response: z.looseObject({ decision: z.string() })
      })
    )
    .default([])
})

/** The `permission.resolved` mirror: the server settled a request itself (timeout auto-deny). */
export const zcodePermissionResolvedSchema = z.looseObject({
  requestId: z.string().optional(),
  decision: z.string().optional()
})

export const zcodeUserInputResolvedSchema = z.looseObject({
  requestId: z.string().optional(),
  value: z.unknown().optional(),
  cancelled: z.boolean().optional()
})

/** `streamRecovery.updated`: the SSE stream stalled and the runtime is re-requesting it. */
export const zcodeStreamRecoverySchema = z.looseObject({
  retryNumber: z.number().optional(),
  maxRetries: z.number().optional(),
  message: z.string().optional()
})

/** The graceful refusal the `interaction/requestProviderRuntimeHeaders` contract reserves:
 *  `{headersApplied: false}` degrades instead of failing the model request. */
export const ZCODE_PROVIDER_RUNTIME_HEADERS_REPLY = {
  headersApplied: false,
  errorMessage: 'Orca does not provide provider runtime headers'
} as const

export const ZCODE_OFFICIAL_MCP_AUTH_HEADERS_REPLY = {
  ok: false,
  reason: 'official_auth_unavailable'
} as const

export type ZcodePermissionRequest = z.infer<typeof zcodePermissionRequestSchema>

/** The answer the server expects for a permission it asked about. */
export const zcodePermissionResponseSchema = z.looseObject({
  decision: z.string(),
  reason: z.string().optional()
})

/** `session.updated` frames of the background_task_* kinds: one task's whole state. */
export const zcodeBackgroundTaskEventSchema = z.looseObject({
  taskId: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  taskKind: z.enum(['bash', 'subagent', 'workflow']).optional(),
  status: z
    .enum(['running', 'completed', 'failed', 'timed_out', 'cancelled', 'spawn_error', 'lost'])
    .optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  outputTail: z.string().optional()
})

export type ZcodeBackgroundTaskEvent = z.infer<typeof zcodeBackgroundTaskEventSchema>

/** Server→client `interaction/requestUserInput` (AskUserQuestion, plan approval). Option `value`
 *  defaults to the label — the reference server maps labels into values itself. */
export const zcodeUserInputRequestSchema = z.looseObject({
  requestId: z.string(),
  sessionId: z.string(),
  toolName: z.string().optional(),
  prompt: z.string().optional(),
  questions: z
    .array(
      z.looseObject({
        question: z.string(),
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.looseObject({
              label: z.string(),
              value: z.string().optional(),
              description: z.string().optional()
            })
          )
          .default([])
      })
    )
    .default([])
})

export type ZcodeUserInputRequest = z.infer<typeof zcodeUserInputRequestSchema>

/** The answer the server expects for a question it asked: accept carries the picked answers
 *  keyed by question text (the shape `normalizeAskUserQuestionResponseContent` converges). */
export const zcodeUserInputResponseSchema = z.looseObject({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional()
})

/** Server→client `session/requestRuntimePreferences`; the fixture client answers the same minimal shape. */
export const zcodeRuntimePreferencesRequestSchema = z.looseObject({
  sessionId: z.string()
})

export const ZCODE_RUNTIME_PREFERENCES_REPLY = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false
} as const
