// The journal-side arithmetic of a fork-based rewind.

import { describe, expect, it } from 'vitest'
import {
  countKeptTurns,
  isJournalRewindSource,
  zcodeRewindTurnIndex
} from './zcode-structured-rewind'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'

type TurnItem = { itemId: string; body: AgentJournalItemBody }

function journalWith(turns: readonly { turnId: string; userItemId?: string }[]): {
  damage: null
  newer: null
  state: { items: Map<string, TurnItem> }
} {
  const items = new Map<string, TurnItem>(
    turns.map((turn, index) => [
      `turn-${index}`,
      {
        itemId: `turn-${index}`,
        body: {
          kind: 'turn' as const,
          turnId: turn.turnId,
          state: 'completed' as const,
          ...(turn.userItemId ? { userItemId: turn.userItemId } : {})
        }
      }
    ])
  )
  return { damage: null, newer: null, state: { items } }
}

describe('zcode rewind turn arithmetic', () => {
  const readJournal = (turns: readonly { turnId: string; userItemId?: string }[]) => () =>
    journalWith(turns)

  it('counts user-opened turns before the cut, skipping command and goal turns', () => {
    const turns = [
      { turnId: 't0', userItemId: 'm0' },
      { turnId: 't1' }, // a /compact command turn: no user item, zcode does not count it either
      { turnId: 't2', userItemId: 'm2' },
      { turnId: 't3' } // a goal turn the agent opened itself
    ]
    const journal = readJournal(turns)
    // t2 is the second user-opened turn, so one turn is kept before it.
    expect(countKeptTurns(journal, 's', 't2')).toBe(1)
    expect(countKeptTurns(journal, 's', 't0')).toBe(0)
    expect(countKeptTurns(journal, 's', 't1')).toBeNull()
  })

  it('cannot count an unreadable journal or a cut the journal never saw', () => {
    expect(countKeptTurns(undefined, 's', 't0')).toBeNull()
    expect(countKeptTurns(() => null, 's', 't0')).toBeNull()
    expect(countKeptTurns(readJournal([{ turnId: 't0', userItemId: 'm0' }]), 's', 't9')).toBeNull()
  })

  it('maps a kept count to the fork target index; an empty keep is turnIndex 0', () => {
    expect(zcodeRewindTurnIndex(3)).toBe(3)
    expect(zcodeRewindTurnIndex(1)).toBe(1)
    expect(zcodeRewindTurnIndex(0)).toBe(0)
    expect(zcodeRewindTurnIndex(null)).toBeNull()
  })

  it('narrows rewind support to a journal that can count a fork target', () => {
    expect(isJournalRewindSource(readJournal([{ turnId: 't0', userItemId: 'm0' }]), 's')).toBe(true)
    expect(isJournalRewindSource(undefined, 's')).toBe(false)
    expect(isJournalRewindSource(() => null, 's')).toBe(false)
    const damaged = { ...journalWith([]), damage: 'corrupt' }
    expect(isJournalRewindSource(() => damaged, 's')).toBe(false)
    const newer = { ...journalWith([]), newer: { items: [] } }
    expect(isJournalRewindSource(() => newer, 's')).toBe(false)
    expect(
      isJournalRewindSource(() => {
        throw new Error('gone')
      }, 's')
    ).toBe(false)
  })
})
