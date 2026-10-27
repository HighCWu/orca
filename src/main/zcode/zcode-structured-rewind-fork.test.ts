import { describe, expect, it, vi } from 'vitest'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import { forkZcodeForRewind } from './zcode-structured-rewind-fork'

const PROVIDER_HANDLE = {
  transport: 'zcode-app-server',
  agent: 'zcode' as const,
  nativeId: 'provider-1'
}

function rewind(launchDirectory?: string) {
  return {
    record: {
      sessionId: 'session-1',
      providerHandleChain: [
        {
          linkId: 'link-1',
          handle: PROVIDER_HANDLE,
          origin: 'created' as const,
          mintedAtFence: 1,
          observedAt: 1
        }
      ],
      accountHome: { variable: 'ZCODE_DATA_BASE_DIR', path: '/account' },
      ...(launchDirectory ? { launchDirectory } : {}),
      location: { workspaceId: 'workspace-key' }
    },
    beforeMessage: { uuid: 'turn-1' }
  }
}

function readJournal() {
  const state = createJournalReducerState('session-1', 'epoch-1')
  state.items.set('turn-row-0', {
    itemId: 'turn-row-0',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'turn',
      turnId: 'turn-0',
      userItemId: 'message-0',
      state: 'completed'
    }
  })
  state.items.set('turn-row-1', {
    itemId: 'turn-row-1',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      userItemId: 'message-1',
      state: 'completed'
    }
  })
  return { state, damage: null, newer: null, empty: false }
}

function connection(request: ZcodeAgentConnection['request']): ZcodeAgentConnection {
  return {
    request,
    respond: vi.fn(),
    respondError: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    probe: vi.fn(async () => {}),
    spawned: Promise.resolve(),
    pid: undefined,
    exited: false,
    stderrTail: () => '',
    onExit: vi.fn(),
    close: vi.fn(async () => true)
  }
}

describe('zcode rewind scratch workspace', () => {
  it('does not launch without a resolved workspace path', async () => {
    const connect = vi.fn()
    const resolveInvocation = vi.fn()

    await expect(
      forkZcodeForRewind({
        rewind: rewind(),
        children: new Map(),
        deps: { readJournal, connect, resolveInvocation }
      })
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })

    expect(resolveInvocation).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('uses the launch directory as cwd and keeps the workspace id as a key', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'session/fork'
        ? { forkedSessionId: 'provider-fork', snapshot: { projection: { turnCount: 1 } } }
        : { session: { sessionId: 'provider-1' } }
    )
    const connect = vi.fn(() => connection(request))

    await expect(
      forkZcodeForRewind({
        rewind: rewind('/workspace/folder'),
        children: new Map(),
        deps: {
          readJournal,
          connect,
          resolveInvocation: vi.fn(async () => ({
            command: 'zcode',
            args: [],
            env: {},
            envToDelete: ['ORCA_PANE_KEY']
          }))
        }
      })
    ).resolves.toMatchObject({ ok: true, fork: { sessionId: 'provider-fork' } })

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace/folder', envToDelete: ['ORCA_PANE_KEY'] }),
      {}
    )
    expect(request).toHaveBeenCalledWith('session/resume', {
      sessionId: 'provider-1',
      workspace: { workspacePath: '/workspace/folder', workspaceKey: 'workspace-key' }
    })
  })
})
