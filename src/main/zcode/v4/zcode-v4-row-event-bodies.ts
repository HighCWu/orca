import { journalToolPayload } from '../../native-chat/agent-session-journal/journal-payload-bounds'
import { backgroundTaskJournalBody } from '../../../shared/native-chat/input/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../shared/native-chat-types'
import type { AgentSessionBackgroundTaskRunState } from '../../../shared/agent-session-background-task-wire'
import type { ZcodeV4BackgroundWork, ZcodeV4ConversationRow } from './zcode-v4-conversation-frames'

type ToolState = 'running' | 'completed' | 'failed'

export function zcodeV4ToolBody(row: ZcodeV4ConversationRow, state: ToolState) {
  const output = typeof row.output === 'string' ? row.output : null
  const failureReason = state === 'failed' ? (row.error?.message ?? null) : null
  return {
    kind: 'tool-call' as const,
    name: row.toolName ?? 'tool',
    input: row.input ?? null,
    ...(row.toolCallId ? { callId: row.toolCallId } : {}),
    state,
    ...(state === 'completed' && output !== null
      ? { output: journalToolPayload(output, false) }
      : {}),
    ...(failureReason !== null ? { output: journalToolPayload(failureReason, false) } : {})
  }
}

export function zcodeV4BackgroundBody(
  work: ZcodeV4BackgroundWork,
  state: AgentSessionBackgroundTaskRunState
) {
  return backgroundTaskJournalBody(backgroundBlock(work, state))
}

export function zcodeV4BackgroundState(status: string): AgentSessionBackgroundTaskRunState {
  return status === 'failed' || status === 'cancelled' ? 'done' : 'working'
}

export function zcodeV4TerminalTurnOutcome(state: string | undefined) {
  if (state === 'completedSuccess') {
    return { outcome: 'success' as const }
  }
  if (state === 'completedInterrupted') {
    return { outcome: 'cancellation' as const }
  }
  if (state === 'failed') {
    return { outcome: 'failure' as const }
  }
  return {}
}

function backgroundBlock(
  work: ZcodeV4BackgroundWork,
  state: AgentSessionBackgroundTaskRunState
): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId: work.workId,
    kind:
      work.kind === 'bash'
        ? 'command'
        : work.kind === 'subagent'
          ? 'agent'
          : work.kind === 'workflow'
            ? 'workflow'
            : 'unknown',
    label: work.title,
    state
  }
}
