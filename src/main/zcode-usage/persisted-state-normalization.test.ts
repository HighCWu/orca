import { describe, expect, it } from 'vitest'
import { normalizeZcodeUsageState } from './persisted-state-normalization'
import { ZCODE_USAGE_SCHEMA_VERSION } from './zcode-usage-provider'

describe('normalizeZcodeUsageState', () => {
  it('fills split cache metrics missing from an older persisted cache', () => {
    const oldSession = {
      sessionId: 'session-1',
      locationBreakdown: [{ locationKey: 'project-1' }],
      modelBreakdown: [{ modelKey: 'GLM-5.3' }],
      locationModelBreakdown: [{ locationKey: 'project-1', modelKey: 'GLM-5.3' }]
    }
    const state = JSON.parse(
      JSON.stringify({
        schemaVersion: ZCODE_USAGE_SCHEMA_VERSION,
        worktreeFingerprint: null,
        processedDatabases: [
          {
            path: '/tmp/zcode.db',
            mtimeMs: 1,
            size: 1,
            sessions: [oldSession],
            dailyAggregates: [{ day: '2026-10-27' }]
          }
        ],
        sessions: [oldSession],
        dailyAggregates: [{ day: '2026-10-27' }],
        scanState: {
          enabled: true,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastScanError: null
        }
      })
    )

    const normalized = normalizeZcodeUsageState(state)

    expect(normalized.sessions[0]).toMatchObject({
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      locationBreakdown: [{ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }],
      modelBreakdown: [{ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }],
      locationModelBreakdown: [{ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }]
    })
    expect(normalized.dailyAggregates[0]).toMatchObject({
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0
    })
    expect(normalized.processedDatabases[0]).toMatchObject({
      sessions: [{ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }],
      dailyAggregates: [{ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }]
    })
  })

  it('drops source-cache records with missing rollup arrays', () => {
    const state = JSON.parse(
      JSON.stringify({
        schemaVersion: ZCODE_USAGE_SCHEMA_VERSION,
        worktreeFingerprint: null,
        processedDatabases: [
          null,
          'invalid',
          { path: '/tmp/missing-sessions.db', mtimeMs: 1, size: 1, dailyAggregates: [] },
          { path: '/tmp/missing-daily.db', mtimeMs: 1, size: 1, sessions: [] }
        ],
        sessions: [],
        dailyAggregates: [],
        scanState: {
          enabled: true,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastScanError: null
        }
      })
    )

    expect(normalizeZcodeUsageState(state).processedDatabases).toEqual([])
  })

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
