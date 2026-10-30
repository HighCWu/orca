import { describe, expect, it } from 'vitest'
import { ZcodeV4ConversationTranslator } from './zcode-v4-conversation-projection'
import type { ZcodeV4ConversationRow } from './zcode-v4-conversation-frames'

const SESSION = 'sess_v4'

function translator(): ZcodeV4ConversationTranslator {
  return new ZcodeV4ConversationTranslator({ now: () => 1_792_800_000_000 }, SESSION)
}

function row(
  fields: Partial<ZcodeV4ConversationRow> & { rowId: number; kind: string }
): ZcodeV4ConversationRow {
  // Rows arrive as untyped wire JSON, so the fixture takes the same route.
  return JSON.parse(JSON.stringify({ turnId: 'turn_1', createdAt: 1_792_800_000_000, ...fields }))
}

function frame(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    topic: `conversation/${SESSION}`,
    subscriptionId: 'sub-1',
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1_792_800_000_000,
    payload
  }
}

const SNAPSHOT = {
  protocolVersion: 1,
  sessionId: SESSION,
  logEpoch: 'epoch-1',
  seq: 4,
  revision: 2,
  rows: [],
  usage: {
    contextWindow: { usedTokens: 500, maxTokens: 200_000 },
    cumulative: {
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  }
}

describe('zcode v4 conversation failure and settlement', () => {
  it('names a usage-limit failure on a failed turn when control.lastError says so', () => {
    const t2 = translator()
    t2.apply(frame({ kind: 'snapshot', snapshot: SNAPSHOT }))
    const one = t2.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'state.updated',
            patch: {
              control: {
                phase: 'running',
                sessionEnded: false,
                canStop: true,
                lastError: {
                  code: 'rate_limit_error',
                  message: 'quota',
                  source: 'provider',
                  attribution: { statusCode: 429 }
                }
              }
            }
          }
        ]
      })
    )
    void one
    t2.apply(
      frame({
        kind: 'deltas',
        deltas: [
          { op: 'row.appended', row: row({ rowId: 9, kind: 'turnHeader', state: 'running' }) }
        ]
      })
    )
    const failed = t2.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.upserted',
            row: row({ rowId: 9, kind: 'turnHeader', state: 'failed', endedAt: 2 })
          }
        ]
      })
    )
    const limitItem = failed.find((event) => event.type === 'item.open')
    expect(limitItem).toMatchObject({
      type: 'item.open',
      body: { kind: 'status', tone: 'error' },
      item: `terminal-failure:zcode:${JSON.stringify(['sess_v4', 'turn_1'])}`
    })
    expect(failed.find((event) => event.type === 'turn.end')).toMatchObject({ outcome: 'failure' })
  })

  it('classifies a failed row before a later lastError delta in the same frame', () => {
    const t2 = translator()
    t2.apply(frame({ kind: 'snapshot', snapshot: SNAPSHOT }))
    t2.apply(
      frame({
        kind: 'deltas',
        deltas: [
          { op: 'row.appended', row: row({ rowId: 9, kind: 'turnHeader', state: 'running' }) }
        ]
      })
    )
    const failed = t2.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.upserted',
            row: row({ rowId: 9, kind: 'turnHeader', state: 'failed', endedAt: 2 })
          },
          {
            op: 'state.updated',
            patch: {
              control: {
                phase: 'failed',
                sessionEnded: true,
                canStop: false,
                lastError: {
                  code: 'model_rate_limited',
                  message: 'quota',
                  source: 'provider',
                  attribution: { statusCode: 429 }
                }
              }
            }
          }
        ]
      })
    )
    expect(failed.find((event) => event.type === 'item.open')).toMatchObject({
      body: { kind: 'status', failure: { kind: 'usageLimitReached' }, tone: 'error' }
    })
  })

  it('settles each v4 turn once no matter how the terminal row repeats', () => {
    const t = translator()
    t.apply(frame({ kind: 'snapshot', snapshot: SNAPSHOT }))
    const deltas = (rows: unknown[]) =>
      t.apply(frame({ kind: 'deltas', deltas: rows.map((row) => ({ op: 'row.upserted', row })) }))
    deltas([row({ rowId: 10, kind: 'turnHeader', state: 'running' })])
    const first = deltas([
      row({ rowId: 10, kind: 'turnHeader', state: 'completedSuccess', endedAt: 2 })
    ])
    expect(first.filter((event) => event.type === 'turn.end')).toHaveLength(1)
    // The CLI re-upserts terminal rows freely (a state replay, a later table refresh).
    const repeat = deltas([
      row({ rowId: 10, kind: 'turnHeader', state: 'completedSuccess', endedAt: 2 }),
      row({ rowId: 10, kind: 'turnHeader', state: 'failed', endedAt: 3 })
    ])
    expect(repeat.filter((event) => event.type === 'turn.end')).toHaveLength(0)
  })

  it('ignores unknown row kinds and drops removed branches', () => {
    const t = translator()
    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [{ op: 'row.appended', row: row({ rowId: 7, kind: 'timelineMarker' }) }]
        })
      )
    ).toEqual([])
    expect(
      t.apply(frame({ kind: 'deltas', deltas: [{ op: 'row.removed', fromRowId: 0 }] }))
    ).toEqual([])
    expect(t.snapshotRows()).toHaveLength(0)
  })
})
