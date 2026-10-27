import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import { ZcodeAtRestCommandCatalog } from './zcode-at-rest-commands'

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

describe('zcode at-rest command catalog', () => {
  it('launches the scratch app-server in the resolved workspace directory', async () => {
    const request = vi.fn(async () => ({ slashCommands: [] }))
    const connected = connection(request)
    const connect = vi.fn(() => connected)
    const catalog = new ZcodeAtRestCommandCatalog({
      resolveWorkspacePath: async () => '/workspace/folder',
      resolveInvocation: async () => ({
        command: 'zcode',
        args: ['app-server'],
        env: { ZCODE_DATA_BASE_DIR: '/account' },
        envToDelete: ['ORCA_PANE_KEY']
      }),
      connect
    })
    const base = agentSessionRecordFixture()
    const record = {
      ...base,
      provider: 'zcode' as const,
      accountHome: { variable: 'ZCODE_DATA_BASE_DIR' as const, path: '/account' },
      location: { ...base.location, workspaceId: 'workspace-key' }
    }

    catalog.read(record)
    await vi.waitFor(() => expect(connect).toHaveBeenCalled())

    expect(connect).toHaveBeenCalledWith({
      command: 'zcode',
      args: ['app-server'],
      env: { ZCODE_DATA_BASE_DIR: '/account' },
      envToDelete: ['ORCA_PANE_KEY'],
      cwd: '/workspace/folder'
    })
    expect(request).toHaveBeenCalledWith('workspace/readPresentation', {
      workspace: { workspacePath: '/workspace/folder', workspaceKey: 'workspace-key' }
    })
    expect(connected.close).toHaveBeenCalled()
  })
})
