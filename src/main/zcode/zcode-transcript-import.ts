// Adopting a conversation the zcode CLI recorded: the account's store is its session database
// (the same one an app-server resumes from), and the shared sqlite worker answers whether a
// session id exists in it.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readOpenCodeTranscriptSignalViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { directoryTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const ZCODE_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  // The pinned ZCODE_DATA_BASE_DIR keeps every store on one base; the db sits under its .zcode.
  conversationStore: ({ accountHomePath }) =>
    join(accountHomePath, '.zcode', 'cli', 'db', 'db.sqlite'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store }) => {
    try {
      if (!(await stat(store)).isFile()) {
        return null
      }
    } catch {
      return null
    }
    const signal = await readOpenCodeTranscriptSignalViaWorker({
      dbPath: store,
      sessionId: providerSessionId,
      agent: 'zcode'
    })
    return signal ? store : null
  }
})
