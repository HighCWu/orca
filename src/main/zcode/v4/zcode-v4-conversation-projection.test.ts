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

describe('zcode v4 conversation translator', () => {
  it('seeds the watermark, revision and usage from a snapshot without emitting history rows', () => {
    const t = translator()
    const events = t.apply(
      frame({
        kind: 'snapshot',
        snapshot: {
          ...SNAPSHOT,
          rows: [
            row({ rowId: 1, kind: 'userInput', text: 'past question', sourceCommandId: 'cmd-0' })
          ]
        }
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'context.usage' })
    expect(t.watermark()).toEqual({ logEpoch: 'epoch-1', seq: 4 })
    expect(t.revision()).toBe(2)
    expect(t.snapshotRows()).toHaveLength(1)
  })

  it('reads the real wire snapshot, whose rows arrive windowed, and takes its epoch', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'snapshot',
        snapshot: {
          ...SNAPSHOT,
          rows: {
            window: [
              row({ rowId: 1, kind: 'assistantText', entityId: 'msg_1', text: 'kept answer' }),
              row({ rowId: 2, turnId: 'turn_2', kind: 'userInput', text: 'the retry' })
            ],
            totalCount: 2,
            firstRowId: 1
          }
        }
      })
    )
    expect(t.watermark()).toEqual({ logEpoch: 'epoch-1', seq: 4 })
    expect(t.snapshotRows()).toHaveLength(2)
    expect(t.forkTargetBeforeTurn('turn_2')).toEqual({ rowId: 1, entityId: 'msg_1' })
  })

  it('replaces rows and row event state when a resync snapshot arrives', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'snapshot',
        snapshot: {
          ...SNAPSHOT,
          rows: [
            row({ rowId: 1, kind: 'assistantText', entityId: 'old_message', text: 'old' }),
            row({ rowId: 2, turnId: 'turn_2', kind: 'userInput', text: 'retry' })
          ]
        }
      })
    )
    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({ rowId: 1, kind: 'assistantText', text: 'old answer', state: 'complete' })
            },
            {
              op: 'row.appended',
              row: row({ rowId: 3, kind: 'turnHeader', state: 'running' })
            }
          ]
        })
      )
    ).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn.open' })]))

    t.apply(
      frame({
        kind: 'snapshot',
        snapshot: { ...SNAPSHOT, logEpoch: 'epoch-2', seq: 8, rows: [] }
      })
    )
    const events = t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.appended',
            row: row({ rowId: 1, kind: 'assistantText', text: 'new', state: 'complete' })
          },
          {
            op: 'row.appended',
            row: row({ rowId: 3, kind: 'turnHeader', state: 'running' })
          }
        ]
      })
    )

    expect(t.snapshotRows().map((item) => item.rowId)).toEqual([1, 3])
    expect(t.forkTargetBeforeTurn('turn_2')).toBeNull()
    expect(events).toEqual([
      expect.objectContaining({ type: 'text.delta', text: 'new' }),
      expect.objectContaining({ type: 'turn.open', turn: 'turn_1' })
    ])
  })

  it('uses snapshot rows as the baseline for later text and subagent updates', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'snapshot',
        snapshot: {
          ...SNAPSHOT,
          rows: [
            row({ rowId: 4, kind: 'assistantText', text: 'already journaled', state: 'complete' }),
            row({
              rowId: 5,
              kind: 'toolCall',
              status: 'running',
              toolCallId: 'call_1',
              toolName: 'bash'
            }),
            row({
              rowId: 8,
              kind: 'subagent',
              status: 'running',
              childSessionId: 'sess_child'
            })
          ]
        }
      })
    )

    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({
                rowId: 4,
                kind: 'assistantText',
                text: 'already journaled plus',
                state: 'complete'
              })
            },
            {
              op: 'row.upserted',
              row: row({
                rowId: 5,
                kind: 'toolCall',
                status: 'running',
                toolCallId: 'call_1',
                toolName: 'bash'
              })
            },
            {
              op: 'row.upserted',
              row: row({
                rowId: 8,
                kind: 'subagent',
                status: 'running',
                childSessionId: 'sess_child'
              })
            }
          ]
        })
      )
    ).toEqual([expect.objectContaining({ type: 'text.delta', text: ' plus' })])
    expect(t.drainChildWorkEvidence()).toEqual([])
  })

  it('forgets row baselines when a branch is removed', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'snapshot',
        snapshot: {
          ...SNAPSHOT,
          rows: [row({ rowId: 4, kind: 'assistantText', text: 'old', state: 'complete' })]
        }
      })
    )
    t.apply(frame({ kind: 'deltas', deltas: [{ op: 'row.removed', fromRowId: 4 }] }))

    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.appended',
              row: row({ rowId: 4, kind: 'assistantText', text: 'new', state: 'complete' })
            }
          ]
        })
      )
    ).toEqual([expect.objectContaining({ type: 'text.delta', text: 'new' })])
  })

  it('translates the live turn lifecycle: open, streaming text, end', () => {
    const t = translator()
    t.apply(frame({ kind: 'snapshot', snapshot: SNAPSHOT }))
    const events = [
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.appended',
              row: row({ rowId: 2, kind: 'turnHeader', state: 'running', startedAt: 1 })
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.appended',
              row: row({
                rowId: 3,
                kind: 'userInput',
                text: 'hello',
                sourceCommandId: 'cmd-9'
              })
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.appended',
              row: row({
                rowId: 4,
                kind: 'assistantText',
                text: 'He',
                state: 'streaming',
                model: 'GLM-5.3'
              })
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [{ op: 'row.delta', rowId: 4, path: 'text', append: 'llo world' }]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({
                rowId: 4,
                kind: 'assistantText',
                text: 'Hello world',
                state: 'complete'
              })
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({
                rowId: 2,
                kind: 'turnHeader',
                state: 'completedSuccess',
                endedAt: 2,
                activeMs: 1_500
              })
            }
          ]
        })
      )
    ]

    expect(events).toEqual([
      { type: 'turn.open', turn: 'turn_1', at: 1 },
      {
        type: 'input.accepted',
        clientMessageId: 'cmd-9',
        requestedAt: 1_792_800_000_000,
        join: { thread: SESSION, turn: 'turn_1' }
      },
      {
        type: 'text.delta',
        item: { id: 'v4row:4' },
        channel: 'assistant',
        text: 'He',
        join: { thread: SESSION, turn: 'turn_1' }
      },
      {
        type: 'text.delta',
        item: { id: 'v4row:4' },
        channel: 'assistant',
        text: 'llo world',
        join: { thread: SESSION, turn: 'turn_1' }
      },
      {
        type: 'turn.end',
        turn: 'turn_1',
        at: 2,
        state: 'completed',
        outcome: 'success',
        durationMs: 1_500
      }
    ])
  })

  it('ignores plugin and workflow deltas without dropping adjacent conversation changes', () => {
    const t = translator()
    const events = t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          { op: 'pluginUi.resourceUpdated', resourceId: 'resource-1' },
          {
            op: 'row.appended',
            row: row({ rowId: 2, kind: 'turnHeader', state: 'running', startedAt: 1 })
          },
          { op: 'workflowRun.updated', workflowRunId: 'run-1' }
        ]
      })
    )

    expect(events).toEqual([{ type: 'turn.open', turn: 'turn_1', at: 1 }])
    expect(t.watermark().seq).toBe(1)
  })

  it('keeps tool and subagent stream paths out of assistant text', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.appended',
            row: row({
              rowId: 5,
              kind: 'toolCall',
              status: 'running',
              toolCallId: 'call_1',
              toolName: 'bash',
              input: ''
            })
          },
          {
            op: 'row.appended',
            row: row({ rowId: 6, kind: 'subagent', summaryText: '' })
          }
        ]
      })
    )

    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            { op: 'row.delta', rowId: 5, path: 'inputText', append: '{"command":"ls"}' },
            { op: 'row.delta', rowId: 5, path: 'output.text', append: 'file.txt' },
            { op: 'row.delta', rowId: 6, path: 'summaryText', append: 'done' }
          ]
        })
      )
    ).toEqual([])
    expect(t.snapshotRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowId: 5, input: '{"command":"ls"}', output: 'file.txt' }),
        expect.objectContaining({ rowId: 6, summaryText: 'done' })
      ])
    )
  })

  it('does not admit a synthetic user input without an Orca pending send', () => {
    const t = translator()
    const events = t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.appended',
            row: row({ rowId: 8, kind: 'userInput', origin: 'synthetic', text: 'continue' })
          }
        ]
      })
    )

    expect(events).toEqual([])
  })

  it('translates the tool call status machine', () => {
    const t = translator()
    const events = [
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.appended',
              row: row({
                rowId: 5,
                kind: 'toolCall',
                status: 'running',
                toolCallId: 'call_1',
                toolName: 'bash',
                input: { command: 'ls' }
              })
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({
                rowId: 5,
                kind: 'toolCall',
                status: 'success',
                toolCallId: 'call_1',
                toolName: 'bash',
                input: { command: 'ls' },
                output: 'file.txt'
              })
            }
          ]
        })
      )
    ]
    expect(events).toEqual([
      {
        type: 'item.open',
        item: 'tool:"call_1"',
        body: {
          kind: 'tool-call',
          name: 'bash',
          input: { command: 'ls' },
          callId: 'call_1',
          state: 'running'
        },
        join: { thread: SESSION, turn: 'turn_1' }
      },
      {
        type: 'item.close',
        item: 'tool:"call_1"',
        body: {
          kind: 'tool-call',
          name: 'bash',
          input: { command: 'ls' },
          callId: 'call_1',
          state: 'completed',
          // journalToolPayload bounds the output into a digest-carrying payload.
          output: {
            byteLength: 8,
            digest: 'aadf327c8267c09d6fffd87a1a80ad3c798469ff332b7a57b9e8c045d46b2af7',
            head: 'file.txt',
            truncated: false
          }
        },
        join: { thread: SESSION, turn: 'turn_1' }
      }
    ])
    expect(
      t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: row({
                rowId: 5,
                kind: 'toolCall',
                status: 'success',
                toolCallId: 'call_1',
                toolName: 'bash',
                input: { command: 'ls' },
                output: 'file.txt'
              })
            }
          ]
        })
      )
    ).toEqual([])
  })

  it('maps state patches: usage, api retry activity, and session end', () => {
    const t = translator()
    t.apply(frame({ kind: 'snapshot', snapshot: SNAPSHOT }))
    t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          { op: 'row.appended', row: row({ rowId: 6, kind: 'turnHeader', state: 'running' }) }
        ]
      })
    )
    const events = [
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'state.updated',
              patch: {
                revision: 9,
                control: {
                  phase: 'running',
                  sessionEnded: false,
                  canStop: true,
                  apiRetry: { attempt: 2, maxAttempts: 5 }
                }
              }
            }
          ]
        })
      ),
      ...t.apply(
        frame({
          kind: 'deltas',
          deltas: [
            {
              op: 'state.updated',
              patch: {
                control: { phase: 'error', sessionEnded: true, canStop: false, apiRetry: null }
              }
            }
          ]
        })
      )
    ]
    expect(t.revision()).toBe(9)
    const retryActivity = events.find((event) => event.type === 'activity')
    expect(retryActivity).toMatchObject({
      text: 'Model stream interrupted — re-requesting (retry 2/5)'
    })
    // The derived sessionEnded flag never settles anything here: the lane assembler's
    // session.ended handling (process exit) owns turn settlement.
    expect(events.find((event) => event.type === 'session.ended')).toBeUndefined()
    expect(events.find((event) => event.type === 'turn.end')).toBeUndefined()
  })

  it('opens and settles background work cards from the works table diff', () => {
    const t = translator()
    const patch = (works: unknown[]) =>
      frame({
        kind: 'deltas',
        deltas: [{ op: 'state.updated', patch: { backgroundWorks: works } }]
      })
    const opened = t.apply(
      patch([
        { workId: 'work-1', kind: 'bash', title: 'long build', status: 'running' },
        { workId: 'work-2', kind: 'subagent', title: 'review', status: 'running' }
      ])
    )
    expect(opened).toHaveLength(2)
    expect(opened[0]).toMatchObject({
      type: 'item.open',
      item: 'background-task:work-1',
      body: {
        kind: 'message',
        blocks: [{ type: 'text' }, { type: 'background-task', taskId: 'work-1', state: 'working' }]
      }
    })
    const settled = t.apply(
      patch([{ workId: 'work-1', kind: 'bash', title: 'long build', status: 'failed' }])
    )
    // work-1 settles as done; work-2 left the table, so its card settles unverifiable.
    expect(settled).toHaveLength(2)
    expect(settled[0]).toMatchObject({
      type: 'item.close',
      item: 'background-task:work-1'
    })
    expect(settled[1]).toMatchObject({
      type: 'item.close',
      item: 'background-task:work-2'
    })
    // An unchanged table emits nothing.
    expect(
      t.apply(patch([{ workId: 'work-1', kind: 'bash', title: 'long build', status: 'failed' }]))
    ).toEqual([])
  })

  it('turns subagent rows into child-work evidence with dedup', () => {
    const t = translator()
    t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.appended',
            row: row({
              rowId: 8,
              kind: 'subagent',
              status: 'running',
              subagentType: 'Explore',
              childSessionId: 'sess_child',
              summaryText: 'scanning'
            })
          }
        ]
      })
    )
    const live = t.drainChildWorkEvidence()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      type: 'live',
      child: {
        handle: { idKind: 'thread_id', id: 'sess_child' },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        stoppable: false
      }
    })
    // A re-upsert with the same status emits nothing.
    t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.upserted',
            row: row({
              rowId: 8,
              kind: 'subagent',
              status: 'running',
              childSessionId: 'sess_child',
              summaryText: 'scanning'
            })
          }
        ]
      })
    )
    expect(t.drainChildWorkEvidence()).toEqual([])
    t.apply(
      frame({
        kind: 'deltas',
        deltas: [
          {
            op: 'row.upserted',
            row: row({
              rowId: 8,
              kind: 'subagent',
              status: 'success',
              childSessionId: 'sess_child',
              summaryText: 'done'
            })
          }
        ]
      })
    )
    const ended = t.drainChildWorkEvidence()
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      type: 'ended',
      handle: { idKind: 'thread_id', id: 'sess_child' },
      outcome: 'succeeded',
      lastMessage: 'done'
    })
  })

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
