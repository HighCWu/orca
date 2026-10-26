import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

// The tiers the zcode CLI's own `/effort <level>` command validates against. A model's
// reachable set is its account's own menu, so `defaultValue` is only the picker's
// pre-selection, never a claim about the CLI default.
const ZCODE_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'none', label: 'None' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ],
    defaultValue: 'high'
  },
  apply: {
    // The zcode CLI takes no model or effort launch flags; the running TUI takes
    // both as typed commands, so the mid-session delivery is the only one there is.
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const ZCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: zcode model ids are `providerId/modelId` pairs only the account's own
  // listing can name, and the CLI exposes no non-interactive listing command, so
  // seed nothing — the TUI's own `/model` picker remains the model surface.
  models: [],
  modelApply: {
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  unknownModelOptions: [ZCODE_EFFORT]
}
