// What the host knows about a structured ZCode chat before any session of it runs.

import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'

/** The protocol whose id space ZCode structured handles live in. */
export const ZCODE_HANDLE_TRANSPORT = 'zcode-app-server'

export const ZCODE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: ZCODE_HANDLE_TRANSPORT,
  agent: 'zcode'
} as const

/** The options a ZCode chat takes while resting: its model and thought level (effort). */
const ZCODE_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort'])

export function isZcodeStructuredOptionKey(key: string): boolean {
  return ZCODE_OPTION_KEYS.has(key)
}

export const ZCODE_STRUCTURED_AGENT: DirectoryAccountAgentDefinition = {
  agent: 'zcode',
  handleTransport: ZCODE_HANDLE_TRANSPORT,
  // ZCode derives every data path from this base (v2 overlays, credentials, session stores).
  accountHomeVariable: 'ZCODE_DATA_BASE_DIR',
  capabilities: {
    // No truncate primitive — but `session/fork {target: turn}` is exactly the Claude-shape
    // fork-a-rewind-continues-in, so the adapter rewinds by forking.
    rewind: true,
    // `session/compact` and `session/goal` are real protocol methods.
    compact: true,
    threadGoal: true,
    // Each turn.completed carries the provider's token accounting; the window comes from the
    // session snapshot.
    contextUsage: true,
    // `session/send` takes image attachments (kind/filename/localPath).
    imagePrompts: true,
    // A send while a turn runs queues server-side; Orca holds it until the turn ends.
    steering: 'queue',
    // Orca answers every `interaction/requestPermission` the agent sends by the chat's setting.
    approvalEnforcement: 'orca'
  },
  restingOptions: {
    acceptsKey: isZcodeStructuredOptionKey,
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
} as const satisfies DirectoryAccountAgentDefinition
