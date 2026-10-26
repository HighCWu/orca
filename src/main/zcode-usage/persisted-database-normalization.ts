import type { ZcodeUsagePersistedDatabase } from './types'

/** Fills fields older ZCode caches never wrote. Electron-free: the scan worker runs it too. */
export function normalizeZcodeUsagePersistedDatabases(
  databases: ZcodeUsagePersistedDatabase[] | undefined
): ZcodeUsagePersistedDatabase[] {
  return (databases ?? []).map((database) => ({
    ...database,
    sessions: database.sessions ?? [],
    dailyAggregates: database.dailyAggregates ?? []
  }))
}
