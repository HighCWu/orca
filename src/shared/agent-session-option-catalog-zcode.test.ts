import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { ZCODE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-zcode'

describe('zcode session option catalog', () => {
  it('is registered for the zcode agent', () => {
    expect(getAgentSessionOptionCatalog('zcode')).toBe(ZCODE_SESSION_OPTION_CATALOG)
  })

  it('delivers effort as the typed command the zcode TUI parses', () => {
    const effort = ZCODE_SESSION_OPTION_CATALOG.unknownModelOptions?.find(
      (option) => option.id === 'effort'
    )
    if (!effort || effort.kind.type !== 'select') {
      throw new Error('effort option missing')
    }
    expect(effort.kind.choices.map((choice) => choice.value)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max'
    ])
    const midSession = effort.apply.midSession
    if (midSession?.kind !== 'command') {
      throw new Error('effort must deliver as a typed command')
    }
    expect(midSession.build('max')).toBe('/effort max')
  })

  it('seeds no models: ids are account-scoped and the CLI has no listing command', () => {
    expect(ZCODE_SESSION_OPTION_CATALOG.models).toEqual([])
    expect(ZCODE_SESSION_OPTION_CATALOG.listModels).toBeUndefined()
    expect(ZCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs).toBeUndefined()
  })
})
