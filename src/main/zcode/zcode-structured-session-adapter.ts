// A structured chat over the ZCode Protocol: one adapter for the `zcode` agent, which the router
// drives like the Codex and ACP lanes. Stop ends only the turn; the child stays for the next send,
// and a resume reattaches the provider session the record proved.

import { randomUUID } from 'node:crypto'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionPromptCancelRoute } from '../native-chat/agent-session-wire/structured-agent-session-adapter-stop'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { createZcodeAgentConnection } from './zcode-protocol-connection'
import type { ZcodeSubagentEvidence } from './zcode-subagent-evidence'
import { pollZcodeSubagents, zcodeSlashCommands } from './zcode-session-queries'
import { acquireZcodeStructuredSession, type ZcodeStructuredChild } from './zcode-structured-child'
import { isJournalRewindSource } from './zcode-structured-rewind'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-deps'
import { ZcodeChildRegistryActions } from './zcode-child-registry-actions'
import {
  awaitZcodeStoppedRequestEnd,
  cancelZcodeTurn,
  changeZcodeGoal,
  compactZcodeSession
} from './zcode-structured-commands'
import { dispatchZcodeMessage, rejectedZcodeDispatch } from './zcode-structured-dispatch'
import { forkZcodeForRewind } from './zcode-structured-rewind-fork'
import {
  applyZcodeExecutionOptions,
  composeZcodeLiveOptions,
  readZcodeLiveSnapshot,
  setZcodeOption
} from './zcode-structured-options'

export { zcodeGoalActionOf } from './zcode-structured-commands'
export type {
  ZcodeDispatchSettlement,
  ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-deps'

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly subagentEvidence = new Map<string, ZcodeSubagentEvidence>()
  private readonly children = new Map<string, ZcodeStructuredChild>()
  private readonly childActions: ZcodeChildRegistryActions

  constructor(
    private readonly deps: ZcodeStructuredSessionAdapterDeps,
    readonly atRestCommands = deps.atRestCommands
  ) {
    this.childActions = new ZcodeChildRegistryActions(
      this.children,
      this.subagentEvidence,
      this.deps
    )
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const existing = this.children.get(sessionId)
    if (existing) {
      // The old process must be proven gone before a second one spawns into the same journal,
      // including a child whose provider session ended before its app-server exited.
      if (!(await this.childActions.stopRequestedChild(existing))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error(`the previous zcode child for ${sessionId} could not be stopped`)
        )
      }
    }
    const generation = randomUUID()
    let launch
    try {
      launch = await this.deps.resolveLaunch({
        identity: input.identity,
        spawnToken: input.spawnToken,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
      })
    } catch (error) {
      throw new AgentSessionPreSpawnError(error, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
    try {
      const { acquisition, child } = await acquireZcodeStructuredSession({
        acquire: input,
        launch,
        deps: {
          connect: this.deps.connect ?? createZcodeAgentConnection,
          ...(this.deps.readProcessStartTime
            ? { readProcessStartTime: this.deps.readProcessStartTime }
            : {}),
          ...(this.deps.logger ? { logger: this.deps.logger } : {}),
          ...(this.deps.now ? { now: this.deps.now } : {})
        },
        generation,
        abandoned: () => input.signal?.aborted === true,
        onExit: (child, expected) => {
          if (child) {
            child.closeRequested ||= expected
            this.childActions.finishChild(child)
          }
        },
        onConnectionLost: (child, error) => {
          if (child) {
            child.journalClosed ??= error
            // Children still live can no longer end on their own; the host settles them.
            this.deps.onChildWorkEvidence?.(child.sessionId, [
              { type: 'session-ended', observedAt: this.deps.now?.() ?? Date.now() }
            ])
          }
        },
        onSubagentsPollDue: (child) => this.pollSubagents(child),
        onChildWorkEvidence: (sessionId, evidence) =>
          this.deps.onChildWorkEvidence?.(sessionId, evidence),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      this.children.set(sessionId, child)
      return acquisition
    } catch (error) {
      this.children.delete(sessionId)
      if (
        isAgentSessionPreSpawnError(error) ||
        error instanceof AgentSessionAcquisitionExitProvenError ||
        error instanceof AgentSessionAcquisitionExitUnprovenError
      ) {
        throw error
      }
      throw new AgentSessionPreSpawnError(error, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private pollSubagents(child: ZcodeStructuredChild): void {
    pollZcodeSubagents({
      child,
      trackers: this.subagentEvidence,
      now: this.now,
      ...(this.deps.onChildWorkEvidence ? { publish: this.deps.onChildWorkEvidence } : {})
    })
  }

  open: NonNullable<StructuredAgentSessionAdapter['open']> = async (input) => {
    const child = this.children.get(input.sessionId)
    if (
      !child ||
      child.fence !== input.fence ||
      child.acquisitionGeneration !== input.acquisitionGeneration ||
      child.ended
    ) {
      throw new Error('zcode child changed before it opened')
    }
    return child.open(input)
  }

  async dispatch(input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0]) {
    const child = this.childActions.live(input.sessionId)
    if (this.children.get(input.sessionId) !== child || child.journalClosed !== null) {
      return rejectedZcodeDispatch()
    }
    return dispatchZcodeMessage({
      child,
      dispatch: input,
      now: this.now,
      applyExecutionOptions: applyZcodeExecutionOptions
    })
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) =>
    compactZcodeSession({
      child: this.childActions.live(input.sessionId),
      command: input.command,
      now: this.now
    })

  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = (input) =>
    changeZcodeGoal(this.childActions.live(input.sessionId), input)

  cancelTurn: NonNullable<StructuredAgentSessionAdapter['cancelTurn']> = (input) =>
    cancelZcodeTurn({ child: this.children.get(input.sessionId), turnId: input.turnId })

  stopEndsSession = (): boolean => false

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (sessionId) =>
    isJournalRewindSource(this.deps.readJournal, sessionId)
      ? { supported: true }
      : { supported: false, reason: 'invalid-target' }

  awaitStoppedRequestEnd = (sessionId: string): Promise<void> =>
    awaitZcodeStoppedRequestEnd(this.children.get(sessionId))

  answerPrompt: NonNullable<StructuredAgentSessionAdapter['answerPrompt']> = async (input) => {
    const child = this.childActions.live(input.sessionId)
    await child.prompts.answer({
      itemId: input.itemId,
      response: input.response,
      commit: input.commit
    })
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    return setZcodeOption(this.childActions.live(input.sessionId), input)
  }

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const child = this.childActions.live(input.sessionId)
    return composeZcodeLiveOptions(child, await readZcodeLiveSnapshot(child))
  }

  prepareReadOptions: NonNullable<StructuredAgentSessionAdapter['prepareReadOptions']> = ({
    sessionId
  }) => {
    const child = this.children.get(sessionId)
    if (!child || child.ended) {
      return undefined
    }
    const fetched = readZcodeLiveSnapshot(child)
    return fetched.then((snapshot) => () => composeZcodeLiveOptions(child, snapshot))
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    Array.from(this.children.get(sessionId)?.optionRestoreFailures ?? [])

  readCommands = (sessionId: string) => zcodeSlashCommands(this.children.get(sessionId))

  forkForRewind: NonNullable<StructuredAgentSessionAdapter['forkForRewind']> = (input) =>
    forkZcodeForRewind({ rewind: input, children: this.children, deps: this.deps })

  // A pending card's own Cancel dismisses it: the provider hears a cancelled answer and the turn
  // keeps running — only the chat's Stop cancels turns here.
  routePromptCancel = (): AgentSessionPromptCancelRoute => ({ kind: 'dismiss' })

  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = async (input) => {
    const child = this.childActions.live(input.sessionId)
    if (input.answer) {
      await child.prompts.dismiss(input.itemId, input.commit)
    }
    // A refusal to answer commits nothing: the card stays, and the Stop that ends the child
    // withdraws it.
  }

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => this.childActions.stopBackgroundTasks(input)

  backgroundTaskStops = (): AgentSessionBackgroundTaskStops =>
    this.childActions.backgroundTaskStops()

  copyConversation: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = (input) =>
    this.childActions.copyConversation(input)

  holdsDispatch = (sessionId: string): boolean => this.childActions.holdsDispatch(sessionId)

  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    this.childActions.heldSends(sessionId)

  holdsLiveProviderProcess = (sessionId: string, generation: string): boolean =>
    this.childActions.holdsLiveProviderProcess(sessionId, generation)

  acknowledgeSessionRelease = (sessionId: string): void =>
    this.childActions.acknowledgeSessionRelease(sessionId)

  hasOwnedAcquisition = (sessionId: string): boolean => this.children.has(sessionId)

  closeSession = (sessionId: string): Promise<boolean> => this.childActions.closeChild(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.childActions.closeChild(sessionId)
  releaseAcquisition = (input: { sessionId: string }) =>
    this.childActions.closeChild(input.sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.childActions.closeChild(sessionId, true)

  closeAll = (): Promise<void> => this.childActions.closeAll()

  private readonly now = (): number => (this.deps.now ?? Date.now)()
}
