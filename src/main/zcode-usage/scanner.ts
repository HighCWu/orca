import { yieldToEventLoop } from '../../shared/event-loop-yield'
import Database from '../sqlite/sync-database'
import { attributeUsageEvent } from '../usage/usage-event-attribution'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import { getProcessedDatabaseInfo, listZcodeDatabases } from './zcode-database-discovery'
import { parseZcodeUsageRow } from './zcode-usage-row-parsing'
import { selectZcodeUsageRows } from './zcode-usage-row-queries'
import type {
  ZcodeUsageAttributedEvent,
  ZcodeUsageDailyAggregate,
  ZcodeUsageMetric,
  ZcodeUsagePersistedDatabase,
  ZcodeUsageSession
} from './types'

const YIELD_EVERY_DATABASES = 2

export const zcodeUsageAggregation = createUsageEventAggregation<
  ZcodeUsageAttributedEvent,
  ZcodeUsageMetric
>({
  metric: { empty: () => ({}), fromEvent: () => ({}), fold: () => {} },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

export async function parseZcodeUsageDatabase(
  dbPath: string,
  resolveWorktree: UsageWorktreeResolver
): Promise<ZcodeUsagePersistedDatabase> {
  const processedDatabase = await getProcessedDatabaseInfo(dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const events: ZcodeUsageAttributedEvent[] = []
    for (const row of selectZcodeUsageRows(db)) {
      const parsed = parseZcodeUsageRow(row)
      if (!parsed) {
        continue
      }
      const attributed = attributeUsageEvent(parsed, resolveWorktree)
      if (attributed) {
        events.push(attributed)
      }
    }
    return {
      ...processedDatabase,
      ...zcodeUsageAggregation.aggregate(events)
    }
  } finally {
    db.close()
  }
}

export async function scanZcodeUsageDatabases(
  worktrees: UsageScanWorktreeRef[],
  previousProcessedDatabases: ZcodeUsagePersistedDatabase[],
  onFilesScanned?: (count: number) => void
): Promise<{
  processedDatabases: ZcodeUsagePersistedDatabase[]
  sessions: ZcodeUsageSession[]
  dailyAggregates: ZcodeUsageDailyAggregate[]
}> {
  const dbPaths = await listZcodeDatabases()
  const previousByPath = new Map(
    previousProcessedDatabases.map((database) => [database.path, database])
  )
  // Why: one resolver for the whole scan so every database shares the per-cwd memo.
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const reusedByPath = new Map<string, ZcodeUsagePersistedDatabase>()
  const pathsToParse: string[] = []
  for (const dbPath of dbPaths) {
    const databaseInfo = await getProcessedDatabaseInfo(dbPath)
    const previous = previousByPath.get(dbPath)
    const canReuse =
      previous &&
      previous.mtimeMs === databaseInfo.mtimeMs &&
      previous.size === databaseInfo.size &&
      Array.isArray(previous.sessions) &&
      Array.isArray(previous.dailyAggregates)
    if (canReuse) {
      reusedByPath.set(dbPath, previous)
    } else {
      pathsToParse.push(dbPath)
    }
  }

  const parsedByPath = new Map<string, ZcodeUsagePersistedDatabase>()
  for (const [index, dbPath] of pathsToParse.entries()) {
    try {
      parsedByPath.set(dbPath, await parseZcodeUsageDatabase(dbPath, resolveWorktree))
    } catch {
      // Unreadable, locked, or vanished mid-scan; the next scan retries it.
    }
    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_DATABASES === 0) {
      await yieldToEventLoop()
    }
  }

  const processedDatabases: ZcodeUsagePersistedDatabase[] = []
  const sessionsById = new Map<string, ZcodeUsageSession>()
  const dailyByKey = new Map<string, ZcodeUsageDailyAggregate>()
  for (const dbPath of dbPaths) {
    const processed = reusedByPath.get(dbPath) ?? parsedByPath.get(dbPath)
    if (!processed) {
      continue
    }
    processedDatabases.push(processed)
    zcodeUsageAggregation.mergeSessions(sessionsById, processed.sessions)
    zcodeUsageAggregation.mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedDatabases,
    sessions: zcodeUsageAggregation.finalizeSessions(sessionsById),
    dailyAggregates: zcodeUsageAggregation.sortDailyAggregates(dailyByKey)
  }
}
