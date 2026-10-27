import { describe, expect, it } from 'vitest'
import { normalizeZcodeUsageState } from './persisted-state-normalization'
import { ZCODE_USAGE_SCHEMA_VERSION } from './zcode-usage-provider'

describe('normalizeZcodeUsageState', () => {
  it('drops non-array rollups from a corrupt persisted cache', () => {
    const state = JSON.parse(
      JSON.stringify({
        schemaVersion: ZCODE_USAGE_SCHEMA_VERSION,
        worktreeFingerprint: null,
        processedDatabases: [],
        sessions: {},
        dailyAggregates: 'invalid',
        scanState: {
          enabled: true,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastScanError: null
        }
      })
    )

    expect(normalizeZcodeUsageState(state)).toMatchObject({
      sessions: [],
      dailyAggregates: []
    })
  })
})
