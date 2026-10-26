import { describe, expect, it, vi } from 'vitest'
import { ZcodeChildRegistryActions } from './zcode-child-registry-actions'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import { ZcodeStructuredPrompts } from './zcode-structured-prompts'

function connection(): ZcodeAgentConnection {
  return {
    request: vi.fn(async () => ({})),
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

function child(): ZcodeStructuredChild {
  return {
    sessionId: 'session-1',
    fence: 1,
    acquisitionGeneration: 'generation-1',
    connection: connection(),
    prompts: new ZcodeStructuredPrompts(
      () => null,
      () => false
    ),
    lane: null,
    resume: null,
    providerSessionId: 'provider-1',
    currentModel: null,
    currentSelection: null,
    currentEffort: null,
    contextWindow: null,
    slashCommands: null,
    modelOptions: null,
    optionRestoreFailures: new Set(),
    launch: { cwd: '/workspace', workspaceId: 'workspace-1', env: {} },
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    closeRequested: false,
    v4Channel: null,
    open: vi.fn(async () => ({ reportedOptions: {} })),
    dispose: vi.fn()
  }
}

describe('zcode structured reacquire', () => {
  it('still closes the provider process after the session has ended', async () => {
    const retained = child()
    retained.ended = true
    const children = new Map([[retained.sessionId, retained]])
    const actions = new ZcodeChildRegistryActions(children, new Map(), {
      resolveLaunch: vi.fn(async () => {
        throw new Error('unused')
      })
    })

    await expect(actions.closeChild(retained.sessionId)).resolves.toBe(true)

    expect(retained.connection.close).toHaveBeenCalledOnce()
    expect(children.has(retained.sessionId)).toBe(false)
  })

  it('publishes process exit after the provider session already ended', () => {
    const retained = child()
    retained.ended = true
    const onEvent = vi.fn()
    const actions = new ZcodeChildRegistryActions(
      new Map([[retained.sessionId, retained]]),
      new Map(),
      {
        resolveLaunch: vi.fn(async () => {
          throw new Error('unused')
        }),
        onEvent
      }
    )

    actions.finishChild(retained)

    expect(retained.journalClosed).toBeInstanceOf(Error)
    expect(retained.dispose).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ended' }))
  })

  it('marks the replaced child as a requested close before stopping it', async () => {
    const retained = child()
    const actions = new ZcodeChildRegistryActions(
      new Map([[retained.sessionId, retained]]),
      new Map(),
      {
        resolveLaunch: vi.fn(async () => {
          throw new Error('unused')
        })
      }
    )

    await expect(actions.stopRequestedChild(retained)).resolves.toBe(true)

    expect(retained.connection.close).toHaveBeenCalledOnce()
    expect(retained.closeRequested).toBe(true)
  })

  it('releases the stopped child before a replacement launch can fail', async () => {
    const retained = child()
    const children = new Map([[retained.sessionId, retained]])
    const actions = new ZcodeChildRegistryActions(children, new Map(), {
      resolveLaunch: vi.fn(async () => {
        throw new Error('unused')
      })
    })

    await expect(actions.stopRequestedChild(retained)).resolves.toBe(true)

    expect(children.has(retained.sessionId)).toBe(false)
  })

  it('copies the provider session named by the copy request, not the current handle head', async () => {
    const retained = child()
    retained.connection.request = vi.fn(async () => ({ forkedSessionId: 'provider-copy' }))
    const actions = new ZcodeChildRegistryActions(
      new Map([[retained.sessionId, retained]]),
      new Map(),
      {
        resolveLaunch: vi.fn(async () => {
          throw new Error('unused')
        })
      }
    )

    await expect(
      actions.copyConversation({
        identity: {
          sessionId: retained.sessionId,
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'zcode',
          providerHandle: {
            transport: 'zcode',
            agent: 'zcode',
            nativeId: 'provider-current-head'
          }
        },
        providerSessionId: 'provider-copy-source',
        accountHome: { variable: 'ZCODE_DATA_BASE_DIR', path: '/account' }
      })
    ).resolves.toEqual({ sessionId: 'provider-copy' })
    expect(retained.connection.request).toHaveBeenCalledWith('session/fork', {
      sessionId: 'provider-copy-source',
      target: { kind: 'latestCheckpoint' }
    })
  })

  it('strips inherited structured-session identity from a scratch copy child', async () => {
    const opened = connection()
    opened.request = vi.fn(async () => ({ forkedSessionId: 'provider-copy' }))
    const connect = vi.fn(() => opened)
    const actions = new ZcodeChildRegistryActions(new Map(), new Map(), {
      resolveLaunch: vi.fn(async () => {
        throw new Error('unused')
      }),
      resolveInvocation: vi.fn(async () => ({
        command: 'zcode',
        args: ['app-server'],
        env: { ZCODE_DATA_BASE_DIR: '/account' },
        envToDelete: ['ORCA_PANE_KEY']
      })),
      connect
    })

    await expect(
      actions.copyConversation({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'zcode',
          providerHandle: null
        },
        providerSessionId: 'provider-copy-source',
        accountHome: { variable: 'ZCODE_DATA_BASE_DIR', path: '/account' }
      })
    ).resolves.toEqual({ sessionId: 'provider-copy' })
    expect(connect).toHaveBeenCalledWith(
      {
        command: 'zcode',
        args: ['app-server'],
        env: { ZCODE_DATA_BASE_DIR: '/account' },
        envToDelete: ['ORCA_PANE_KEY']
      },
      {}
    )
    expect(opened.close).toHaveBeenCalledOnce()
  })

  it('does not let an old close delete a replacement child', async () => {
    const retained = child()
    let finishClose: ((stopped: boolean) => void) | undefined
    retained.connection.close = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishClose = resolve
        })
    )
    const children = new Map([[retained.sessionId, retained]])
    const actions = new ZcodeChildRegistryActions(children, new Map(), {
      resolveLaunch: vi.fn(async () => {
        throw new Error('unused')
      })
    })

    const closing = actions.closeChild(retained.sessionId, true)
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'))
    const replacement = child()
    replacement.acquisitionGeneration = 'generation-2'
    children.set(replacement.sessionId, replacement)
    finishClose?.(true)

    await expect(closing).resolves.toBe(true)
    expect(children.get(retained.sessionId)).toBe(replacement)
  })
})
