import { BoundedMap } from '../../shared/bounded-map'
import {
  UNVERIFIABLE_TURN_VERDICT,
  type StructuredAgentSessionTurnVerdict
} from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import type { AgentSessionBackgroundTaskRunState } from '../../shared/agent-session-background-task-wire'
import {
  zcodeModelCompleteSchema,
  zcodeModelStreamingSchema,
  zcodePermissionResolvedSchema,
  zcodeStreamRecoverySchema,
  zcodeUserInputResolvedSchema,
  zcodeToolUpdateSchema,
  zcodeBackgroundTaskEventSchema,
  zcodeTurnCompletedSchema,
  type ZcodeSessionEventEnvelope
} from './zcode-protocol-messages'
import { translateZcodeRequest, type ZcodeRequestTranslation } from './zcode-request-translator'
import {
  isZcodeUsageLimitFailure,
  zcodeBackgroundRunState,
  zcodeContextUsageEvent,
  zcodeBackgroundTaskEvent,
  zcodeToolBody,
  zcodeTurnDuration,
  zcodeTurnOutcome,
  zcodeUsageTokensOf,
  type ZcodeUsageTokens
} from './zcode-timeline-event-values'

export type { ZcodeRequestTranslation } from './zcode-request-translator'

export class ZcodeTimelineTranslator {
  private readonly endedTurns = new BoundedMap<string, true>({ maxEntries: 128 })
  private readonly openTurns = new Set<string>()
  private pending?: { clientMessageId: string; requestedAt: number }
  private loading = false
  /** The model stream stalled and recovery re-requests are running; the activity line shows it. */
  private recovering = false
  private readonly backgroundTasks = new Map<
    string,
    { state: AgentSessionBackgroundTaskRunState }
  >()

  constructor(
    private readonly providerSessionId: string,
    /** The window the current model runs in, as the session knows it; null until reported. */
    private readonly contextWindow?: () => number | null,
    private readonly resolveProviderRuntimeAuth?: (params: unknown) => unknown
  ) {}

  /** A resume's replayed history is already in the journal; its frames are dropped. */
  beginLoad(): void {
    this.loading = true
  }

  finishLoad(): void {
    this.loading = false
  }

  get providerTurnId(): string | null {
    return this.openTurns.values().next().value ?? null
  }

  /** Orca's send is on the wire; the provider's `turn.started` names the turn it opened. */
  openPrompt(clientMessageId: string, requestedAt: number): void {
    this.pending = { clientMessageId, requestedAt }
  }

  /** Forgets a send the provider refused before any turn began. */
  dropPrompt(): void {
    this.pending = undefined
  }

  /** Orca's send is on the wire but the provider has not opened its turn yet. */
  hasPendingPrompt(): boolean {
    return this.pending !== undefined
  }

  /** The in-flight send's id, for the host's held-send accounting; null with none. */
  get pendingPromptId(): string | null {
    return this.pending?.clientMessageId ?? null
  }

  sessionEvent(envelope: ZcodeSessionEventEnvelope, at: number): ProviderTimelineEvent[] {
    if (this.loading) {
      return []
    }
    const turn = envelope.turnId
    switch (envelope.type) {
      case 'turn.started': {
        if (turn === undefined || this.openTurns.has(turn)) {
          return []
        }
        this.openTurns.add(turn)
        const prompt = this.pending
        if (prompt) {
          this.pending = undefined
          return [
            { type: 'turn.open', turn, at },
            {
              type: 'input.accepted',
              clientMessageId: prompt.clientMessageId,
              requestedAt: prompt.requestedAt,
              join: { thread: this.providerSessionId, turn }
            }
          ]
        }
        return [{ type: 'turn.open', turn, at }]
      }
      case 'turn.completed':
      case 'turn.failed': {
        if (turn === undefined || this.endedTurns.has(turn)) {
          return []
        }
        this.endedTurns.set(turn, true)
        this.openTurns.delete(turn)
        const completed =
          envelope.type === 'turn.completed'
            ? zcodeTurnCompletedSchema.parse(envelope.payload)
            : null
        const tokens = completed?.usage === undefined ? null : zcodeUsageTokensOf(completed.usage)
        const usageEvents = tokens ? [this.contextUsageEvent(tokens, at)] : []
        const end: ProviderTimelineEvent = {
          type: 'turn.end',
          turn,
          at,
          state: 'completed',
          ...(envelope.type === 'turn.failed'
            ? { outcome: 'failure' as const }
            : zcodeTurnOutcome(completed?.resultType)),
          ...(completed ? zcodeTurnDuration(completed.duration) : {})
        }
        const recoveryEvents: ProviderTimelineEvent[] = this.recovering
          ? [{ type: 'activity', text: null }]
          : []
        this.recovering = false
        // A GLM usage limit reads like any other failure on the wire; naming it here is what
        // lets the row say "limit" instead of a bare provider sentence.
        const limitFailure =
          envelope.type === 'turn.failed' ? isZcodeUsageLimitFailure(envelope.payload) : null
        const limitEvents: ProviderTimelineEvent[] =
          limitFailure && turn !== undefined
            ? [
                {
                  type: 'item.open',
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
        return [...usageEvents, ...limitEvents, end, ...recoveryEvents]
      }
      case 'background_task_started':
      case 'background_task_updated':
      case 'background_task_completed': {
        const task = zcodeBackgroundTaskEventSchema.parse(envelope.payload)
        const state: AgentSessionBackgroundTaskRunState =
          envelope.type === 'background_task_started'
            ? 'working'
            : envelope.type === 'background_task_updated'
              ? (this.backgroundTasks.get(task.taskId)?.state ?? 'working')
              : zcodeBackgroundRunState(task.status)
        return this.backgroundTaskEvent(task, state, turn)
      }
      case 'model.streaming': {
        const stream = zcodeModelStreamingSchema.parse(envelope.payload)
        // Why: the mapper also exposes tool_input_* fragments for input previews; channeling
        // those into a text item streams raw JSON into the assistant prose while it streams.
        if (stream.kind !== 'text_delta' && !stream.kind.startsWith('reasoning')) {
          return []
        }
        if (typeof stream.delta !== 'string' || stream.delta.length === 0) {
          return []
        }
        const channel = stream.kind.startsWith('reasoning') ? 'reasoning' : 'assistant'
        const recoveringEvents: ProviderTimelineEvent[] = this.recovering
          ? [{ type: 'activity', text: null }]
          : []
        this.recovering = false
        const id = stream.assistantMessageId ?? stream.partId
        return [
          ...recoveringEvents,
          {
            type: 'text.delta',
            item: id ? { id: `message:${JSON.stringify([id, channel])}` } : { stream: stream.kind },
            channel,
            text: stream.delta,
            join: { thread: this.providerSessionId, ...(turn ? { turn } : {}) }
          }
        ]
      }
      case 'tool.updated': {
        if (turn === undefined) {
          return []
        }
        const update = zcodeToolUpdateSchema.parse(envelope.payload)
        if (!update.toolCallId) {
          return []
        }
        const item = `tool:${JSON.stringify(update.toolCallId)}`
        const join = { thread: this.providerSessionId, turn }
        if (update.kind === 'result') {
          return [{ type: 'item.close', item, body: zcodeToolBody(update, 'completed'), join }]
        }
        if (update.kind === 'error') {
          return [{ type: 'item.close', item, body: zcodeToolBody(update, 'failed'), join }]
        }
        return [{ type: 'item.update', item, body: zcodeToolBody(update, 'running'), join }]
      }
      case 'session.updated': {
        // The mapper default-buckets every internal event into session.updated. Background-task
        // frames only ride it on the reference runtime (the closed one sends dedicated types),
        // and ModelComplete steps carry the live token accounting.
        const task = zcodeBackgroundTaskEventSchema.safeParse(envelope.payload)
        if (task.success) {
          return this.backgroundTaskEvent(
            task.data,
            zcodeBackgroundRunState(task.data.status),
            turn
          )
        }
        // Non-main-turn steps are subagents whose usage must not drive the main meter.
        const parsed = zcodeModelCompleteSchema.safeParse(envelope.payload)
        if (!parsed.success || parsed.data.querySource !== 'main_turn') {
          return []
        }
        const tokens = zcodeUsageTokensOf(parsed.data.usage)
        if (!tokens) {
          return []
        }
        return [
          this.contextUsageEvent(
            tokens,
            at,
            typeof parsed.data.contextWindow === 'number' ? parsed.data.contextWindow : undefined
          )
        ]
      }
      case 'streamRecovery.updated': {
        const recovery = zcodeStreamRecoverySchema.parse(envelope.payload)
        const attempt =
          typeof recovery.retryNumber === 'number' ? String(recovery.retryNumber) : '?'
        const budget = typeof recovery.maxRetries === 'number' ? `/${recovery.maxRetries}` : ''
        const reason = recovery.message ? `: ${recovery.message}` : ''
        this.recovering = true
        return [
          {
            type: 'activity',
            text: `Model stream interrupted — re-requesting (retry ${attempt}${budget})${reason}`
          }
        ]
      }
      case 'permission.resolved':
      case 'userInput.resolved': {
        const permission = envelope.type === 'permission.resolved'
        const resolved = (
          permission ? zcodePermissionResolvedSchema : zcodeUserInputResolvedSchema
        ).parse(envelope.payload)
        if (!resolved.requestId) {
          return []
        }
        const method = permission ? 'interaction/requestPermission' : 'interaction/requestUserInput'
        return [
          { type: 'request.withdrawn', request: `${method}:${JSON.stringify(resolved.requestId)}` }
        ]
      }
      default:
        // message.upserted lacks an id, so emitting it would duplicate streamed text; recovered
        // text carried there remains unavailable until the protocol exposes a deduplication key.
        return []
    }
  }

  private backgroundTaskEvent(
    task: ReturnType<typeof zcodeBackgroundTaskEventSchema.parse>,
    state: AgentSessionBackgroundTaskRunState,
    turn: string | undefined
  ): ProviderTimelineEvent[] {
    this.backgroundTasks.set(task.taskId, { state })
    return zcodeBackgroundTaskEvent(this.providerSessionId, task, state, turn)
  }

  /** The task ids a stop may name, running ones first. */
  runningBackgroundTaskIds(): string[] {
    return [...this.backgroundTasks.entries()]
      .filter(([, task]) => task.state === 'working')
      .map(([taskId]) => taskId)
  }

  /** The provider session is gone: everything still open settles as unverifiable. */
  sessionEnded(at: number): ProviderTimelineEvent[] {
    const events: ProviderTimelineEvent[] = []
    for (const turn of this.openTurns) {
      this.endedTurns.set(turn, true)
      events.push({ type: 'turn.end', turn, at, state: 'completed', outcome: 'failure' })
    }
    this.openTurns.clear()
    this.pending = undefined
    const verdict: StructuredAgentSessionTurnVerdict = UNVERIFIABLE_TURN_VERDICT
    events.push({ type: 'session.ended', verdict, endedAt: at })
    return events
  }

  /** The context size a session snapshot reported, so a resumed chat's meter is not blank
   *  until its next turn completes. The total is the context; the split is unknown. */
  contextUsageSeedEvent(usedTokens: number, at: number): ProviderTimelineEvent {
    return this.contextUsageEvent({ input: usedTokens, output: 0, cacheRead: 0, cacheWrite: 0 }, at)
  }

  /** The turn's provider-reported token accounting; the window is what the session knows. */
  private contextUsageEvent(
    tokens: ZcodeUsageTokens,
    at: number,
    windowOverride?: number
  ): ProviderTimelineEvent {
    const window = windowOverride ?? this.contextWindow?.() ?? null
    return zcodeContextUsageEvent(this.providerSessionId, tokens, at, window)
  }

  request(method: string, params: unknown): ZcodeRequestTranslation {
    return translateZcodeRequest(
      this.providerSessionId,
      method,
      params,
      this.resolveProviderRuntimeAuth
    )
  }
}
