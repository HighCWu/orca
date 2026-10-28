// The NDJSON connection against a real child process speaking the protocol from a script: framing,
// request correlation, the storage gate, reverse requests and proven closes.

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createZcodeAgentConnection,
  ZcodeProtocolRuntime,
  type ZcodeAgentConnection
} from './zcode-protocol-connection'

const permissionParamsSchema = z.looseObject({
  toolName: z.string().optional(),
  options: z.array(z.looseObject({ response: z.unknown() }))
})

const snapshotSchema = z.looseObject({
  session: z.looseObject({ sessionId: z.string() }),
  settings: z.looseObject({
    model: z.looseObject({ current: z.looseObject({ modelId: z.string() }) })
  })
})

const sendResultSchema = z.looseObject({ accepted: z.boolean() })

/** A minimal app-server: gates on storage, correlates ids, answers, asks back, streams events. */
const FAKE_SERVER = `
let buffer = ''
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
process.stdin.setEncoding('utf8')
// A real app-server pushes storage startup state before it reads anything.
send({ method: 'startup/storageState', params: { phase: 'ready' } })
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) { handle(JSON.parse(line)) }
    newline = buffer.indexOf('\\n')
  }
})
function handle(frame) {
  if (frame.method === 'session/create') {
    send({ id: frame.id, result: { protocol: { name: 'ZCode Protocol', version: 1 }, session: { sessionId: 'sess_test' }, settings: { model: { current: { modelId: 'glm-5' } } } } })
    setTimeout(() => {
      send({ id: 'server-1', method: 'interaction/requestPermission', params: { requestId: 'perm-1', sessionId: 'sess_test', toolName: 'bash', options: [{ optionId: 'allow', kind: 'allow_once', response: { decision: 'allow' } }] } })
    }, 30)
    return
  }
  if (frame.method === 'session/send') {
    send({ id: frame.id, result: { sessionId: 'sess_test', accepted: true, stateRevision: 1 } })
    send({ method: 'session/event', params: { sessionId: 'sess_test', type: 'turn.started', turnId: 'turn_1', payload: {} } })
    return
  }
  if (frame.method === 'slow') {
    setTimeout(() => send({ id: frame.id, result: {} }), 5000)
    return
  }
  send({ id: frame.id, error: { code: -32601, message: 'Method not found: ' + frame.method } })
}
process.stdin.resume()
`

const openConnections: ZcodeAgentConnection[] = []

function openConnection(...args: Parameters<typeof createZcodeAgentConnection>) {
  const connection = createZcodeAgentConnection(...args)
  openConnections.push(connection)
  return connection
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(openConnections.map((connection) => connection.close()))
  openConnections.length = 0
})

describe('zcode protocol connection', () => {
  it('correlates requests behind the storage gate and streams notifications', async () => {
    const events: { method: string; params: unknown }[] = []
    const connection = openConnection({
      command: process.execPath,
      args: ['-e', FAKE_SERVER]
    })
    await connection.spawned
    connection.subscribe((method, params) => {
      if (method === 'session/event') {
        events.push({ method, params })
      }
    })
    const snapshot = snapshotSchema.parse(
      await connection.request('session/create', {
        workspace: { workspacePath: '/w', workspaceKey: 'w' }
      })
    )
    expect(snapshot.session.sessionId).toBe('sess_test')
    expect(snapshot.settings.model.current.modelId).toBe('glm-5')
    const sent = sendResultSchema.parse(
      await connection.request('session/send', {
        sessionId: 'sess_test',
        content: 'hello'
      })
    )
    expect(sent.accepted).toBe(true)
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    expect(events[0].params).toMatchObject({ type: 'turn.started', turnId: 'turn_1' })
  })

  it('bridges the options notification handler without a subscribe call', async () => {
    const events: { method: string; params: unknown }[] = []
    const connection = openConnection(
      {
        command: process.execPath,
        args: ['-e', FAKE_SERVER]
      },
      {
        onNotification: (method, params) => {
          if (method === 'session/event') {
            events.push({ method, params })
          }
        }
      }
    )
    await connection.spawned
    await connection.request('session/create', {
      workspace: { workspacePath: '/w', workspaceKey: 'w' }
    })
    await connection.request('session/send', { sessionId: 'sess_test', content: 'hello' })
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    expect(events[0].params).toMatchObject({ type: 'turn.started', turnId: 'turn_1' })
  })

  it('delivers a reverse request and carries the answer back on its frame id', async () => {
    let resolveReceived: (value: { toolName?: string }) => void = () => {}
    const received = new Promise<{ toolName?: string }>((resolve) => {
      resolveReceived = resolve
    })
    const connection = openConnection(
      {
        command: process.execPath,
        args: ['-e', FAKE_SERVER]
      },
      {
        onRequest: (method, params, context) => {
          expect(method).toBe('interaction/requestPermission')
          const request = permissionParamsSchema.parse(params)
          resolveReceived(request)
          context.respond(request.options[0].response)
        }
      }
    )
    await connection.spawned
    // The fake server asks its permission once a session exists, as the real one only can.
    await connection.request('session/create', {
      workspace: { workspacePath: '/w', workspaceKey: 'w' }
    })
    const answer = await received
    expect(answer.toolName).toBe('bash')
  })

  it('times a request out at its deadline', async () => {
    const connection = openConnection({
      command: process.execPath,
      args: ['-e', FAKE_SERVER]
    })
    await connection.spawned
    await expect(connection.request('slow', {}, 200)).rejects.toThrow('timed out')
  })

  it('reports a delayed provider exit instead of the preceding stdout end', async () => {
    const connection = openConnection({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.end(); setTimeout(() => { process.stderr.write('startup failed token=private /home/test/account\\n', () => process.exit(23)) }, 20)`
      ]
    })
    await connection.spawned

    await expect(connection.request('runtime/capabilities', {})).rejects.toThrow(
      'startup failed token=[redacted] [redacted-path] (code=23 signal=null)'
    )
  })

  it('closes on an oversized unterminated frame', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const runtime = new ZcodeProtocolRuntime(input, output)

    input.write('x'.repeat(8 * 1024 * 1024 + 1))

    expect(runtime.closed).toBe(true)
  })

  it('rejects an unhandled reverse request instead of leaving it pending', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => written.push(chunk))
    const runtime = new ZcodeProtocolRuntime(input, output)

    input.write(`${JSON.stringify({ id: 'server-1', method: 'unknown', params: {} })}\n`)

    expect(written).toEqual([
      `${JSON.stringify({ id: 'server-1', error: { code: -32601, message: 'Method not found: unknown' } })}\n`
    ])
    runtime.close()
  })

  it('answers a reverse request at most once', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => written.push(chunk))
    const runtime = new ZcodeProtocolRuntime(input, output, {
      onRequest: (_method, _params, context) => {
        context.respond({ answer: 1 })
        context.respond({ answer: 2 })
        context.respondError(-1, 'late')
      }
    })

    input.write(`${JSON.stringify({ id: 'server-1', method: 'question', params: {} })}\n`)

    expect(written).toEqual([`${JSON.stringify({ id: 'server-1', result: { answer: 1 } })}\n`])
    runtime.close()
  })

  it('settles a server-resolved reverse request without writing an answer', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => written.push(chunk))
    const runtime = new ZcodeProtocolRuntime(input, output, {
      onRequest: (_method, _params, context) => {
        context.settle()
        context.respond({ late: true })
      }
    })

    input.write(`${JSON.stringify({ id: 'server-1', method: 'question', params: {} })}\n`)

    expect(written).toEqual([])
    runtime.close()
  })

  it('aborts an unsettled reverse request when the connection closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let signal: AbortSignal | undefined
    const runtime = new ZcodeProtocolRuntime(input, output, {
      onRequest: (_method, _params, context) => {
        signal = context.signal
      }
    })
    input.write(
      `${JSON.stringify({ id: 'server-1', method: 'interaction/requestUserInput', params: {} })}\n`
    )

    expect(signal?.aborted).toBe(false)
    runtime.close()
    expect(signal?.aborted).toBe(true)
  })

  it('does not send a storage-gated request after it already timed out', async () => {
    vi.useFakeTimers()
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => written.push(chunk))
    const runtime = new ZcodeProtocolRuntime(input, output)

    const request = expect(
      runtime.request('session/send', { content: 'late' }, 100)
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await request
    input.write(
      `${JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } })}\n`
    )

    expect(written).toEqual([])
    runtime.close()
    vi.useRealTimers()
  })
})
