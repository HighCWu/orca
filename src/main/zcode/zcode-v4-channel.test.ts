// End-to-end wiring over a scripted in-process app-server: v3 create + v4 subscribe, frames
// through the reassembler and translator, and the v4 command envelope the adapter sends.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const workspace = mkdtempSync(join(tmpdir(), 'zcode-v4-channel-'))
import { createZcodeAgentConnection, type ZcodeAgentConnection } from './zcode-protocol-connection'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ZcodeV4ConversationChannel } from './v4/zcode-v4-conversation-channel'
import { ZcodeV4ConversationTranslator } from './v4/zcode-v4-conversation-projection'

const SCRIPTED_SERVER = `
let buffer = ''
let seq = 0
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
process.stdin.setEncoding('utf8')
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
    send({
      id: frame.id,
      result: {
        protocol: { name: 'ZCode Protocol', version: 1 },
        session: { sessionId: 'sess_v4' },
        settings: { model: { current: { providerId: 'bigmodel', modelId: 'GLM-5.3' } } }
      }
    })
    return
  }
  if (frame.method === 'v4/conversation/subscribe') {
    send({ id: frame.id, result: { ack: { subscriptionId: 'sub-1', mode: 'snapshot', logEpoch: 'epoch-1' } } })
    const topic = frame.params.topic
    const logical = {
      topic,
      subscriptionId: 'sub-1',
      fromSeq: 0,
      toSeq: 2,
      sentAt: 1000,
      payload: {
        kind: 'snapshot',
        snapshot: {
          protocolVersion: 1,
          sessionId: 'sess_v4',
          logEpoch: 'epoch-1',
          seq: 2,
          revision: 7,
          rows: [],
          usage: {
            contextWindow: { usedTokens: 10, maxTokens: 200000 },
            cumulative: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
          }
        }
      }
    }
    send({ method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', deliveryKind: 'initial', logicalFrameId: 'f0', logicalFrameOrdinal: 1, topic, subscriptionId: 'sub-1', frame: logical } })
    return
  }
  if (frame.method === 'v4/conversation/resync') {
    resyncCount += 1
    send({ id: frame.id, result: { ack: { mode: 'snapshot' } } })
    const topic = frame.params.topic
    const logical = {
      topic,
      subscriptionId: 'sub-1',
      fromSeq: resyncCount === 1 ? 1 : 0,
      toSeq: 2,
      sentAt: 1100 + resyncCount,
      payload: {
        kind: 'snapshot',
        snapshot: {
          protocolVersion: 1,
          sessionId: 'sess_v4',
          logEpoch: 'epoch-1',
          seq: 2,
          revision: resyncCount === 1 ? 8 : 9,
          rows: []
        }
      }
    }
    send({ method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', deliveryKind: 'recovery', logicalFrameId: 'recovery-' + resyncCount, logicalFrameOrdinal: 2 + resyncCount, topic, subscriptionId: 'sub-1', frame: logical } })
    return
  }
  if (frame.method === 'v4/conversation/rowsRange') {
    const before = frame.params.beforeRowId
    const row = (rowId) => ({
      rowId,
      turnId: 'turn-' + rowId,
      kind: 'assistantText',
      text: 'row-' + rowId,
      createdAt: 1000
    })
    if (before === 100) {
      send({ id: frame.id, result: { rows: [row(50)], atSeq: 2, atRevision: 7, atLogEpoch: 'epoch-1', hasMore: true } })
      return
    }
    if (before === 50) {
      send({ id: frame.id, result: { rows: [row(10)], atSeq: 2, atRevision: 7, atLogEpoch: 'epoch-1', hasMore: false } })
      return
    }
    if (before === 200) {
      send({ id: frame.id, result: { rows: [row(150)], atSeq: 2, atRevision: 7, atLogEpoch: 'epoch-1', hasMore: true } })
      return
    }
    if (before === 150) {
      send({ id: frame.id, result: { rows: [row(120)], atSeq: 3, atRevision: 8, atLogEpoch: 'epoch-2', hasMore: false } })
      return
    }
    if (before === 300) {
      send({ id: frame.id, result: { rows: [{ rowId: 250 }], atSeq: 2, atRevision: 7, atLogEpoch: 'epoch-1', hasMore: false } })
      return
    }
    if (before === 400) {
      send({ id: frame.id, result: { rows: [row(400)], atSeq: 2, atRevision: 7, atLogEpoch: 'epoch-1', hasMore: true } })
      return
    }
  }
  if (frame.method === 'v4/attachment/begin') {
    const fileName = frame.params.fileName
    attachFailing = fileName === 'x.png'
    attachCursorFailure = fileName === 'bad-chunk.png'
    send({
      id: frame.id,
      result: {
        uploadId: fileName === 'bad-upload-id.png' ? 'another-upload' : frame.params.uploadId,
        state: fileName === 'bad-committed.png' ? 'committed' : 'staging',
        nextChunkIndex: fileName === 'bad-begin-cursor.png' ? frame.params.totalChunks + 1 : 0,
        ...(fileName === 'bad-committed.png' ? { ref: 'incomplete-ref' } : {})
      }
    })
    return
  }
  if (frame.method === 'v4/attachment/chunk') {
    send({ id: frame.id, result: { uploadId: frame.params.uploadId, nextChunkIndex: attachCursorFailure ? frame.params.chunkIndex : frame.params.chunkIndex + 1 } })
    return
  }
  if (frame.method === 'v4/attachment/commit') {
    if (attachFailing) {
      send({ id: frame.id, error: { code: -32000, message: 'commit failed' } })
      return
    }
    send({ id: frame.id, result: { ref: 'att-1' } })
    return
  }
  if (frame.method === 'v4/attachment/abort') {
    send({ id: frame.id, result: {} })
    return
  }
  if (frame.method === 'v4/command') {
    commands.push(frame)
    let result = { commandId: frame.params.type === 'mismatchedAck' ? 'another-command' : frame.params.commandId, status: 'accepted', revisionAtDecision: frame.params.baseRevision ?? 0 }
    if (frame.type === 'forkAssistant') {
      result = { ...result, result: { type: 'forkAssistant', sessionId: 'sess_forked' } }
    }
    send({ id: frame.id, result })
    return
  }
  send({ id: frame.id, error: { code: -32601, message: 'Method not found: ' + frame.method } })
}
const commands = []
let resyncCount = 0
let attachFailing = false
let attachCursorFailure = false
if (process.send) { process.send({ ready: true }) }
`

const connections: ZcodeAgentConnection[] = []
afterEach(async () => {
  await Promise.all(connections.map((connection) => connection.close()))
  connections.length = 0
})

function openConnection(): ZcodeAgentConnection {
  const connection = createZcodeAgentConnection({
    command: process.execPath,
    args: ['-e', SCRIPTED_SERVER],
    cwd: workspace
  })
  connections.push(connection)
  return connection
}

function makeChannel(connection: ZcodeAgentConnection): ZcodeV4ConversationChannel {
  return new ZcodeV4ConversationChannel(
    new ZcodeV4ConversationTranslator({ now: () => 1_000 }, 'sess_v4'),
    connection,
    'sess_v4'
  )
}

async function armChannel(
  connection: ZcodeAgentConnection,
  channel: ZcodeV4ConversationChannel
): Promise<void> {
  connection.subscribe((method, params) => {
    channel.handle(method, params)
  })
  expect(await channel.arm('sess_v4')).toBe(true)
}

describe('zcode v4 conversation channel wiring', () => {
  it('arms over the same connection, seeds usage from the snapshot, and drives turn events', async () => {
    const connection = openConnection()
    const lane: ProviderTimelineEvent[] = []
    await connection.spawned
    await connection.request(
      'session/create',
      { workspace: { workspacePath: '/w', workspaceKey: 'w' } },
      undefined
    )
    const channel = makeChannel(connection)
    connection.subscribe((method, params) => {
      lane.push(...channel.handle(method, params))
    })
    expect(await channel.arm('sess_v4')).toBe(true)
    lane.push(...channel.drainReadyEvents())
    await vi.waitFor(() => {
      // The snapshot's usage seed is the one event the initial frame translates.
      expect(lane.some((event) => event.type === 'context.usage')).toBe(true)
    })
    expect(channel.revision()).toBe(7)

    // A live turn rides deltas through the same channel.
    lane.push(
      ...channel.handle('v4/conversation/frame', {
        wireVersion: 3,
        kind: 'complete',
        deliveryKind: 'online',
        logicalFrameId: 'f1',
        logicalFrameOrdinal: 2,
        topic: 'conversation/sess_v4',
        subscriptionId: 'sub-1',
        frame: {
          topic: 'conversation/sess_v4',
          subscriptionId: 'sub-1',
          fromSeq: 2,
          toSeq: 3,
          sentAt: 1100,
          payload: {
            kind: 'deltas',
            deltas: [
              {
                op: 'row.appended',
                row: {
                  rowId: 1,
                  turnId: 'turn_v4',
                  kind: 'turnHeader',
                  state: 'running',
                  startedAt: 1050,
                  createdAt: 1050,
                  createdAtSeq: 3
                }
              }
            ]
          }
        }
      })
    )
    expect(lane.map((event) => event.type)).toContain('turn.open')
  })

  it('retries resync when the post-response recovery snapshot is malformed', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    channel.handle('v4/conversation/frame', {
      wireVersion: 3,
      kind: 'complete',
      deliveryKind: 'online',
      logicalFrameId: 'gap',
      logicalFrameOrdinal: 2,
      topic: 'conversation/sess_v4',
      subscriptionId: 'sub-1',
      frame: {
        topic: 'conversation/sess_v4',
        subscriptionId: 'sub-1',
        fromSeq: 4,
        toSeq: 5,
        sentAt: 1_100,
        payload: { kind: 'deltas', deltas: [] }
      }
    })

    await vi.waitFor(() => {
      expect(channel.revision()).toBe(9)
    })
  })

  it('ignores physical frames from another subscription and recovers logical mismatches', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)
    channel.drainReadyEvents()
    const logical = {
      topic: 'conversation/sess_v4',
      subscriptionId: 'sub-1',
      fromSeq: 2,
      toSeq: 3,
      sentAt: 1_100,
      payload: {
        kind: 'deltas',
        deltas: [
          {
            op: 'row.appended',
            row: {
              rowId: 1,
              turnId: 'wrong_turn',
              kind: 'turnHeader',
              state: 'running',
              createdAt: 1_100
            }
          }
        ]
      }
    }

    expect(
      channel.handle('v4/conversation/frame', {
        wireVersion: 3,
        kind: 'complete',
        deliveryKind: 'online',
        logicalFrameId: 'wrong-outer',
        logicalFrameOrdinal: 2,
        topic: 'conversation/sess_v4',
        subscriptionId: 'sub-old',
        frame: logical
      })
    ).toEqual([])
    expect(
      channel.handle('v4/conversation/frame', {
        wireVersion: 3,
        kind: 'complete',
        deliveryKind: 'online',
        logicalFrameId: 'wrong-inner',
        logicalFrameOrdinal: 3,
        topic: 'conversation/sess_v4',
        subscriptionId: 'sub-1',
        frame: { ...logical, subscriptionId: 'sub-old' }
      })
    ).toEqual([])
    expect(channel.translator.snapshotRows()).toEqual([])
  })

  it('paginates rewind rows against one stable conversation watermark', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(channel.rowsBefore(100)).resolves.toEqual([
      expect.objectContaining({ rowId: 10 }),
      expect.objectContaining({ rowId: 50 })
    ])
  })

  it('rejects rewind history when a page crosses conversation watermarks', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(channel.rowsBefore(200)).rejects.toThrow(
      'rows changed while reading rewind history'
    )
  })

  it('rejects malformed rewind rows instead of silently changing the target', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(channel.rowsBefore(300)).rejects.toThrow()
  })

  it('rejects a rewind page whose cursor does not advance', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(channel.rowsBefore(400)).rejects.toThrow('did not advance its cursor')
  })

  it('sends commands with the session and CAS fields the envelope requires', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    const ack = await channel.command('sendText', { text: 'hi', requestedDelivery: 'startNow' })
    expect(ack.status).toBe('accepted')
  })

  it('rejects a command acknowledgement bound to another command id', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)

    await expect(
      channel.command('mismatchedAck', {}, { commandId: 'expected-command' })
    ).rejects.toThrow('mismatched command id')
  })

  it('rejects a CAS command before any state revision arrived', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)

    await expect(
      channel.command('switchModelConfig', { model: 'glm-5' }, { cas: true })
    ).rejects.toThrow('needs a state revision')
  })

  it('rejects a row-target command before any log epoch arrived', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await expect(
      channel.command(
        'forkAssistant',
        { target: { rowId: 1, entityId: 'e1' } },
        { rowTarget: true }
      )
    ).rejects.toThrow('needs a row log epoch')
  })

  it('uploads an attachment through begin→chunk→commit and reports the ref', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)
    const bytes = Buffer.from('attachment-bytes-0123456789')
    const ref = await channel.uploadAttachment({
      fileName: 'shot.png',
      mime: 'image/png',
      bytes
    })
    expect(ref).toEqual({
      ref: 'att-1',
      fileName: 'shot.png',
      mime: 'image/png',
      bytes: bytes.byteLength
    })
  })

  it.each([
    ['a mismatched upload id', 'bad-upload-id.png', 'invalid upload cursor'],
    ['a begin cursor past the declared chunks', 'bad-begin-cursor.png', 'invalid upload cursor'],
    ['a committed upload with missing chunks', 'bad-committed.png', 'did not confirm every chunk'],
    ['a chunk acknowledgement that did not advance', 'bad-chunk.png', 'did not advance']
  ])('aborts and rejects %s', async (_case, fileName, message) => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(
      channel.uploadAttachment({ fileName, mime: 'image/png', bytes: Buffer.from('payload') })
    ).rejects.toThrow(message)
  })

  it('rejects an attachment above the protocol byte limit before staging it', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)

    await expect(
      channel.uploadAttachment({
        fileName: 'oversize.png',
        mime: 'image/png',
        bytes: Buffer.alloc(20 * 1024 * 1024 + 1)
      })
    ).rejects.toThrow('protocol byte limit')
  })

  it('aborts staging and rejects when the commit fails, leaving no ref', async () => {
    const connection = openConnection()
    await connection.spawned
    const channel = makeChannel(connection)
    await armChannel(connection, channel)
    const bytes = Buffer.from('doomed')
    await expect(
      channel.uploadAttachment({ fileName: 'x.png', mime: 'image/png', bytes })
    ).rejects.toThrow()
  })
})
