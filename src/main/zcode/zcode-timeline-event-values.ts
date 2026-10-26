import { z } from 'zod'
import type { AgentSessionBackgroundTaskRunState } from '../../shared/agent-session-background-task-wire'
import { ZCODE_RATE_LIMIT_CODES } from '../../shared/agent-session-failure'
import { backgroundTaskJournalBody } from '../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../shared/native-chat-types'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { journalToolPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { zcodeTurnFailedSchema } from './zcode-protocol-messages'
import type {
  zcodeBackgroundTaskEventSchema,
  zcodeToolUpdateSchema
} from './zcode-protocol-messages'

const zcodeUsageTokensSchema = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  input: z.number().optional(),
  output: z.number().optional(),
  cache: z.looseObject({ read: z.number().optional(), write: z.number().optional() }).optional()
})

export type ZcodeUsageTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function zcodeToolBody(
  update: ReturnType<typeof zcodeToolUpdateSchema.parse>,
  state: 'running' | 'completed' | 'failed'
) {
  const output =
    typeof update.output === 'string'
      ? update.output
      : typeof update.result?.content === 'string'
        ? update.result.content
        : null
  const failureReason =
    state === 'failed' && typeof update.error?.message === 'string' ? update.error.message : null
  return {
    kind: 'tool-call' as const,
    name: update.toolName ?? 'tool',
    input: update.input ?? null,
    ...(update.toolCallId ? { callId: update.toolCallId } : {}),
    state,
    ...(state === 'completed' && output !== null
      ? { output: journalToolPayload(output, false) }
      : {}),
    ...(failureReason !== null ? { output: journalToolPayload(failureReason, false) } : {})
  }
}

export function zcodeContextUsageEvent(
  providerSessionId: string,
  tokens: ZcodeUsageTokens,
  at: number,
  window: number | null
): ProviderTimelineEvent {
  return {
    type: 'context.usage',
    usage: {
      ...(window !== null ? { window: { tokens: window, capturedAt: at } } : {}),
      used: {
        kind: 'estimate',
        capturedAt: at,
        usage: {
          inputTokens: tokens.input,
          cacheCreationInputTokens: tokens.cacheWrite,
          cacheReadInputTokens: tokens.cacheRead,
          outputTokens: tokens.output
        }
      }
    },
    join: { thread: providerSessionId }
  }
}

export function zcodeUsageTokensOf(usage: unknown): ZcodeUsageTokens | null {
  const parsed = zcodeUsageTokensSchema.safeParse(usage)
  if (!parsed.success) {
    return null
  }
  const input = parsed.data.inputTokens ?? parsed.data.input
  const output = parsed.data.outputTokens ?? parsed.data.output
  if (typeof input !== 'number' || typeof output !== 'number') {
    return null
  }
  return {
    input,
    output,
    cacheRead: parsed.data.cacheReadTokens ?? parsed.data.cache?.read ?? 0,
    cacheWrite: parsed.data.cacheWriteTokens ?? parsed.data.cache?.write ?? 0
  }
}

export function isZcodeUsageLimitFailure(payload: unknown): boolean {
  const parsed = zcodeTurnFailedSchema.safeParse(payload)
  const error = parsed.success ? parsed.data.error : undefined
  if (!error) {
    return false
  }
  const code = error.attribution?.providerErrorCode
  return (
    error.type === 'model_rate_limited' ||
    error.attribution?.statusCode === 429 ||
    (code !== undefined && ZCODE_RATE_LIMIT_CODES.has(String(code)))
  )
}

export function zcodeBackgroundRunState(
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
    | 'spawn_error'
    | 'lost'
    | undefined
): AgentSessionBackgroundTaskRunState {
  switch (status) {
    case 'running':
    case undefined:
      return 'working'
    case 'lost':
      return 'unverifiable'
    case 'completed':
    case 'failed':
    case 'timed_out':
    case 'cancelled':
    case 'spawn_error':
      return 'done'
  }
}

export function zcodeBackgroundTaskEvent(
  providerSessionId: string,
  task: z.infer<typeof zcodeBackgroundTaskEventSchema>,
  state: AgentSessionBackgroundTaskRunState,
  turn: string | undefined
): ProviderTimelineEvent[] {
  const block: NativeChatBackgroundTaskBlock = {
    type: 'background-task',
    taskId: task.taskId,
    kind: zcodeBackgroundTaskKind(task.taskKind),
    label: task.description ?? task.command ?? task.taskId,
    state,
    ...(task.toolCallId ? { parentToolUseId: task.toolCallId } : {}),
    ...(task.outputTail ? { summary: task.outputTail } : {})
  }
  return [
    {
      type: 'item.update',
      item: `background-task:${task.taskId}`,
      body: backgroundTaskJournalBody(block),
      join: { thread: providerSessionId, ...(turn ? { turn } : {}) }
    }
  ]
}

export function zcodeBackgroundTaskKind(
  kind: 'bash' | 'subagent' | 'workflow' | undefined
): NativeChatBackgroundTaskBlock['kind'] {
  switch (kind) {
    case 'subagent':
      return 'agent'
    case 'workflow':
      return 'workflow'
    case 'bash':
      return 'command'
    case undefined:
      return 'unknown'
  }
}

export function zcodeTurnOutcome(
  resultType: string | undefined
): { outcome: 'success' | 'failure' | 'cancellation' } | Record<string, never> {
  if (resultType === 'success') {
    return { outcome: 'success' }
  }
  if (resultType === 'cancelled') {
    return { outcome: 'cancellation' }
  }
  if (resultType?.startsWith('error')) {
    return { outcome: 'failure' }
  }
  return {}
}

export function zcodeTurnDuration(duration: number | undefined): { durationMs?: number } {
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
    ? { durationMs: duration }
    : {}
}
