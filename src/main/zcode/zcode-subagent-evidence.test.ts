// The subagents-table → child-work evidence fold: live rows, terminal rows, and the
// unchanged-table silence that keeps repeated polls from publishing.

import { describe, expect, it } from 'vitest'
import { ZcodeSubagentEvidence } from './zcode-subagent-evidence'

const AT = 1_700_000_000_000

const table = (running: unknown[], endedItems: unknown[]): unknown => ({
  running,
  ended: { items: endedItems }
})

describe('zcode subagent evidence', () => {
  it('publishes live edges for running rows with the runtime own naming', () => {
    const tracker = new ZcodeSubagentEvidence()
    const evidence = tracker.observe(
      table(
        [
          {
            childSessionId: 'child_1',
            subagentType: 'explore',
            title: 'Exploring the repo',
            summary: 'reading files',
            status: 'running'
          }
        ],
        []
      ),
      AT
    )
    expect(evidence).toEqual([
      {
        type: 'live',
        observedAt: AT,
        child: {
          handle: { idKind: 'thread_id', id: 'child_1' },
          kind: 'agent',
          residency: 'background',
          state: 'working',
          name: 'Exploring the repo',
          description: 'reading files',
          stoppable: false
        }
      }
    ])
  })

  it('maps waiting rows and terminal outcomes into the host vocabulary', () => {
    const tracker = new ZcodeSubagentEvidence()
    const evidence = tracker.observe(
      table(
        [{ childSessionId: 'child_2', status: 'blocked' }],
        [
          { childSessionId: 'child_3', status: 'success', summary: 'done' },
          { childSessionId: 'child_4', status: 'lost' }
        ]
      ),
      AT
    )
    expect(evidence).toEqual([
      {
        type: 'live',
        observedAt: AT,
        child: {
          handle: { idKind: 'thread_id', id: 'child_2' },
          kind: 'agent',
          residency: 'background',
          state: 'blocked',
          stoppable: false
        }
      },
      {
        type: 'ended',
        observedAt: AT,
        handle: { idKind: 'thread_id', id: 'child_3' },
        outcome: 'succeeded',
        lastMessage: 'done'
      },
      {
        type: 'ended',
        observedAt: AT,
        handle: { idKind: 'thread_id', id: 'child_4' },
        outcome: 'unknown'
      }
    ])
  })

  it('publishes nothing when the table is unchanged or unreadable', () => {
    const tracker = new ZcodeSubagentEvidence()
    const rows = table([], [{ childSessionId: 'child_1', status: 'success' }])
    expect(tracker.observe(rows, AT)).not.toBeNull()
    expect(tracker.observe(rows, AT + 1)).toBeNull()
    // A table that really emptied publishes its emptiness (the adapter skips empty arrays);
    // only an unparseable reply reads as null.
    expect(tracker.observe(table([], []), AT + 2)).toEqual([])
    expect(tracker.observe('not a table', AT + 3)).toBeNull()
  })
})
