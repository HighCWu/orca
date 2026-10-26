// One ZCode child's path into the journal: the translator turns its traffic into grammar events,
// and the shared assembler writes them. Events apply strictly in order; one the sink refuses under
// backpressure holds every later one until the sink drains, so nothing is reordered or dropped.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

const BACKPRESSURE_RETRY_MS = 250

export type ZcodeStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  generation: string
  providerSessionId: string
  /** The window the session's current model runs in, as the open snapshot reported. */
  contextWindow?: () => number | null
  resolveProviderRuntimeAuth?: (params: unknown) => unknown
  logger: StructuredAgentSessionLogger
  /** A send of Orca's reached the agent: the turn it opened has its first provider event. */
  onInputAccepted: (clientMessageId: string) => void
  /** The sink refused for good; nothing more this child says can be journaled. */
  onFailed: (reason: string) => void
  /** The journal wrote this child's end; the adapter reconciles its session from it. */
  onSessionEnded?: (endedAt: number) => void
  now?: () => number
}
export class ZcodeStructuredLane {
  readonly translator: ZcodeTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: ProviderTimelineEvent[] = []
  private readonly turnWatchers = new Set<() => void>()
  private readonly requestIdentity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private ended = false
  private disposed = false
  private readonly logger: StructuredAgentSessionLogger

  constructor(private readonly deps: ZcodeStructuredLaneDeps) {
    this.logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
    this.translator = new ZcodeTimelineTranslator(
      deps.providerSessionId,
      deps.contextWindow,
      deps.resolveProviderRuntimeAuth
    )
    this.requestIdentity = createLegacyProviderTimelineIdentityScheme({
      agent: deps.agent,
      sessionId: deps.sessionId
    })
    this.assembler = createProviderTimelineAssembler({
      sink: deps.sink,
      sessionId: deps.sessionId,
      agent: deps.agent,
      generation: deps.generation,
      namespace: deps.providerSessionId
    })
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    if (this.failed || this.disposed || this.backlog.length > 0) {
      throw new Error('ZCode timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly ProviderTimelineEvent[]): void {
    if (this.failed || this.disposed) {
      return
    }
    this.backlog.push(...events)
    this.drain()
  }

  /** Resolves once `turnId` is no longer the open turn, or nothing more can be written. */
  whenTurnLeaves(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.failed || this.disposed || this.openTurnId !== turnId) {
          this.turnWatchers.delete(check)
          resolve()
        }
      }
      this.turnWatchers.add(check)
      check()
    })
  }

  /** The sink drained: whatever it held back goes now. */
  retry(): void {
    this.drain()
  }

  /** Whether the journal row `itemId` is the row of request `requestKey`. */
  isRequestRow(itemId: string, requestKey: string): boolean {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'legacy' || identity.sessionId !== this.deps.sessionId) {
      return false
    }
    const first = this.requestIdentity.request({
      generation: this.deps.generation,
      key: requestKey,
      incarnation: 1
    })
    const prefix = first.provider === 'legacy' ? first.recordId : null
    return identity.recordId === prefix || identity.recordId.startsWith(`${prefix}#`)
  }

  flush(): void {
    this.assembler.flush()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearRetry()
    this.backlog.length = 0
    this.assembler.dispose()
    this.notifyTurnWatchers()
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]
      const { admission, dropped } = this.assembler.apply(
        event,
        event.type === 'session.ended' ? () => this.publishSessionEnd() : undefined
      )
      if (!admission.accepted) {
        this.refused(admission.reason)
        return
      }
      this.backlog.shift()
      this.ended ||= event.type === 'session.ended' && dropped === undefined
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
    this.notifyTurnWatchers()
  }

  private publishSessionEnd(): void {
    this.deps.onSessionEnded?.(this.deps.now?.() ?? Date.now())
  }

  private refused(reason: string): void {
    if (reason === 'backpressure') {
      this.retryTimer = setTimeout(() => this.drain(), BACKPRESSURE_RETRY_MS)
      return
    }
    this.logger.warn('ZCode journal lane refused an event', {
      scope: 'zcode-lane-refused',
      sessionId: this.deps.sessionId,
      reason
    })
    this.failed = true
    this.backlog.length = 0
    this.notifyTurnWatchers()
    this.deps.onFailed(reason)
  }

  private notifyTurnWatchers(): void {
    for (const check of this.turnWatchers) {
      check()
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
