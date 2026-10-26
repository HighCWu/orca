// The text a ZCode `session/send` takes from a journal message: its prose blocks, joined.
// Attachments, tool blocks and host-only metadata are not part of a send.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'

/** Null when the body carries no text at all, which the chat rejects rather than sending empty. */
export function textOfMessageBody(body: AgentJournalMessageItem): string | null {
  const text = body.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length > 0 ? text : null
}
