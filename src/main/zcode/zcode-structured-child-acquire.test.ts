import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ZcodeAgentConnection,
  ZcodeAgentConnectionOptions,
  ZcodeRequestContext
} from './zcode-protocol-connection'
import { AgentSessionAcquisitionExitProvenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { acquireZcodeStructuredSession } from './zcode-structured-child'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function eventSink(): StructuredAgentSessionEventSink {
  return {
    appendItem: () => undefined,
    appendTombstone: () => undefined,
    publish: () => undefined,
    tryAppendTransition: () => ({ accepted: true }),
    journalItems: () => null
  }
}

function connection(): ZcodeAgentConnection {
  return {
    request: vi.fn(async () => ({})),
    respond: vi.fn(),
    respondError: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    probe: vi.fn(async () => undefined),
    spawned: Promise.resolve(),
    pid: 123,
    exited: false,
    stderrTail: () => '',
    onExit: vi.fn(),
    close: vi.fn(async () => true)
  }
}

describe('zcode structured child acquisition', () => {
  it('preserves an exit-proven child failure through the adapter boundary', async () => {
    const opened = connection()
    Object.defineProperty(opened, 'exited', { get: () => true })
    const adapter = new ZcodeStructuredSessionAdapter({
      connect: () => opened,
      resolveLaunch: vi.fn(async () => ({
        command: 'zcode',
        args: ['app-server'],
        cwd: '/workspace',
        env: {},
        envToDelete: [],
        resume: null
      })),
      readProcessStartTime: async () => 1_000
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'zcode',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'spawn-1',
        events: eventSink()
      })
    ).rejects.toBeInstanceOf(AgentSessionAcquisitionExitProvenError)
  })

  it('reports a process that exited before acquisition returned as exit-proven', async () => {
    const opened = connection()
    Object.defineProperty(opened, 'exited', { get: () => true })

    await expect(
      acquireZcodeStructuredSession({
        acquire: {
          identity: {
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'zcode',
            providerHandle: null
          },
          fence: 1,
          spawnToken: 'spawn-1',
          events: eventSink()
        },
        launch: {
          command: 'zcode',
          args: ['app-server'],
          cwd: '/workspace',
          env: {},
          envToDelete: [],
          resume: null
        },
        deps: {
          connect: () => opened,
          readProcessStartTime: async () => 1_000
        },
        generation: 'generation-1',
        abandoned: () => false,
        onExit: vi.fn(),
        onConnectionLost: vi.fn(),
        forceClose: vi.fn()
      })
    ).rejects.toBeInstanceOf(AgentSessionAcquisitionExitProvenError)
  })

  it('silently settles a reverse prompt the server resolved itself', async () => {
    let callbacks: ZcodeAgentConnectionOptions | undefined
    const opened = connection()
    vi.mocked(opened.request).mockImplementation(async (method) => {
      if (method === 'session/create') {
        return {
          protocol: { name: 'ZCode Protocol', version: 1 },
          session: { sessionId: 'provider-1' },
          settings: {},
          projection: { turnCount: 0 },
          slashCommands: []
        }
      }
      if (method === 'session/subscribe') {
        return { sessionId: 'provider-1', eventSeq: 0, events: [] }
      }
      if (method === 'v4/conversation/subscribe') {
        throw new Error('Method not found')
      }
      return {}
    })
    const acquired = await acquireZcodeStructuredSession({
      acquire: {
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'zcode',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'spawn-1',
        events: eventSink()
      },
      launch: {
        command: 'zcode',
        args: ['app-server'],
        cwd: '/workspace',
        env: {},
        envToDelete: [],
        resume: null
      },
      deps: {
        connect: (_launch, options) => {
          callbacks = options
          return opened
        },
        readProcessStartTime: async () => 1_000
      },
      generation: 'generation-1',
      abandoned: () => false,
      onExit: vi.fn(),
      onConnectionLost: vi.fn(),
      forceClose: vi.fn()
    })
    await acquired.child.open({
      sessionId: 'session-1',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      signal: new AbortController().signal
    })
    const settle = vi.fn()
    const context: ZcodeRequestContext = {
      id: 'server-1',
      respond: vi.fn(),
      respondError: vi.fn(),
      settle,
      signal: new AbortController().signal
    }
    callbacks?.onRequest?.(
      'interaction/requestPermission',
      {
        requestId: 'perm-1',
        sessionId: 'provider-1',
        options: [{ optionId: 'deny', kind: 'deny_once', response: { decision: 'deny' } }]
      },
      context
    )
    expect(acquired.child.prompts.size).toBe(1)

    callbacks?.onNotification?.('session/event', {
      sessionId: 'provider-1',
      type: 'permission.resolved',
      payload: { requestId: 'perm-1', decision: 'deny' }
    })
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())

    expect(acquired.child.prompts.size).toBe(0)
    expect(context.respond).not.toHaveBeenCalled()
  })

  it('answers provider runtime auth from the launch account home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'zcode-child-runtime-auth-'))
    tempDirs.push(home)
    const v2 = join(home, '.zcode', 'v2')
    mkdirSync(v2, { recursive: true })
    writeFileSync(
      join(v2, 'provider_config.json'),
      JSON.stringify({ schemaVersion: 1, config: {} })
    )
    writeFileSync(
      join(v2, 'credentials.json'),
      JSON.stringify({
        'oauth:active_provider': 'bigmodel',
        'oauth:bigmodel:user_info': JSON.stringify({ id: 'account-1' }),
        'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:account-1:api-key':
          'plan-key'
      })
    )
    let callbacks: ZcodeAgentConnectionOptions | undefined
    const opened = connection()
    vi.mocked(opened.request).mockImplementation(async (method) => {
      if (method === 'session/create') {
        return {
          protocol: { name: 'ZCode Protocol', version: 1 },
          session: { sessionId: 'provider-1' },
          settings: {},
          projection: { turnCount: 0 },
          slashCommands: []
        }
      }
      if (method === 'session/subscribe') {
        return { sessionId: 'provider-1', eventSeq: 0, events: [] }
      }
      if (method === 'v4/conversation/subscribe') {
        throw new Error('Method not found')
      }
      return {}
    })
    const acquired = await acquireZcodeStructuredSession({
      acquire: {
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'zcode',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'spawn-1',
        events: eventSink()
      },
      launch: {
        command: 'zcode',
        args: ['app-server'],
        cwd: '/workspace',
        env: { HOME: home, ZCODE_DATA_BASE_DIR: home },
        envToDelete: [],
        resume: null
      },
      deps: {
        connect: (_launch, options) => {
          callbacks = options
          return opened
        },
        readProcessStartTime: async () => 1_000
      },
      generation: 'generation-1',
      abandoned: () => false,
      onExit: vi.fn(),
      onConnectionLost: vi.fn(),
      forceClose: vi.fn()
    })
    await acquired.child.open({
      sessionId: 'session-1',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      signal: new AbortController().signal
    })
    const respond = vi.fn()
    callbacks?.onRequest?.(
      'interaction/requestProviderRuntimeHeaders',
      {
        requestId: 'auth-1',
        sessionId: 'provider-1',
        workspace: { workspacePath: '/workspace', workspaceKey: 'workspace-1' },
        providerId: 'account:bigmodel-individual-coding-plan',
        modelSelection: {
          providerId: 'account:bigmodel-individual-coding-plan',
          modelId: 'GLM-5.3'
        },
        reason: 'model_request'
      },
      {
        id: 'server-1',
        respond,
        respondError: vi.fn(),
        settle: vi.fn(),
        signal: new AbortController().signal
      }
    )
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        headersApplied: true,
        requestAuth: { apiKey: 'plan-key' }
      })
    )
  })

  it('closes a spawned connection when process identity cannot be proven', async () => {
    const opened = connection()

    await expect(
      acquireZcodeStructuredSession({
        acquire: {
          identity: {
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'zcode',
            providerHandle: null
          },
          fence: 1,
          spawnToken: 'spawn-1',
          events: eventSink()
        },
        launch: {
          command: 'zcode',
          args: ['app-server'],
          cwd: '/workspace',
          env: {},
          envToDelete: [],
          resume: null
        },
        deps: {
          connect: () => opened,
          readProcessStartTime: async () => null
        },
        generation: 'generation-1',
        abandoned: () => false,
        onExit: vi.fn(),
        onConnectionLost: vi.fn(),
        forceClose: vi.fn()
      })
    ).rejects.toThrow('start time')

    expect(opened.close).toHaveBeenCalledOnce()
  })
})
