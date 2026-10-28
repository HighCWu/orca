import { describe, expect, it, vi } from 'vitest'
import { buildZcodeChildOpen, type ZcodeSessionOpenContext } from './zcode-structured-child-open'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'

const SNAPSHOT = {
  protocol: { name: 'ZCode Protocol', version: 1 },
  session: { sessionId: 'sess_v4' },
  settings: {
    model: {
      current: { providerId: 'bigmodel', modelId: 'GLM-5.3' },
      available: [{ ref: { providerId: 'bigmodel', modelId: 'GLM-5.3' }, label: 'GLM-5.3' }]
    },
    thoughtLevel: { current: 'high', available: [{ value: 'high', label: 'High' }] }
  },
  projection: { turnCount: 0 },
  slashCommands: []
}

function openContext(
  connection: Pick<ZcodeAgentConnection, 'request'>,
  openV4Channel?: ZcodeSessionOpenContext['openV4Channel'],
  resume?: ZcodeSessionOpenContext['child']['resume']
): { context: ZcodeSessionOpenContext; applied: unknown[][] } {
  const applied: unknown[][] = []
  // SAFETY: the fixture only builds the fields the open flow reads; the real child and
  // connection carry the full contract surface this file does not exercise.
  const context = {
    child: {
      sessionId: 'local-1',
      fence: 3,
      ...(resume ? { resume } : { resume: null }),
      providerSessionId: null,
      currentModel: null,
      currentEffort: null,
      contextWindow: null,
      modelOptions: null,
      slashCommands: [],
      launch: { cwd: '/w', env: { ZCODE_DATA_BASE_DIR: '/missing-zcode-test-home' } }
    },
    connection,
    makeLane: vi.fn(() => ({
      apply: vi.fn((events: unknown[]) => {
        applied.push(events)
      }),
      translator: { contextUsageSeedEvent: vi.fn((tokens: unknown) => ({ seed: tokens })) }
    })),
    reattachDone: vi.fn(),
    ...(openV4Channel ? { openV4Channel } : {})
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture only builds the fields the open flow reads.
    context: context as unknown as ZcodeSessionOpenContext,
    applied
  }
}

describe('zcode child open channel switch', () => {
  it('arms the v4 channel and skips the legacy subscription and its seed', async () => {
    const requested: string[] = []
    const connection = {
      request: vi.fn((_method: string, _params?: unknown) => {
        requested.push(_method)
        return Promise.resolve(SNAPSHOT)
      })
    }
    // The real armer installs the channel on the child itself; mimic that here.
    const armed = { armed: true }
    const openV4Channel = vi.fn(async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's channel is a marker; the open flow only carries the reference through.
      contextChild.v4Channel = armed as never
      return true
    })
    const { context, applied } = openContext(connection, openV4Channel)
    const contextChild = context.child
    const open = buildZcodeChildOpen(context)
    const result = await open(new AbortController().signal)

    expect(openV4Channel).toHaveBeenCalledWith('sess_v4')
    expect(requested).toEqual(['session/create'])
    expect(context.reattachDone).toHaveBeenCalled()
    // The armed channel survives the open: commands and frames both ride it.
    expect(contextChild.v4Channel).toBe(armed)
    // No usage seed: the v4 frame stream carries the usage state itself.
    expect(applied).toEqual([])
    expect(result.link?.handle.nativeId).toBe('sess_v4')
  })

  it('keeps the legacy subscription and usage seed when the channel is absent', async () => {
    const requested: string[] = []
    const connection = {
      request: vi.fn((method: string) => {
        requested.push(method)
        if (method === 'session/create') {
          return Promise.resolve({
            ...SNAPSHOT,
            runtime: { contextUsage: { used: 1_000, size: 200_000 } }
          })
        }
        return Promise.resolve({})
      })
    }
    const { context, applied } = openContext(connection)
    const open = buildZcodeChildOpen(context)
    await open(new AbortController().signal)

    expect(requested).toEqual(['session/create', 'session/subscribe'])
    expect(applied).toHaveLength(1)
  })

  it('falls back to the legacy subscription when the v4 arm answers false', async () => {
    const requested: string[] = []
    const connection = {
      request: vi.fn((method: string) => {
        requested.push(method)
        return Promise.resolve(SNAPSHOT)
      })
    }
    const openV4Channel = vi.fn(async () => false)
    const { context } = openContext(connection, openV4Channel)
    const open = buildZcodeChildOpen(context)
    await open(new AbortController().signal)

    expect(requested).toEqual(['session/create', 'session/subscribe'])
  })

  it('opens a fresh draft when the resume names a never-sent session the CLI lost', async () => {
    const requested: string[] = []
    const connections: string[] = []
    const connection = {
      request: vi.fn((method: string, params?: unknown) => {
        requested.push(method)
        if (method === 'session/resume') {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume request's only param the test reads is the session id.
          connections.push((params as { sessionId: string }).sessionId)
          return Promise.reject(
            new Error('ZCode agent request failed (-32004): Session not found: session_gone')
          )
        }
        return Promise.resolve(SNAPSHOT)
      })
    }
    const { context } = openContext(
      connection,
      vi.fn(async () => true),
      {
        sessionId: 'session_gone',
        key: 'session_gone'
      }
    )
    const open = buildZcodeChildOpen(context)
    const result = await open(new AbortController().signal)

    expect(requested).toEqual(['session/resume', 'session/create'])
    expect(connections).toEqual(['session_gone'])
    // The fresh draft is a creation, not a reattach: the lane replays nothing and the
    // handle link says so.
    expect(context.makeLane).toHaveBeenCalledWith(expect.anything(), false)
    expect(result.link?.origin).toBe('created')
  })
})
