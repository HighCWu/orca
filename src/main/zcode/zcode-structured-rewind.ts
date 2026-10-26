// The journal-side arithmetic of a fork-based rewind: which turn the cut names, and the fork
// target index it becomes. zcode numbers turns from the conversation's start and a fork copies
// that history forward, so the journal's turn order and zcode's stay the same sequence.

import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'

/** The journal shape the count reads: the real load satisfies it, and so does a test double. */
export type ZcodeRewindJournal = {
  damage: unknown
  newer: unknown
  state: { items: Map<string, { body: AgentJournalItemBody }> }
}

/** How many turns the conversation kept before `cutTurnId`, from the journal's turn order; null
 *  when the journal is unreadable or the cut turn is not in it. */
export function countKeptTurns(
  readJournal: ((sessionId: string) => ZcodeRewindJournal | null) | undefined,
  sessionId: string,
  cutTurnId: string
): number | null {
  if (!readJournal) {
    return null
  }
  let load: ZcodeRewindJournal | null
  try {
    load = readJournal(sessionId)
  } catch {
    return null
  }
  if (!load || load.damage || load.newer) {
    return null
  }
  let count = 0
  for (const item of load.state.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      continue
    }
    // zcode numbers a fork target's turns the way its own resolver does: user-opened turns only
    // (resolveTurnMessageId counts user messages as the boundaries). Command turns (/compact) and
    // provider-initiated ones (a goal the agent pursues) never open one and must not be counted.
    if (turn.userItemId === undefined) {
      continue
    }
    const turnId = turn.providerTurnId ?? turn.turnId
    if (turnId === cutTurnId) {
      return count
    }
    count += 1
  }
  return null
}

/** Whether the journal can count a fork target's turns at all: the source a rewind cuts from.
 *  `rewindSupport` answers this without a cut, so the UI narrows before any turn is named. */
export function isJournalRewindSource(
  readJournal: ((sessionId: string) => ZcodeRewindJournal | null) | undefined,
  sessionId: string
): boolean {
  if (!readJournal) {
    return false
  }
  try {
    const load = readJournal(sessionId)
    return load !== null && !load.damage && !load.newer
  } catch {
    return false
  }
}

/** `session/fork`'s turn target is an exclusive boundary — turns 0..turnIndex-1 are kept
 *  (verified against the official runtime) — which is exactly the number of turns the journal
 *  keeps before the cut. */
export function zcodeRewindTurnIndex(keptTurnCount: number | null): number | null {
  return keptTurnCount ?? null
}
