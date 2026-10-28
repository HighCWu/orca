// A zcode child's protocol construction: `session/create` or `session/resume`, then
// `session/subscribe`, then the facts the open contract reports (handle link, model table,
// thought level, `/` surface). Replayed history on a resume is dropped — the journal holds it.

import {
  configuredModelIdOf,
  contextWindowOf,
  currentEffortOf,
  currentZcodeSessionMode,
  zcodeCatalogSnapshotSchema,
  zcodeModelOptionsOf,
  zcodeReportedPermissionMode,
  type ZcodeSessionMode
} from './zcode-session-snapshot-facts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { syncZcodeAccountConfig } from './zcode-account-config-sync'
import { zcodeContextSeedSchema } from './zcode-protocol-messages'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { ZcodeStructuredLane } from './zcode-structured-lane'
import { ZCODE_STRUCTURED_HANDLE_NAMESPACE } from './zcode-structured-agent-definition'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export type ZcodeSessionOpenContext = {
  child: ZcodeStructuredChild
  connection: ZcodeAgentConnection
  /** Arms the journal lane once the provider session is known; attaching drops replayed frames. */
  makeLane: (providerSessionId: string, attaching: boolean) => ZcodeStructuredLane
  reattachDone: () => void
  /** Arms the v4 conversation channel instead of the legacy subscription. Absent, or
   *  answering false (an app-server predating v4, or the channel disabled), keeps the
   *  legacy `session/subscribe` path. The armer installs the channel on the child itself. */
  openV4Channel?: (providerSessionId: string) => Promise<boolean>
  logger?: StructuredAgentSessionLogger
}

/** Explicit Orca choices override the session; own leaves ZCode's current/default mode intact. */
export function zcodeSessionMode(permissionMode: string | undefined): ZcodeSessionMode | undefined {
  if (permissionMode === 'full-access') {
    return 'yolo'
  }
  if (permissionMode === 'ask') {
    return 'build'
  }
  return undefined
}

/** The CLI's `-32004` for a session id it holds no row for: a deferred chat that never sent
 *  is in exactly this state after a CLI restart. */
function isZcodeSessionMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('-32004') &&
    error.message.includes('Session not found')
  )
}

/** Builds the child's `open`: build the session, arm the subscription, report the facts. */
export function buildZcodeChildOpen(
  context: ZcodeSessionOpenContext
): (signal: AbortSignal) => Promise<StructuredAgentSessionProviderOpenResult> {
  return (signal) => openZcodeSession(context, signal)
}

/** Runs the child's protocol construction and reports its open facts. */
export async function openZcodeSession(
  context: ZcodeSessionOpenContext,
  signal: AbortSignal
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { child, connection } = context
  // The desktop host pushes the Account Config before any session exists; without it the
  // CLI Registry has no GLM Coding Plan provider and every new session resolves onto the
  // CLI's factory default. Failure degrades to the factory default, never blocks the open.
  try {
    await syncZcodeAccountConfig(connection, child.launch.env)
  } catch (error) {
    context.logger?.warn('zcode account config push failed; using the CLI default', {
      scope: 'zcode-open',
      sessionId: child.sessionId,
      message: error instanceof Error ? error.message : String(error)
    })
  }
  const workspace = {
    workspacePath: child.launch.cwd,
    workspaceKey: child.launch.workspaceId
  }
  const createSession = () =>
    connection.request('session/create', {
      // The desktop host reserves `session_`-prefixed ids for the sessions it creates;
      // reserving one here keeps Orca's sessions in the same id space (the CLI's own
      // `sess_` fallback is the legacy shape the desktop no longer mints).
      sessionId: `session_${randomUUID()}`,
      workspace,
      // Deferred: the CLI promotes it to immediate on the first send, whose own write
      // lands the session row. An immediate create leaves that row lazily unflushed, and
      // the first v4 sendText dies on the input queue's session foreign key.
      persistence: 'deferred',
      titleGenerationEnabled: false,
      ...(zcodeSessionMode(child.launch.permissionMode)
        ? { mode: zcodeSessionMode(child.launch.permissionMode) }
        : {})
    })
  let snapshot: unknown
  let resumedSession = child.resume !== null
  if (child.resume) {
    try {
      snapshot = await connection.request(
        'session/resume',
        { sessionId: child.resume.sessionId, workspace },
        undefined
      )
    } catch (error) {
      // A deferred chat that never sent holds no provider row, and it is gone after a CLI
      // restart; its journal is empty, so the open continues on a fresh draft.
      if (!isZcodeSessionMissing(error)) {
        throw error
      }
      resumedSession = false
      context.logger?.warn('zcode resume missed a never-sent session; opening a fresh draft', {
        scope: 'zcode-open',
        sessionId: child.sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
      snapshot = await createSession()
    }
  } else {
    snapshot = await createSession()
  }
  const read = zcodeCatalogSnapshotSchema.parse(snapshot)
  const providerSessionId = read.session.sessionId
  const targetMode = zcodeSessionMode(child.launch.permissionMode)
  const observedMode = currentZcodeSessionMode(read)
  let currentMode = observedMode ?? targetMode ?? null
  if (resumedSession && targetMode && observedMode && observedMode !== targetMode) {
    const modeSnapshot = zcodeCatalogSnapshotSchema.parse(
      await connection.request('session/setMode', {
        sessionId: providerSessionId,
        mode: targetMode
      })
    )
    currentMode = currentZcodeSessionMode(modeSnapshot) ?? targetMode
  }
  child.providerSessionId = providerSessionId
  child.currentModel = configuredModelIdOf(read) ?? null
  // The v4 switchModelConfig command speaks in whole selections; the v3 wire only needs
  // the model id, so the provider half is carried for the channel's sake.
  const selection = z
    .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
    .loose()
    .safeParse(read.settings?.model?.current)
  child.currentSelection = selection.success ? selection.data : null
  child.currentEffort = currentEffortOf(read)
  child.currentMode = currentMode
  child.contextWindow = contextWindowOf(read)
  child.modelOptions = zcodeModelOptionsOf(read)
  child.slashCommands = read.slashCommands ?? []
  const lane = context.makeLane(providerSessionId, resumedSession)
  // The v4 conversation channel, when armed, replaces the legacy subscription: the frame
  // stream carries the usage seed itself, so the v3 seed below is skipped to avoid doubles.
  if (context.openV4Channel && (await context.openV4Channel(providerSessionId))) {
    // The armer installed the channel on the child; commands and frames both ride it now.
    context.reattachDone()
  } else {
    await connection.request('session/subscribe', {
      sessionId: providerSessionId,
      deliveryKind: 'desktop-continuous'
    })
    // Replayed history is already in the journal; the subscription only arms live delivery.
    context.reattachDone()
    // Why: the snapshot already knows how much context the resumed conversation carries — seeding
    // it here keeps the meter honest until the next turn reports its own accounting.
    const seed = zcodeContextSeedSchema.safeParse(snapshot)
    const runtimeUsage = seed.success ? seed.data.runtime?.contextUsage : undefined
    const usedTokens =
      runtimeUsage?.used ?? (seed.success ? seed.data.projection?.contextUsed : undefined)
    if (typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens > 0) {
      const events: ProviderTimelineEvent[] = [
        lane.translator.contextUsageSeedEvent(usedTokens, Date.now())
      ]
      lane.apply(events)
    }
  }
  if (signal.aborted) {
    throw new Error('zcode was closed while starting')
  }
  const link: AgentSessionProviderHandleLink = {
    linkId: `${child.sessionId}-${child.fence}-${providerSessionId}`.slice(0, 128),
    handle: { ...ZCODE_STRUCTURED_HANDLE_NAMESPACE, nativeId: providerSessionId },
    origin: resumedSession ? 'resumed' : 'created',
    mintedAtFence: child.fence,
    observedAt: Date.now()
  }
  return {
    link,
    reportedOptions: {
      ...(child.currentModel ? { model: child.currentModel } : {}),
      ...(child.currentEffort ? { effort: child.currentEffort } : {}),
      reportedPermissionMode: zcodeReportedPermissionMode(child.currentMode)
    }
  }
}
