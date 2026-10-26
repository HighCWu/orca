import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  zcodeV4BackgroundBody,
  zcodeV4BackgroundState,
  zcodeV4TerminalTurnOutcome,
  zcodeV4ToolBody
} from './zcode-v4-row-event-bodies'
import {
  agentSessionFailureFact,
  ZCODE_RATE_LIMIT_CODES
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import { BoundedMap } from '../../../shared/bounded-map'
import type {
  ZcodeV4BackgroundWork,
  ZcodeV4ConversationRow,
  ZcodeV4UsageState
} from './zcode-v4-conversation-frames'

type LastError = {
  code: string
  message: string
  source?: string
  attribution?: { statusCode?: number; providerErrorCode?: string }
} | null

export class ZcodeV4RowEvents {
  private readonly openTurns = new Set<string>()
  private readonly endedTurns = new BoundedMap<string, true>({ maxEntries: 128 })
  private readonly emittedTextLength = new Map<number, number>()
  private readonly backgroundWorks = new Map<string, string>()
  private readonly toolStatuses = new Map<number, string>()
  private readonly subagentEdgeStatus = new Map<number, string>()
  private readonly subagentEvidence: AgentChildWorkEvidence[] = []
  private lastError: LastError = null

  constructor(private readonly providerSessionId: string) {}

  resetForSnapshot(): void {
    this.openTurns.clear()
    this.endedTurns.clear()
    this.emittedTextLength.clear()
    this.backgroundWorks.clear()
    this.toolStatuses.clear()
    this.subagentEdgeStatus.clear()
    this.subagentEvidence.length = 0
    this.lastError = null
  }

  seedSnapshotRow(row: ZcodeV4ConversationRow): void {
    if (row.kind === 'assistantText' || row.kind === 'reasoning') {
      this.emittedTextLength.set(row.rowId, row.text?.length ?? 0)
      return
    }
    if (row.kind === 'toolCall') {
      this.toolStatuses.set(row.rowId, row.status ?? '')
      return
    }
    if (row.kind === 'subagent') {
      this.subagentEdgeStatus.set(row.rowId, row.status ?? 'running')
      return
    }
    if (row.kind !== 'turnHeader' || !row.turnId) {
      return
    }
    if (row.state === 'running') {
      this.openTurns.add(row.turnId)
    } else {
      this.endedTurns.set(row.turnId, true)
    }
  }

  removeRowsFrom(fromRowId: number): void {
    for (const rowId of this.emittedTextLength.keys()) {
      if (rowId >= fromRowId) {
        this.emittedTextLength.delete(rowId)
      }
    }
    for (const rowId of this.toolStatuses.keys()) {
      if (rowId >= fromRowId) {
        this.toolStatuses.delete(rowId)
      }
    }
    for (const rowId of this.subagentEdgeStatus.keys()) {
      if (rowId >= fromRowId) {
        this.subagentEdgeStatus.delete(rowId)
      }
    }
  }

  setLastError(error: LastError): void {
    this.lastError = error
  }

  textDelta(row: ZcodeV4ConversationRow, text: string): ProviderTimelineEvent {
    return {
      type: 'text.delta',
      item: { id: `v4row:${row.rowId}` },
      channel: row.kind === 'reasoning' ? 'reasoning' : 'assistant',
      text,
      join: { thread: this.providerSessionId, ...(row.turnId ? { turn: row.turnId } : {}) }
    }
  }

  unemittedSuffix(row: ZcodeV4ConversationRow): string {
    const text = row.text ?? ''
    const emitted = this.emittedTextLength.get(row.rowId) ?? 0
    if (text.length <= emitted) {
      return ''
    }
    this.emittedTextLength.set(row.rowId, text.length)
    return text.slice(emitted)
  }

  noteTextDelta(rowId: number, length: number): void {
    this.emittedTextLength.set(rowId, (this.emittedTextLength.get(rowId) ?? 0) + length)
  }

  translateTurnHeader(row: ZcodeV4ConversationRow, at: number): ProviderTimelineEvent[] {
    const turn = row.turnId
    if (!turn) {
      return []
    }
    if (row.state === 'running') {
      if (this.openTurns.has(turn) || this.endedTurns.has(turn)) {
        return []
      }
      this.openTurns.add(turn)
      return [{ type: 'turn.open', turn, at: row.startedAt ?? at }]
    }
    if (this.endedTurns.has(turn)) {
      return []
    }
    this.openTurns.delete(turn)
    this.endedTurns.set(turn, true)
    const outcome = zcodeV4TerminalTurnOutcome(row.state)
    const limitItem =
      row.state === 'failed' && this.isUsageLimitError()
        ? [
            {
              type: 'item.open' as const,
              item: `terminal-failure:zcode:${JSON.stringify([this.providerSessionId, turn])}`,
              body: {
                kind: 'status' as const,
                ...agentSessionFailureWords(agentSessionFailureFact('usageLimitReached'), {
                  surface: 'row',
                  agentName: TUI_AGENT_DISPLAY_NAMES.zcode
                }),
                tone: 'error' as const
              },
              join: { thread: this.providerSessionId, turn }
            }
          ]
        : []
    return [
      ...limitItem,
      {
        type: 'turn.end',
        turn,
        at: row.endedAt ?? at,
        state: 'completed',
        ...outcome,
        ...(typeof row.activeMs === 'number' && row.activeMs >= 0
          ? { durationMs: row.activeMs }
          : {})
      }
    ]
  }

  translateToolCall(row: ZcodeV4ConversationRow): ProviderTimelineEvent[] {
    const status = row.status ?? ''
    if (this.toolStatuses.get(row.rowId) === status) {
      return []
    }
    this.toolStatuses.set(row.rowId, status)
    const item = `tool:${JSON.stringify(row.toolCallId ?? String(row.rowId))}`
    const join = { thread: this.providerSessionId, ...(row.turnId ? { turn: row.turnId } : {}) }
    if (
      row.status === 'inputStreaming' ||
      row.status === 'pendingApproval' ||
      row.status === 'running'
    ) {
      return [{ type: 'item.open', item, body: zcodeV4ToolBody(row, 'running'), join }]
    }
    if (row.status === 'success') {
      return [{ type: 'item.close', item, body: zcodeV4ToolBody(row, 'completed'), join }]
    }
    if (row.status === 'error' || row.status === 'cancelled') {
      const failedRow =
        row.status === 'cancelled'
          ? { ...row, error: row.error ?? { code: 'cancelled', message: 'cancelled' } }
          : row
      return [{ type: 'item.close', item, body: zcodeV4ToolBody(failedRow, 'failed'), join }]
    }
    return []
  }

  backgroundWorkEvents(works: ZcodeV4BackgroundWork[]): ProviderTimelineEvent[] {
    const events: ProviderTimelineEvent[] = []
    const seen = new Set<string>()
    for (const work of works) {
      seen.add(work.workId)
      const previous = this.backgroundWorks.get(work.workId)
      this.backgroundWorks.set(work.workId, work.status)
      if (previous === work.status) {
        continue
      }
      const state = zcodeV4BackgroundState(work.status)
      events.push({
        type: state === 'done' ? 'item.close' : 'item.open',
        item: `background-task:${work.workId}`,
        body: zcodeV4BackgroundBody(work, state),
        join: { thread: this.providerSessionId }
      })
    }
    for (const [workId, status] of this.backgroundWorks) {
      if (!seen.has(workId) && status !== 'settled') {
        this.backgroundWorks.set(workId, 'settled')
        events.push({
          type: 'item.close',
          item: `background-task:${workId}`,
          body: zcodeV4BackgroundBody(
            { workId, kind: 'bash', title: workId, status: 'cancelled' },
            'unverifiable'
          ),
          join: { thread: this.providerSessionId }
        })
      }
    }
    return events
  }

  usageEvent(usage: ZcodeV4UsageState, at: number): ProviderTimelineEvent {
    const window = usage.contextWindow
    const cumulative = usage.cumulative
    return {
      type: 'context.usage',
      usage: {
        ...(window ? { window: { tokens: window.maxTokens, capturedAt: at } } : {}),
        used: {
          kind: 'estimate',
          capturedAt: at,
          usage: {
            inputTokens: cumulative?.inputTokens ?? 0,
            cacheCreationInputTokens: cumulative?.cacheWriteTokens ?? 0,
            cacheReadInputTokens: cumulative?.cacheReadTokens ?? 0,
            outputTokens: cumulative?.outputTokens ?? 0
          }
        }
      }
    }
  }

  collectSubagentEvidence(row: ZcodeV4ConversationRow, at: number): void {
    if (!row.childSessionId) {
      return
    }
    const status = row.status ?? 'running'
    if (this.subagentEdgeStatus.get(row.rowId) === status) {
      return
    }
    this.subagentEdgeStatus.set(row.rowId, status)
    const handle = { idKind: 'thread_id' as const, id: row.childSessionId }
    if (status === 'success' || status === 'failed' || status === 'cancelled') {
      this.subagentEvidence.push({
        type: 'ended',
        observedAt: at,
        handle,
        outcome:
          status === 'success' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
        ...(row.summaryText ? { lastMessage: row.summaryText } : {})
      })
      return
    }
    this.subagentEvidence.push({
      type: 'live',
      observedAt: at,
      child: {
        handle,
        kind: 'agent',
        residency: 'background',
        state: status === 'running' ? 'working' : 'blocked',
        ...(row.subagentType ? { name: row.subagentType } : {}),
        ...(row.summaryText ? { description: row.summaryText } : {}),
        stoppable: false
      }
    })
  }

  drainChildWorkEvidence(): AgentChildWorkEvidence[] {
    return this.subagentEvidence.splice(0)
  }

  private isUsageLimitError(): boolean {
    const error = this.lastError
    if (!error || (error.source !== undefined && error.source !== 'provider')) {
      return false
    }
    const code = error.attribution?.providerErrorCode
    return (
      error.code === 'model_rate_limited' ||
      error.attribution?.statusCode === 429 ||
      (code !== undefined && ZCODE_RATE_LIMIT_CODES.has(String(code)))
    )
  }
}
