import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'
import type { AiVaultConversationCopy } from '../../shared/ai-vault-resume-preparation'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createZcodeAgentConnection } from './zcode-protocol-connection'
import { zcodeSessionForkResultSchema } from './zcode-protocol-messages'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-adapter'
import type { ZcodeSubagentEvidence } from './zcode-subagent-evidence'

export class ZcodeChildRegistryActions {
  constructor(
    private readonly children: Map<string, ZcodeStructuredChild>,
    private readonly subagentEvidence: Map<string, ZcodeSubagentEvidence>,
    private readonly deps: ZcodeStructuredSessionAdapterDeps
  ) {}

  live(sessionId: string): ZcodeStructuredChild {
    const child = this.children.get(sessionId)
    if (!child || child.ended) {
      throw new Error(`no live zcode child owns ${sessionId}`)
    }
    return child
  }

  async stopBackgroundTasks(
    input: Parameters<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>[0]
  ): Promise<
    Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>>
  > {
    const child = this.children.get(input.sessionId)
    if (!child || child.ended || !child.providerSessionId) {
      return { cancelled: false }
    }
    let cancelled = false
    for (const taskId of input.taskIds) {
      try {
        await (child.v4Channel
          ? child.v4Channel.command('cancelBackgroundWork', { workId: taskId })
          : child.connection.request('session/cancelBackgroundTask', {
              sessionId: child.providerSessionId,
              taskId
            }))
        cancelled = true
        input.acknowledge?.({ taskId })
      } catch (error) {
        this.deps.logger?.warn('zcode background task cancel failed', {
          scope: 'zcode-bg-stop',
          sessionId: input.sessionId,
          taskId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return { cancelled }
  }

  backgroundTaskStops(): AgentSessionBackgroundTaskStops {
    return { supportsTaskStop: true, supportsStopAll: false }
  }

  async copyConversation(
    input: Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
  ): Promise<AiVaultConversationCopy> {
    const providerSessionId = input.providerSessionId.trim()
    if (!providerSessionId) {
      throw new Error('the conversation has no zcode session to copy')
    }
    const live = this.children.get(input.identity.sessionId)
    const connection =
      live && !live.ended ? live.connection : await this.openScratchConnection(input.accountHome)
    try {
      const forked = zcodeSessionForkResultSchema.parse(
        await connection.request('session/fork', {
          sessionId: providerSessionId,
          target: { kind: 'latestCheckpoint' }
        })
      )
      return { sessionId: forked.forkedSessionId }
    } finally {
      if (!live || live.ended) {
        await connection.close().catch(() => undefined)
      }
    }
  }

  holdsDispatch(sessionId: string): boolean {
    const child = this.children.get(sessionId)
    if (!child || child.ended) {
      return false
    }
    return (child.lane?.openTurnId ?? null) !== null || this.hasPendingDispatch(child)
  }

  heldSends(sessionId: string): ReadonlySet<string> | undefined {
    const child = this.children.get(sessionId)
    if (!child || child.ended) {
      return undefined
    }
    const held = new Set<string>()
    const lanePending = child.lane?.translator.pendingPromptId
    if (lanePending) {
      held.add(lanePending)
    }
    const v4Pending = child.v4Channel?.translator.pendingPromptId
    if (v4Pending) {
      held.add(v4Pending)
    }
    return held
  }

  holdsLiveProviderProcess(sessionId: string, generation: string): boolean {
    const child = this.children.get(sessionId)
    return child?.acquisitionGeneration === generation && !child.connection.exited
  }

  acknowledgeSessionRelease(sessionId: string): void {
    const child = this.children.get(sessionId)
    if (child?.ended) {
      this.deleteChild(sessionId)
    }
  }

  async closeAll(): Promise<void> {
    const proven = await Promise.all([...this.children.keys()].map((id) => this.closeChild(id)))
    if (proven.includes(false)) {
      throw new Error('a zcode child could not be proven stopped')
    }
  }

  async closeChild(sessionId: string, force = false): Promise<boolean> {
    const child = this.children.get(sessionId)
    if (!child) {
      return true
    }
    if (!force) {
      child.closeRequested = true
    }
    if (!force && !child.ended && child.providerSessionId) {
      await child.connection
        .request('session/close', { sessionId: child.providerSessionId })
        .catch(() => undefined)
    }
    const stopped = await this.stopChild(child)
    if (stopped && this.children.get(sessionId) === child) {
      this.deleteChild(sessionId)
    }
    return stopped
  }

  async stopRequestedChild(child: ZcodeStructuredChild): Promise<boolean> {
    child.closeRequested = true
    const stopped = await this.stopChild(child)
    if (stopped && this.children.get(child.sessionId) === child) {
      this.deleteChild(child.sessionId)
    }
    return stopped
  }

  async stopChild(child: ZcodeStructuredChild): Promise<boolean> {
    const closed = await child.connection.close().catch(() => false)
    return closed || child.connection.exited
  }

  finishChild(child: ZcodeStructuredChild): void {
    const sessionAlreadyEnded = child.ended
    const at = (this.deps.now ?? Date.now)()
    child.ended = true
    child.exitObservedAt = at
    const failure = new Error(child.connection.stderrTail() || 'zcode exited')
    child.journalClosed ??= failure
    if (child.lane && !sessionAlreadyEnded) {
      child.lane.apply(child.lane.translator.sessionEnded(at))
    }
    child.dispose()
    child.prompts.clear()
    this.subagentEvidence.delete(child.sessionId)
    const requested = child.closeRequested
    this.deps.onEvent?.({
      type: 'ended',
      sessionId: child.sessionId,
      reason: failure.message,
      cause: requested ? 'requested-close' : 'unexpected-exit',
      failure: agentSessionFailureFact(requested ? 'hostStopped' : 'providerExited', {
        detail: providerDiagnosticOf(failure)
      }),
      fence: child.fence,
      acquisitionGeneration: child.acquisitionGeneration,
      observedAt: at
    })
  }

  private hasPendingDispatch(child: ZcodeStructuredChild): boolean {
    return (
      (child.lane?.translator.hasPendingPrompt() ?? false) ||
      (child.v4Channel?.translator.hasPendingPrompt() ?? false)
    )
  }

  private async openScratchConnection(
    accountHome: Parameters<
      NonNullable<StructuredAgentSessionAdapter['copyConversation']>
    >[0]['accountHome']
  ) {
    if (!isLegacyAgentSessionAccountHome(accountHome)) {
      throw new Error('zcode conversation copy needs a directory account home')
    }
    if (!this.deps.resolveInvocation) {
      throw new Error('zcode conversation copy needs a launch resolver')
    }
    const invocation = await this.deps.resolveInvocation(accountHome.path)
    return (this.deps.connect ?? createZcodeAgentConnection)(invocation, {})
  }

  private deleteChild(sessionId: string): void {
    this.children.delete(sessionId)
    this.subagentEvidence.delete(sessionId)
  }
}
