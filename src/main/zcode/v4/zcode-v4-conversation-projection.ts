// Translates ZCode v4 conversation frames into the provider timeline grammar the journal
// lane consumes. Watermark and revision bookkeeping live here so a reconnect can resume
// from `watermark()` and phase-3 commands can CAS on `revision()`.
//
// Snapshot frames carry the session's whole row history. Orca's journal already owns that
// history (its own replay), so snapshot frames only seed the watermark and state — the
// context-usage seed and `snapshotRows()` for restart reconciliation. Live deltas
// translate fully, mirroring the v3 translator's grammar:
//   turnHeader running/terminal  → turn.open / turn.end
//   userInput                    → input.accepted (keyed on the v4 sourceCommandId)
//   assistantText / reasoning    → text.delta (suffix-tracked per row)
//   toolCall status machine      → item.open / item.close
//   state.usage                  → context.usage
//   state.control.apiRetry       → activity line (the v3 streamRecovery analog)

import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import { zcodeV4ConversationLogicalFrameSchema } from './zcode-v4-conversation-frames'
import type {
  ZcodeV4ConversationDelta,
  ZcodeV4ConversationRow,
  ZcodeV4ConversationSnapshot,
  ZcodeV4StatePatch
} from './zcode-v4-conversation-frames'
import { BoundedMap } from '../../../shared/bounded-map'
import { ZcodeV4RowEvents } from './zcode-v4-row-events'

export type ZcodeV4TranslatorOptions = {
  now: () => number
  /** The session's context-window size, when the host knows it. */
  contextWindow?: () => number | null
}

export class ZcodeV4ConversationTranslator {
  private readonly rows = new Map<number, ZcodeV4ConversationRow>()
  private readonly acceptedInputIds = new BoundedMap<string, true>({ maxEntries: 256 })
  /** Orca's own admitted send, mirroring the v3 translator's pending prompt: the first
   *  userInput row after `openPrompt` settles that dispatch, whatever id the row carries. */
  private pending?: { clientMessageId: string; requestedAt: number }
  private readonly rowEvents: ZcodeV4RowEvents
  private logEpoch: string | null = null
  private seq = 0
  private revisionValue: number | undefined
  private providerSessionId: string

  constructor(
    private readonly options: ZcodeV4TranslatorOptions,
    providerSessionId: string
  ) {
    this.providerSessionId = providerSessionId
    this.rowEvents = new ZcodeV4RowEvents(providerSessionId)
  }

  /** Records Orca's in-flight send; `dropPrompt` forgets a send the provider refused. */
  openPrompt(clientMessageId: string, requestedAt: number): void {
    this.pending = { clientMessageId, requestedAt }
  }

  dropPrompt(): void {
    this.pending = undefined
  }

  hasPendingPrompt(): boolean {
    return this.pending !== undefined
  }

  /** The in-flight send's id, for the host's held-send accounting; null with none. */
  get pendingPromptId(): string | null {
    return this.pending?.clientMessageId ?? null
  }

  watermark(): { logEpoch: string | null; seq: number } {
    return { logEpoch: this.logEpoch, seq: this.seq }
  }

  revision(): number | undefined {
    return this.revisionValue
  }

  seedLogEpoch(logEpoch: string): void {
    if (this.logEpoch === null) {
      this.logEpoch = logEpoch
    }
  }

  /** The rows the initial snapshot carried, newest last — restart reconciliation's read
   *  of what the provider recorded, replacing the v3 providerHistoryWindow scratch read. */
  snapshotRows(): readonly ZcodeV4ConversationRow[] {
    return Array.from(this.rows.values()).sort((left, right) => left.rowId - right.rowId)
  }

  /** The fork target for a rewind that cuts before `cutTurnId`: the CLI attaches a fork at
   *  a turn's last assistant segment, so the target is the last assistant row of the last
   *  turn BEFORE the cut. Null when the cut opens the conversation (nothing kept) or no
   *  previous turn carries an assistant row — the CLI would refuse either way. */
  forkTargetBeforeTurn(
    cutTurnId: string,
    rows: readonly ZcodeV4ConversationRow[] = this.snapshotRows()
  ): { rowId: number; entityId?: string } | null {
    const ordered = [...rows].sort((left, right) => left.rowId - right.rowId)
    const cutStart = ordered.find((row) => row.turnId === cutTurnId)
    if (!cutStart) {
      return null
    }
    let target: ZcodeV4ConversationRow | null = null
    for (const row of ordered) {
      if (row.rowId >= cutStart.rowId) {
        break
      }
      if (row.kind === 'assistantText' && row.state !== 'streaming') {
        target = row
      }
    }
    if (!target?.entityId) {
      return null
    }
    return { rowId: target.rowId, entityId: target.entityId }
  }

  apply(value: unknown): ProviderTimelineEvent[] {
    const frame = zcodeV4ConversationLogicalFrameSchema.safeParse(value)
    if (!frame.success) {
      return []
    }
    // Delta envelopes carry only the seq; the epoch travels on snapshots (including a
    // resync's, which is how an epoch roll after a compact or fork reaches this projection).
    this.seq = frame.data.toSeq
    if (typeof frame.data.logEpoch === 'string' && frame.data.logEpoch) {
      this.logEpoch = frame.data.logEpoch
    }
    const at = this.options.now()
    if (frame.data.payload.kind === 'snapshot') {
      return this.applySnapshot(frame.data.payload.snapshot, at)
    }
    const events: ProviderTimelineEvent[] = []
    for (const delta of frame.data.payload.deltas) {
      if (delta.op === 'state.updated' && delta.patch.control?.lastError !== undefined) {
        this.rowEvents.setLastError(delta.patch.control.lastError)
      }
    }
    for (const delta of frame.data.payload.deltas) {
      events.push(...this.applyDelta(delta, at))
    }
    return events
  }

  private applySnapshot(
    snapshot: ZcodeV4ConversationSnapshot,
    at: number
  ): ProviderTimelineEvent[] {
    this.logEpoch = snapshot.logEpoch
    this.seq = snapshot.seq
    this.revisionValue = snapshot.revision ?? this.revisionValue
    this.rows.clear()
    this.rowEvents.resetForSnapshot()
    for (const row of snapshot.rows) {
      this.rows.set(row.rowId, row)
      this.rowEvents.seedSnapshotRow(row)
    }
    const events: ProviderTimelineEvent[] = []
    if (snapshot.usage) {
      events.push(this.rowEvents.usageEvent(snapshot.usage, at))
    }
    return events
  }

  private applyDelta(delta: ZcodeV4ConversationDelta, at: number): ProviderTimelineEvent[] {
    switch (delta.op) {
      case 'row.appended':
      case 'row.upserted': {
        this.rows.set(delta.row.rowId, delta.row)
        return this.translateRow(delta.row, at)
      }
      case 'row.removed': {
        for (const rowId of Array.from(this.rows.keys())) {
          if (rowId >= delta.fromRowId) {
            this.rows.delete(rowId)
          }
        }
        this.rowEvents.removeRowsFrom(delta.fromRowId)
        return []
      }
      case 'row.delta':
        return this.applyRowDelta(delta.rowId, delta.path, delta.append)
      case 'state.updated':
        return this.applyStatePatch(delta.patch, at)
      case 'pluginUi.resourceUpdated':
      case 'pluginUi.resourceListChanged':
      case 'pluginUi.instanceClosed':
      case 'pluginUi.appToolCall':
      case 'workflowRun.updated':
      case 'workflowRun.removed':
        return []
    }
  }

  private applyRowDelta(rowId: number, path: string, append: string): ProviderTimelineEvent[] {
    const row = this.rows.get(rowId)
    if (!row || append.length === 0) {
      return []
    }
    if (path === 'text' && (row.kind === 'assistantText' || row.kind === 'reasoning')) {
      this.rows.set(rowId, { ...row, text: (row.text ?? '') + append })
      this.rowEvents.noteTextDelta(rowId, append.length)
      return [this.rowEvents.textDelta(row, append)]
    }
    if (path === 'inputText' && row.kind === 'toolCall') {
      const inputText = typeof row.input === 'string' ? row.input : ''
      this.rows.set(rowId, { ...row, input: inputText + append })
      return []
    }
    if (path === 'output.text' && row.kind === 'toolCall') {
      const outputText = typeof row.output === 'string' ? row.output : ''
      this.rows.set(rowId, { ...row, output: outputText + append })
      return []
    }
    if (path === 'summaryText' && row.kind === 'subagent') {
      this.rows.set(rowId, { ...row, summaryText: (row.summaryText ?? '') + append })
    }
    return []
  }

  private applyStatePatch(patch: ZcodeV4StatePatch, at: number): ProviderTimelineEvent[] {
    const events: ProviderTimelineEvent[] = []
    if (patch.revision !== undefined) {
      this.revisionValue = patch.revision
    }
    if (patch.usage) {
      events.push(this.rowEvents.usageEvent(patch.usage, at))
    }
    if (patch.backgroundWorks) {
      events.push(...this.rowEvents.backgroundWorkEvents(patch.backgroundWorks))
    }
    const control = patch.control
    if (control?.lastError !== undefined) {
      this.rowEvents.setLastError(control.lastError)
    }
    if (control?.apiRetry !== undefined) {
      const retry = control.apiRetry
      events.push({
        type: 'activity',
        text:
          retry === null
            ? null
            : `Model stream interrupted — re-requesting (retry ${retry.attempt ?? '?'}${
                retry.maxAttempts !== undefined ? `/${retry.maxAttempts}` : ''
              })`
      })
    }
    // `control.sessionEnded` is DERIVED (phase ∈ completed*), so it is true after every
    // finished turn — Orca's child stays for the next send, so it never settles the session.
    // The lane assembler's own session.ended handling settles open turns on process exit.
    return events
  }

  private translateRow(row: ZcodeV4ConversationRow, at: number): ProviderTimelineEvent[] {
    switch (row.kind) {
      case 'turnHeader':
        return this.rowEvents.translateTurnHeader(row, at)
      case 'userInput': {
        const pending = this.pending
        if (row.origin !== undefined && row.origin !== 'realUser' && !pending) {
          return []
        }
        // The CLI upserts the input row more than once per send; the first admission wins.
        const rowId = row.sourceCommandId ?? `v4row-${row.rowId}`
        if (this.acceptedInputIds.has(rowId)) {
          return []
        }
        this.acceptedInputIds.set(rowId, true)
        // Orca's own dispatch identity wins: the row's sourceCommandId is whatever the
        // submitting client passed, which a legacy v3 send does not project.
        this.pending = undefined
        const clientMessageId = pending?.clientMessageId ?? rowId
        return [
          {
            type: 'input.accepted',
            clientMessageId,
            requestedAt: pending?.requestedAt ?? row.createdAt,
            join: { thread: this.providerSessionId, ...(row.turnId ? { turn: row.turnId } : {}) }
          }
        ]
      }
      case 'assistantText':
      case 'reasoning': {
        const suffix = this.rowEvents.unemittedSuffix(row)
        return suffix.length === 0 ? [] : [this.rowEvents.textDelta(row, suffix)]
      }
      case 'toolCall':
        return this.rowEvents.translateToolCall(row)
      case 'subagent':
        this.rowEvents.collectSubagentEvidence(row, at)
        return []
      default:
        // artifact / hookInvocation / timelineMarker / newer kinds: the journal grammar
        // has no slot yet; the rows stay in the projection for later phases.
        return []
    }
  }

  /** Pops the child-work evidence the subagent rows accumulated since the last drain. */
  drainChildWorkEvidence(): AgentChildWorkEvidence[] {
    return this.rowEvents.drainChildWorkEvidence()
  }
}
