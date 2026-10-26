import type { z } from 'zod'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../shared/agent-session-rewind'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { createZcodeAgentConnection, type ZcodeAgentConnection } from './zcode-protocol-connection'
import { zcodeSessionForkResultSchema } from './zcode-protocol-messages'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import { countKeptTurns, zcodeRewindTurnIndex } from './zcode-structured-rewind'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-adapter'

export type ZcodeRewindResult =
  | { ok: true; fork: AgentSessionRewindFork }
  | { ok: false; reason: 'invalid-target' | 'provider-refused' | 'unsupported' }

type RewindInput = {
  record: {
    sessionId: string
    providerHandleChain: Parameters<typeof agentSessionProviderHandleChainHead>[0]
    accountHome: Parameters<typeof requireLegacyAgentSessionAccountHome>[0]
    launchDirectory?: string | null
    location: { workspaceId: string }
  }
  beforeMessage: { uuid: string }
}

export async function forkZcodeForRewind(input: {
  rewind: RewindInput
  children: Map<string, ZcodeStructuredChild>
  deps: Pick<
    ZcodeStructuredSessionAdapterDeps,
    'readJournal' | 'resolveInvocation' | 'connect' | 'logger'
  >
}): Promise<ZcodeRewindResult> {
  const { rewind, children, deps } = input
  const head = agentSessionProviderHandleChainHead(rewind.record.providerHandleChain)?.handle
  if (!head) {
    return { ok: false, reason: 'invalid-target' }
  }
  const turnIndex = zcodeRewindTurnIndex(
    countKeptTurns(deps.readJournal, rewind.record.sessionId, rewind.beforeMessage.uuid)
  )
  if (turnIndex === null) {
    return { ok: false, reason: 'invalid-target' }
  }
  const live = children.get(rewind.record.sessionId)
  const v4 = live && !live.ended ? live.v4Channel : null
  if (v4) {
    let target = v4.translator.forkTargetBeforeTurn(rewind.beforeMessage.uuid)
    if (!target) {
      const snapshotRows = v4.translator.snapshotRows()
      const firstRowId = snapshotRows[0]?.rowId
      if (firstRowId !== undefined) {
        const olderRows = await v4.rowsBefore(firstRowId).catch(() => [])
        target = v4.translator.forkTargetBeforeTurn(rewind.beforeMessage.uuid, [
          ...olderRows,
          ...snapshotRows
        ])
      }
    }
    if (!target) {
      return { ok: false, reason: 'invalid-target' }
    }
    try {
      const ack = await v4.command('forkAssistant', { target }, { cas: true, rowTarget: true })
      const result = ack.result
      const forkedSessionId =
        result &&
        typeof result === 'object' &&
        'sessionId' in result &&
        typeof result.sessionId === 'string'
          ? result.sessionId
          : null
      if (!forkedSessionId) {
        return { ok: false, reason: 'provider-refused' }
      }
      return {
        ok: true,
        fork: {
          sessionId: forkedSessionId,
          sourceSessionId: head.nativeId,
          throughEntryId: target.entityId,
          replacesSessionId: head.nativeId,
          materialized: true
        }
      }
    } catch (error) {
      warnForkFailure(deps.logger, 'zcode v4 rewind fork failed', error)
      return { ok: false, reason: 'provider-refused' }
    }
  }
  const connection = live && !live.ended ? live.connection : undefined
  if (connection) {
    return forkOnZcodeConnection(connection, head, turnIndex, deps.logger)
  }
  if (!deps.resolveInvocation || !rewind.record.launchDirectory) {
    return { ok: false, reason: 'unsupported' }
  }
  const workspacePath = rewind.record.launchDirectory
  const invocation = await deps.resolveInvocation(
    requireLegacyAgentSessionAccountHome(rewind.record.accountHome).path
  )
  const scratch = (deps.connect ?? createZcodeAgentConnection)(
    {
      command: invocation.command,
      args: invocation.args,
      cwd: workspacePath,
      env: invocation.env,
      envToDelete: invocation.envToDelete
    },
    {}
  )
  try {
    await scratch.request('session/resume', {
      sessionId: head.nativeId,
      workspace: {
        workspacePath,
        workspaceKey: rewind.record.location.workspaceId
      }
    })
    return await forkOnZcodeConnection(scratch, head, turnIndex, deps.logger)
  } finally {
    await scratch.close().catch(() => undefined)
  }
}

async function forkOnZcodeConnection(
  connection: ZcodeAgentConnection,
  head: AgentSessionProviderHandle,
  turnIndex: number,
  logger: StructuredAgentSessionLogger | undefined
): Promise<Exclude<ZcodeRewindResult, { ok: false; reason: 'unsupported' }>> {
  let forked: z.infer<typeof zcodeSessionForkResultSchema>
  try {
    forked = zcodeSessionForkResultSchema.parse(
      await connection.request('session/fork', {
        sessionId: head.nativeId,
        target: { kind: 'turn', turnIndex }
      })
    )
  } catch (error) {
    warnForkFailure(logger, 'zcode rewind fork failed', error)
    return { ok: false, reason: 'provider-refused' }
  }
  const keptTurns = forked.snapshot?.projection?.turnCount
  if (keptTurns !== undefined && keptTurns !== turnIndex) {
    await connection
      .request('session/close', { sessionId: forked.forkedSessionId })
      .catch(() => undefined)
    return { ok: false, reason: 'invalid-target' }
  }
  return {
    ok: true,
    fork: {
      sessionId: forked.forkedSessionId,
      sourceSessionId: head.nativeId,
      ...(forked.targetMessageId ? { throughEntryId: forked.targetMessageId } : {}),
      replacesSessionId: head.nativeId,
      materialized: true
    }
  }
}

function warnForkFailure(
  logger: StructuredAgentSessionLogger | undefined,
  message: string,
  error: unknown
): void {
  logger?.warn(message, {
    scope: 'zcode-rewind',
    message: error instanceof Error ? error.message : String(error)
  })
}
