import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentSessionProviderOpen } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { ZcodeAgentConnection, ZcodeAgentConnectionOptions } from './zcode-protocol-connection'
import type { ZcodeV4ConversationChannel } from './v4/zcode-v4-conversation-channel'
import type { ZcodeStructuredLane } from './zcode-structured-lane'
import type { ZcodeStructuredPrompts } from './zcode-structured-prompts'
import type { ZcodeSessionMode } from './zcode-session-snapshot-facts'

export type ZcodeStructuredChild = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  connection: ZcodeAgentConnection
  prompts: ZcodeStructuredPrompts
  lane: ZcodeStructuredLane | null
  resume: { sessionId: string; key: string } | null
  providerSessionId: string | null
  currentModel: string | null
  currentSelection: { providerId: string; modelId: string } | null
  currentEffort: string | null
  currentMode: ZcodeSessionMode | null
  contextWindow: number | null
  slashCommands: { name: string; description?: string; inputHint?: string }[] | null
  modelOptions: AgentSessionModelOption[] | null
  optionRestoreFailures: Set<string>
  launch: {
    cwd: string
    workspaceId: string
    permissionMode?: string
    env: Record<string, string>
  }
  journalClosed: Error | null
  ended: boolean
  exitObservedAt: number | null
  closeRequested: boolean
  v4Channel: ZcodeV4ConversationChannel | null
  open: StructuredAgentSessionProviderOpen
  dispose: () => void
}

export type ZcodeStructuredChildDeps = {
  connect: (
    launch: ProviderProcessLaunch,
    options: ZcodeAgentConnectionOptions
  ) => ZcodeAgentConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  logger?: StructuredAgentSessionLogger
  now?: () => number
}
