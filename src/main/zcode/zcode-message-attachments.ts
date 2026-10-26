// The attachments a `session/send` takes from a journal message: path-based images, mapped to
// the protocol's prompt attachment shape (kind/filename/localPath) at the boundary.

import { basename, extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'

export type ZcodeSendAttachment = {
  kind: 'image'
  filename: string
  localPath: string
  mimeType?: string
}

/** Null-when-empty mirrors the send guard: text still carries the turn, images ride beside it. */
export function zcodeAttachmentsOf(body: AgentJournalMessageItem): ZcodeSendAttachment[] {
  const attachments: ZcodeSendAttachment[] = []
  for (const block of body.blocks) {
    if (block.type !== 'image-ref' || !block.path) {
      continue
    }
    attachments.push({
      kind: 'image',
      filename: basename(block.path),
      localPath: block.path,
      ...(block.alt?.startsWith('image/') ? { mimeType: block.alt } : {})
    })
  }
  return attachments
}

/** The image mime an extension implies; the protocol requires a `type/subtype` mime and the
 *  journal image blocks usually carry one in their alt text. PNG is the honest default for
 *  screenshots, which is what flows through Orca's composer. */
export function zcodeImageMimeOf(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'image/png'
  }
}
