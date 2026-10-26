// The `session/subagents` table folded into the child-work evidence vocabulary the host's
// subagent roster consumes. Repeated polls of an unchanged table publish nothing.

import type { z } from 'zod'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { zcodeSessionSubagentSchema } from './zcode-protocol-messages'
import { zcodeSessionSubagentsResultSchema } from './zcode-protocol-messages'

type ZcodeSessionSubagent = z.infer<typeof zcodeSessionSubagentSchema>

const OUTCOMES = {
  success: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  lost: 'unknown'
} as const

const LIVE_STATES = {
  running: 'working',
  waiting: 'waiting',
  blocked: 'blocked'
} as const

/** Whether a row is still live; absent status reads live, matching the runtime's own reports. */
function isTerminal(status: ZcodeSessionSubagent['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled' || status === 'lost'
}

export class ZcodeSubagentEvidence {
  private fingerprint = '[]'

  /** The edges this table now implies, or null when it is unchanged or unreadable. */
  observe(result: unknown, observedAt: number): AgentChildWorkEvidence[] | null {
    const parsed = zcodeSessionSubagentsResultSchema.safeParse(result)
    if (!parsed.success) {
      return null
    }
    const rows = [...(parsed.data.running ?? []), ...(parsed.data.ended?.items ?? [])]
    const fingerprint = JSON.stringify(rows)
    if (fingerprint === this.fingerprint) {
      return null
    }
    this.fingerprint = fingerprint
    return rows.map((row) => edgeOf(row, observedAt))
  }
}

function edgeOf(row: ZcodeSessionSubagent, observedAt: number): AgentChildWorkEvidence {
  const handle = { idKind: 'thread_id' as const, id: row.childSessionId }
  const name = row.title ?? row.subagentType
  if (isTerminal(row.status)) {
    return {
      type: 'ended',
      observedAt,
      handle,
      outcome: OUTCOMES[row.status ?? 'lost'],
      ...(row.summary ? { lastMessage: row.summary } : {})
    }
  }
  return {
    type: 'live',
    observedAt,
    child: {
      handle,
      kind: 'agent',
      residency: 'background',
      state: LIVE_STATES[row.status ?? 'running'],
      ...(name ? { name } : {}),
      ...(row.summary ? { description: row.summary } : {}),
      // Why: the subagents table names no cancel handle — `session/cancelBackgroundTask`
      // takes task ids — so no stoppable claim is made until one is proven.
      stoppable: false
    }
  }
}
