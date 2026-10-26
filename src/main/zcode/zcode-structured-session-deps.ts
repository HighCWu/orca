import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionAtRestCommands } from '../native-chat/agent-session-wire/structured-agent-session-at-rest-commands'
import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import type { StructuredAgentLaunchResolver } from '../runtime/structured-agent-launch-composition'
import type { ZcodeAgentConnection, ZcodeAgentConnectionOptions } from './zcode-protocol-connection'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'

export type ZcodeDispatchSettlement = { sessionId: string; clientMessageId: string } & (
  | { providerIdentity: AgentJournalItemIdentity }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

export type ZcodeStructuredSessionAdapterDeps = {
  connect?: (
    launch: ProviderProcessLaunch,
    options: ZcodeAgentConnectionOptions
  ) => ZcodeAgentConnection
  resolveLaunch: StructuredAgentLaunchResolver<ZcodeStructuredLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
  onDispatchSettledLate?: (settlement: ZcodeDispatchSettlement) => void
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
  atRestCommands?: StructuredAgentSessionAtRestCommands
  readJournal?: (sessionId: string) => JournalLoad | null
  resolveInvocation?: (accountHomePath: string) => Promise<{
    command: string
    args: string[]
    env: Record<string, string>
    envToDelete: readonly string[]
  }>
  logger?: StructuredAgentSessionLogger
  now?: () => number
}
