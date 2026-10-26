// The `/` surface of a zcode chat whose agent is not running, as the CLI itself lists it: a
// scratch app-server resumes the chat's session (or opens a draft) and answers with its snapshot.

import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import { zcodeWorkspacePresentationSchema } from './zcode-protocol-messages'
import { zcodeCatalogSnapshotSchema, zcodeSlashCommandsOf } from './zcode-session-snapshot-facts'

/** The -32601 an app-server without `workspace/readPresentation` answers with. */
function isMethodMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Method not found')
}

export type ZcodeAtRestCommandsDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveInvocation: (accountHomePath: string) => Promise<{
    command: string
    args: string[]
    env: Record<string, string>
    envToDelete: readonly string[]
  }>
  connect: (launch: {
    command: string
    args: string[]
    cwd?: string
    env?: Record<string, string>
  }) => ZcodeAgentConnection
  now?: () => number
}

export class ZcodeAtRestCommandCatalog extends AtRestCommandCatalog {
  constructor(deps: ZcodeAtRestCommandsDeps) {
    super({
      label: 'zcode',
      accepts: (record) =>
        record.provider === 'zcode' &&
        supportsSupervisedProviderChildLocation(record.location) &&
        isLegacyAgentSessionAccountHome(record.accountHome),
      resolveWorkspacePath: deps.resolveWorkspacePath,
      scan: (record, cwd, isCurrent) => scanZcodeAtRest(deps, record, cwd, isCurrent),
      ...(deps.now ? { now: deps.now } : {})
    })
  }
}

async function scanZcodeAtRest(
  deps: ZcodeAtRestCommandsDeps,
  record: AgentSessionRecord,
  cwd: string,
  isCurrent: () => boolean
): Promise<AtRestCommandScan> {
  const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const invocation = await deps.resolveInvocation(accountHome)
  const connection = deps.connect({ ...invocation, cwd })
  try {
    const workspace = { workspacePath: cwd, workspaceKey: record.location.workspaceId }
    // Why: `workspace/readPresentation` answers the `/` surface without opening a session — a
    // resume marks the session active and a create mints a draft. Runtimes predating the method
    // fall back to opening the session the old way.
    try {
      const presentation = zcodeWorkspacePresentationSchema.parse(
        await connection.request('workspace/readPresentation', { workspace })
      )
      if (!isCurrent()) {
        return { commands: undefined, fromAgent: false }
      }
      return { commands: zcodeSlashCommandsOf(presentation.slashCommands), fromAgent: true }
    } catch (error) {
      if (!isMethodMissing(error)) {
        throw error
      }
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
    const snapshot = head
      ? await connection.request(
          'session/resume',
          { sessionId: head.nativeId, workspace },
          undefined
        )
      : await connection.request('session/create', {
          workspace,
          persistence: 'deferred',
          titleGenerationEnabled: false
        })
    const read = zcodeCatalogSnapshotSchema.parse(snapshot)
    if (!isCurrent()) {
      return { commands: undefined, fromAgent: false }
    }
    return { commands: zcodeSlashCommandsOf(read.slashCommands), fromAgent: true }
  } finally {
    await connection.close().catch(() => undefined)
  }
}
