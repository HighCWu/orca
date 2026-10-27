import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZcodeAgentConnection } from '../zcode-protocol-connection'
import { ZcodeV4ConversationChannel } from './zcode-v4-conversation-channel'
import { ZcodeV4ConversationTranslator } from './zcode-v4-conversation-projection'

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

function channel(request: ZcodeAgentConnection['request']): ZcodeV4ConversationChannel {
  return new ZcodeV4ConversationChannel(
    new ZcodeV4ConversationTranslator({ now: () => 1_000 }, 'session-1'),
    connection(request),
    'session-1'
  )
}

function snapshot(seq = 2) {
  return {
    wireVersion: 3,
    kind: 'complete',
    deliveryKind: 'initial',
    logicalFrameId: `snapshot-${seq}`,
    logicalFrameOrdinal: 1,
    topic: 'conversation/session-1',
    subscriptionId: 'sub-1',
    frame: {
      topic: 'conversation/session-1',
      subscriptionId: 'sub-1',
      fromSeq: 0,
      toSeq: seq,
      sentAt: 1_000,
      payload: {
        kind: 'snapshot',
        snapshot: {
          protocolVersion: 1,
          sessionId: 'session-1',
          logEpoch: 'epoch-1',
          seq,
          revision: 7,
          rows: []
        }
      }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('zcode v4 conversation channel lifecycle', () => {
  it('unsubscribes a server subscription whose initial snapshot timed out', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async (method: string) =>
      method === 'v4/conversation/subscribe'
        ? { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' } }
        : {}
    )
    const subject = channel(request)

    const armed = subject.arm('session-1')
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(armed).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith(
      'v4/conversation/unsubscribe',
      {
        topic: 'conversation/session-1',
        subscriptionId: 'sub-1',
        connectionId: 'orca-session-1'
      },
      10_000
    )
  })

  it('unsubscribes when disposal overtakes the subscribe acknowledgement', async () => {
    let resolveSubscribe!: (value: unknown) => void
    const request = vi.fn((method: string) => {
      if (method === 'v4/conversation/subscribe') {
        return new Promise((resolve) => {
          resolveSubscribe = resolve
        })
      }
      return Promise.resolve({})
    })
    const subject = channel(request)

    const armed = subject.arm('session-1')
    await vi.waitFor(() => expect(resolveSubscribe).toBeTypeOf('function'))
    subject.dispose()
    resolveSubscribe({
      ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' }
    })

    await expect(armed).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith(
      'v4/conversation/unsubscribe',
      {
        topic: 'conversation/session-1',
        subscriptionId: 'sub-1',
        connectionId: 'orca-session-1'
      },
      10_000
    )
    expect(subject.handle('v4/conversation/frame', snapshot())).toEqual([])
  })

  it('stops waiting for the initial snapshot when disposed after subscribe', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'v4/conversation/subscribe'
        ? { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' } }
        : {}
    )
    const subject = channel(request)

    const armed = subject.arm('session-1')
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('v4/conversation/subscribe', expect.anything(), 10_000)
    )
    await Promise.resolve()
    subject.dispose()

    await expect(armed).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith(
      'v4/conversation/unsubscribe',
      {
        topic: 'conversation/session-1',
        subscriptionId: 'sub-1',
        connectionId: 'orca-session-1'
      },
      10_000
    )
  })

  it('bounds corrupt recovery snapshots to one immediate resync retry', async () => {
    let subject: ZcodeV4ConversationChannel
    const resyncResolvers: (() => void)[] = []
    const request = vi.fn((method: string) => {
      if (method === 'v4/conversation/subscribe') {
        queueMicrotask(() => {
          subject.handle('v4/conversation/frame', snapshot())
        })
        return Promise.resolve({
          ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' }
        })
      }
      if (method === 'v4/conversation/resync') {
        return new Promise<void>((resolve) => resyncResolvers.push(resolve))
      }
      return Promise.resolve({})
    })
    subject = channel(request)
    await expect(subject.arm('session-1')).resolves.toBe(true)
    const malformed = {
      ...snapshot(),
      deliveryKind: 'recovery' as const,
      frame: { ...snapshot().frame, fromSeq: 1 }
    }

    subject.handle('v4/conversation/frame', malformed)
    await vi.waitFor(() => expect(resyncResolvers).toHaveLength(1))
    subject.handle('v4/conversation/frame', malformed)
    resyncResolvers.shift()?.()
    await vi.waitFor(() => expect(resyncResolvers).toHaveLength(1))
    subject.handle('v4/conversation/frame', malformed)
    resyncResolvers.shift()?.()
    await Promise.resolve()

    expect(
      request.mock.calls.filter(([method]) => method === 'v4/conversation/resync')
    ).toHaveLength(2)
  })

  it('does not issue a queued resync retry after disposal', async () => {
    let subject: ZcodeV4ConversationChannel
    let resolveResync!: () => void
    const request = vi.fn((method: string) => {
      if (method === 'v4/conversation/subscribe') {
        queueMicrotask(() => {
          subject.handle('v4/conversation/frame', snapshot())
        })
        return Promise.resolve({
          ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' }
        })
      }
      if (method === 'v4/conversation/resync') {
        return new Promise<void>((resolve) => {
          resolveResync = resolve
        })
      }
      return Promise.resolve({})
    })
    subject = channel(request)
    await expect(subject.arm('session-1')).resolves.toBe(true)
    const malformed = {
      ...snapshot(),
      deliveryKind: 'recovery' as const,
      frame: { ...snapshot().frame, fromSeq: 1 }
    }

    subject.handle('v4/conversation/frame', malformed)
    await vi.waitFor(() => expect(resolveResync).toBeTypeOf('function'))
    subject.handle('v4/conversation/frame', malformed)
    subject.dispose()
    resolveResync()
    await Promise.resolve()

    expect(
      request.mock.calls.filter(([method]) => method === 'v4/conversation/resync')
    ).toHaveLength(1)
  })

  it('cancels a queued retry when the current resync delivers a valid snapshot', async () => {
    let subject: ZcodeV4ConversationChannel
    let resolveResync!: () => void
    const request = vi.fn((method: string) => {
      if (method === 'v4/conversation/subscribe') {
        queueMicrotask(() => {
          subject.handle('v4/conversation/frame', snapshot())
        })
        return Promise.resolve({
          ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' }
        })
      }
      if (method === 'v4/conversation/resync') {
        return new Promise<void>((resolve) => {
          resolveResync = resolve
        })
      }
      return Promise.resolve({})
    })
    subject = channel(request)
    await expect(subject.arm('session-1')).resolves.toBe(true)
    const malformed = {
      ...snapshot(),
      deliveryKind: 'recovery' as const,
      frame: { ...snapshot().frame, fromSeq: 1 }
    }

    subject.handle('v4/conversation/frame', malformed)
    await vi.waitFor(() => expect(resolveResync).toBeTypeOf('function'))
    subject.handle('v4/conversation/frame', malformed)
    subject.handle('v4/conversation/frame', {
      ...snapshot(),
      deliveryKind: 'recovery' as const,
      logicalFrameId: 'valid-recovery'
    })
    resolveResync()
    await Promise.resolve()

    expect(
      request.mock.calls.filter(([method]) => method === 'v4/conversation/resync')
    ).toHaveLength(1)
  })

  it('includes the topic and connection identity in a gap resync', async () => {
    let subject: ZcodeV4ConversationChannel
    const request = vi.fn(async (method: string) => {
      if (method === 'v4/conversation/subscribe') {
        queueMicrotask(() => {
          subject.handle('v4/conversation/frame', snapshot())
        })
        return { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' } }
      }
      return {}
    })
    subject = channel(request)
    await expect(subject.arm('session-1')).resolves.toBe(true)

    subject.handle('v4/conversation/frame', {
      ...snapshot(5),
      deliveryKind: 'online',
      logicalFrameId: 'gap',
      frame: {
        ...snapshot(5).frame,
        fromSeq: 4,
        payload: { kind: 'deltas', deltas: [] }
      }
    })

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        'v4/conversation/resync',
        {
          topic: 'conversation/session-1',
          connectionId: 'orca-session-1',
          subscriptionId: 'sub-1',
          base: { logEpoch: 'epoch-1', seq: 2 },
          forceSnapshot: true
        },
        10_000
      )
    })
  })
})
