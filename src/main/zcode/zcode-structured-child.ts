// Making a reservation real for a ZCode chat: spawn the app-server, then build its session —
// `session/create` or `session/resume`, then `session/subscribe`. The provider session the record
// proved is reattached on a resume; a fresh session mints a new handle. Traffic before the lane
// exists queues (bounded), and replayed history on a resume is dropped: the journal already holds it.

import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { zcodeSessionEventEnvelopeSchema } from './zcode-protocol-messages'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { ZcodeV4ConversationChannel } from './v4/zcode-v4-conversation-channel'
import { ZcodeV4ConversationTranslator } from './v4/zcode-v4-conversation-projection'
import { ZcodeStructuredLane } from './zcode-structured-lane'
import { ZcodeStructuredPrompts } from './zcode-structured-prompts'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
import { openZcodeSession } from './zcode-structured-child-open'
import { resolveZcodeProviderRuntimeAuth } from './zcode-provider-runtime-auth'
import { localZcodeCredentialHost } from './zcode-v2-plan-credentials'
import type { ZcodeStructuredChild, ZcodeStructuredChildDeps } from './zcode-structured-child-state'
export type { ZcodeStructuredChild, ZcodeStructuredChildDeps } from './zcode-structured-child-state'

/** Frames an agent may send before its session exists; past this they are dropped. */
const MAX_EARLY_FRAMES = 2_048

export async function acquireZcodeStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  launch: ZcodeStructuredLaunch & {
    cwd: string
    env: Record<string, string>
    envToDelete: string[]
  }
  deps: ZcodeStructuredChildDeps
  generation: string
  abandoned: () => boolean
  /** The process's exit, observed while or after the session exists. */
  onExit: (child: ZcodeStructuredChild | null, expected: boolean) => void
  /** The protocol broke with the process perhaps still running. */
  onConnectionLost: (child: ZcodeStructuredChild | null, error: Error) => void
  /** A frame just passed that makes the subagents table worth re-reading: a background
   *  task frame, or the turn ending. Absent: the caller polls some other way. */
  onSubagentsPollDue?: (child: ZcodeStructuredChild) => void
  /** v4 subagent rows translated into child-work evidence; null drops them. */
  onChildWorkEvidence?: (sessionId: string, evidence: AgentChildWorkEvidence[]) => void
  /** Force-closes the child when the journal lane fails for good. */
  forceClose: (sessionId: string) => void
}): Promise<{ acquisition: AgentSessionAcquisition; child: ZcodeStructuredChild }> {
  const { acquire, deps, generation } = input
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const sink = acquire.events ? providerTimelineSink(acquire.events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error('zcode chats need a journal sink'))
  }
  if (input.abandoned()) {
    throw new AgentSessionPreSpawnError(new Error('zcode was closed before it started'))
  }
  const early: (() => void)[] = []
  const slot: {
    child: ZcodeStructuredChild | null
    lane: ZcodeStructuredLane | null
    reattaching: boolean
    v4: ZcodeV4ConversationChannel | null
  } = {
    child: null,
    lane: null,
    reattaching: false,
    v4: null
  }
  const whenLane = (deliver: () => void): void => {
    if (slot.lane) {
      deliver()
    } else if (early.length < MAX_EARLY_FRAMES) {
      early.push(deliver)
    }
  }
  const prompts = new ZcodeStructuredPrompts(
    () => slot.lane,
    () => slot.lane !== null && !slot.child?.ended
  )
  const connection = deps.connect(
    {
      command: input.launch.command,
      args: input.launch.args,
      cwd: input.launch.cwd,
      env: input.launch.env,
      envToDelete: input.launch.envToDelete
    },
    {
      onRequest: (method, params, context) => {
        const lane = slot.lane
        const translation = lane
          ? lane.translator.request(method, params)
          : method === 'session/requestRuntimePreferences'
            ? {
                events: [],
                settled: {
                  reply: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false }
                }
              }
            : { events: [], settled: { error: { code: -32004, message: 'Session unavailable' } } }
        void prompts.handle(translation, context)
      },
      onNotification: (method, params) => {
        if (method === 'v4/conversation/frame') {
          // The v4 channel bypasses the attaching gate: its initial frame is a state seed
          // (never history) and its deltas are strictly post-ACK live traffic.
          whenLane(() => {
            const lane = slot.lane
            const v4 = slot.v4
            if (!lane || !v4) {
              return
            }
            lane.apply(v4.handle(method, params))
            const evidence = v4.drainChildWorkEvidence()
            if (evidence.length > 0) {
              input.onChildWorkEvidence?.(sessionId, evidence)
            }
          })
          return
        }
        if (method !== 'session/event') {
          return
        }
        whenLane(() => {
          const lane = slot.lane
          if (!lane) {
            return
          }
          const envelope = zcodeSessionEventEnvelopeSchema.safeParse(params)
          if (!envelope.success) {
            return
          }
          const translated = slot.reattaching
            ? []
            : lane.translator.sessionEvent(envelope.data, now())
          for (const event of translated) {
            if (event.type === 'request.withdrawn') {
              prompts.settle(event.request)
            }
          }
          lane.apply(translated)
          if (
            input.onSubagentsPollDue &&
            slot.child &&
            (envelope.data.type.startsWith('background_task') ||
              envelope.data.type === 'turn.completed' ||
              envelope.data.type === 'turn.failed')
          ) {
            input.onSubagentsPollDue(slot.child)
          }
        })
      },
      onDiagnostic: (message) =>
        deps.logger?.warn('ZCode agent protocol diagnostic', {
          scope: 'zcode-diagnostic',
          sessionId,
          message
        }),
      onClose: (error) => input.onConnectionLost(slot.child, error),
      onExit: (_error, context) => input.onExit(slot.child, context.expected)
    }
  )
  await connection.spawned
  const pid = connection.pid
  if (pid === undefined) {
    await connection.close().catch(() => false)
    throw new AgentSessionPreSpawnError(
      new Error(connection.stderrTail() || `${input.launch.command} could not be started`)
    )
  }
  let process: AgentSessionProcessIdentity
  try {
    const identity = providerSpawnedProcessIdentity(
      acquire,
      'zcode app-server',
      deps.readProcessStartTime
    )
    await identity.onSpawned(pid)
    process = await identity.read(pid)
  } catch (error) {
    await connection.close().catch(() => false)
    throw error
  }

  const credentialHost = { ...localZcodeCredentialHost(), env: input.launch.env }
  const makeLane = (providerSessionId: string, attaching: boolean): ZcodeStructuredLane => {
    const lane = new ZcodeStructuredLane({
      sink,
      sessionId,
      agent: 'zcode',
      generation,
      providerSessionId,
      logger: neverThrowingStructuredAgentSessionLogger(
        deps.logger ?? createStructuredAgentSessionLogger()
      ),
      now,
      contextWindow: () => slot.child?.contextWindow ?? null,
      resolveProviderRuntimeAuth: (params) =>
        resolveZcodeProviderRuntimeAuth(params, credentialHost),
      onInputAccepted: () => {},
      onFailed: (reason) => {
        deps.logger?.warn('ZCode journal lane failed', { scope: 'zcode-lane', sessionId, reason })
        input.forceClose(sessionId)
      },
      onSessionEnded: (endedAt) => {
        const child = slot.child
        if (child && !child.ended) {
          child.ended = true
          child.exitObservedAt = endedAt
        }
      }
    })
    slot.lane = lane
    slot.reattaching = attaching
    if (attaching) {
      lane.translator.beginLoad()
    }
    for (const deliver of early.splice(0)) {
      deliver()
    }
    return lane
  }
  const child: ZcodeStructuredChild = {
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    connection,
    prompts,
    lane: null,
    resume: input.launch.resume,
    providerSessionId: null,
    currentModel: null,
    currentSelection: null,
    currentEffort: null,
    currentMode: null,
    contextWindow: null,
    modelOptions: null,
    optionRestoreFailures: new Set(),
    slashCommands: null,
    launch: {
      cwd: input.launch.cwd,
      workspaceId: acquire.identity.workspaceId,
      env: input.launch.env,
      ...(acquire.permissionMode ? { permissionMode: acquire.permissionMode } : {})
    },
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    closeRequested: false,
    v4Channel: null,
    open: (input) =>
      openZcodeSession(
        {
          child,
          connection,
          makeLane,
          reattachDone: () => {
            slot.reattaching = false
            // The drop gate is two-layered (this flag plus the translator's loading mark);
            // both close together, so neither can silently stay half-open.
            slot.lane?.translator.finishLoad()
          },
          ...(deps.logger ? { logger: deps.logger } : {}),
          openV4Channel: async (providerSessionId) => {
            const channel = new ZcodeV4ConversationChannel(
              new ZcodeV4ConversationTranslator(
                { now: () => Date.now(), contextWindow: () => slot.child?.contextWindow ?? null },
                providerSessionId
              ),
              connection,
              providerSessionId
            )
            // Install before subscribe: its ACK and initial frame may share one stdout chunk,
            // whose notification dispatch runs before the request promise continuation.
            slot.v4 = channel
            child.v4Channel = channel
            const armed = await channel.arm(providerSessionId)
            if (!armed) {
              if (slot.v4 === channel) {
                slot.v4 = null
              }
              if (child.v4Channel === channel) {
                child.v4Channel = null
              }
              return false
            }
            slot.lane?.apply(channel.drainReadyEvents())
            return true
          }
        },
        input.signal
      ),
    dispose: () => {
      slot.v4?.dispose()
      slot.v4 = null
      child.v4Channel = null
      slot.lane?.dispose()
      early.length = 0
    }
  }
  slot.child = child
  if (connection.exited) {
    throw new AgentSessionAcquisitionExitProvenError(
      new Error(connection.stderrTail() || 'zcode exited while being acquired')
    )
  }
  return {
    acquisition: { process, acquisitionGeneration: generation },
    child
  }
}
