import type {
  ZcodeUsageDailyAggregate,
  ZcodeUsagePersistedDatabase,
  ZcodeUsageSession
} from './types'

export function normalizeZcodeUsageSessions(sessions: ZcodeUsageSession[]): ZcodeUsageSession[] {
  return sessions.map((session) => ({
    ...session,
    cacheReadInputTokens: session.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: session.cacheWriteInputTokens ?? 0,
    locationBreakdown: session.locationBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    }))
  }))
}

export function normalizeZcodeUsageDailyAggregates(
  dailyAggregates: ZcodeUsageDailyAggregate[]
): ZcodeUsageDailyAggregate[] {
  return dailyAggregates.map((aggregate) => ({
    ...aggregate,
    cacheReadInputTokens: aggregate.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: aggregate.cacheWriteInputTokens ?? 0
  }))
}

export function normalizeZcodeUsagePersistedDatabases(
  databases: ZcodeUsagePersistedDatabase[] | undefined
): ZcodeUsagePersistedDatabase[] {
  return (databases ?? []).map((database) => ({
    ...database,
    sessions: normalizeZcodeUsageSessions(database.sessions ?? []),
    dailyAggregates: normalizeZcodeUsageDailyAggregates(database.dailyAggregates ?? [])
  }))
}
