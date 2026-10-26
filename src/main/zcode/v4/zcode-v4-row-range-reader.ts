// Stable, fail-closed pagination for v4 conversation rows used as rewind targets.

import type { ZcodeAgentConnection } from '../zcode-protocol-connection'
import {
  V4_METHODS,
  zcodeV4ConversationRowsRangeParamsSchema,
  zcodeV4ConversationRowsRangeResultSchema
} from './zcode-v4-protocol-messages'
import {
  zcodeV4ConversationRowSchema,
  type ZcodeV4ConversationRow
} from './zcode-v4-conversation-frames'

export async function readZcodeV4RowsBefore(input: {
  connection: ZcodeAgentConnection
  sessionId: string
  beforeRowId: number
  logEpoch: string | null
}): Promise<ZcodeV4ConversationRow[]> {
  const rows: ZcodeV4ConversationRow[] = []
  let rangeWatermark: { atLogEpoch: string; atSeq: number; atRevision: number } | undefined
  let cursor = input.beforeRowId
  let hasMore = true
  while (hasMore) {
    const result = zcodeV4ConversationRowsRangeResultSchema.parse(
      await input.connection.request(
        V4_METHODS.conversationRowsRange,
        zcodeV4ConversationRowsRangeParamsSchema.parse({
          sessionId: input.sessionId,
          clientMode: 'desktop-continuous',
          beforeRowId: cursor,
          limit: 200
        }),
        10_000
      )
    )
    const resultWatermark = {
      atLogEpoch: result.atLogEpoch,
      atSeq: result.atSeq,
      atRevision: result.atRevision
    }
    rangeWatermark ??= resultWatermark
    if (
      result.atLogEpoch !== input.logEpoch ||
      result.atLogEpoch !== rangeWatermark.atLogEpoch ||
      result.atSeq !== rangeWatermark.atSeq ||
      result.atRevision !== rangeWatermark.atRevision
    ) {
      throw new Error('zcode v4 rows changed while reading rewind history')
    }
    const page = result.rows.map((row) => zcodeV4ConversationRowSchema.parse(row))
    rows.unshift(...page)
    hasMore = result.hasMore
    if (hasMore) {
      const nextCursor = page[0]?.rowId
      if (nextCursor === undefined || nextCursor >= cursor) {
        throw new Error('zcode v4 rows range did not advance its cursor')
      }
      cursor = nextCursor
    }
  }
  return rows
}
