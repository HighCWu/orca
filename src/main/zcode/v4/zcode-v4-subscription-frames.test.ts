import { describe, expect, it } from 'vitest'
import type { ZcodeV4WireFrameCandidate } from './zcode-v4-protocol-messages'
import { ZcodeV4SubscriptionFrames } from './zcode-v4-subscription-frames'

const TOPIC = 'conversation/session-1'
const SUBSCRIPTION = 'sub-1'

function physical(id: string, logical: Record<string, unknown>): ZcodeV4WireFrameCandidate {
  return {
    wireVersion: 3,
    kind: 'complete',
    deliveryKind: 'online',
    logicalFrameId: id,
    logicalFrameOrdinal: 1,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION,
    frame: logical
  }
}

function snapshot(seq: number) {
  return physical(`snapshot-${seq}`, {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION,
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
        revision: seq,
        rows: []
      }
    }
  })
}

function delta(id: string, fromSeq: number, toSeq: number) {
  return physical(id, {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION,
    fromSeq,
    toSeq,
    sentAt: 1_000,
    payload: { kind: 'deltas', deltas: [] }
  })
}

function frames(): ZcodeV4SubscriptionFrames {
  const frames = new ZcodeV4SubscriptionFrames()
  frames.begin(TOPIC)
  frames.bind(SUBSCRIPTION)
  return frames
}

describe('zcode v4 subscription frames', () => {
  it('ignores late frames after a failed arm clears the channel', () => {
    const routed = frames()
    routed.clear()

    expect(routed.route(snapshot(2))).toEqual({ status: 'ignored' })
  })

  it('does not let other topics consume the bounded pre-ack queue', () => {
    const routed = new ZcodeV4SubscriptionFrames()
    routed.begin(TOPIC)
    for (let index = 0; index < 8; index += 1) {
      expect(
        routed.route({
          ...snapshot(index),
          topic: 'conversation/other-session'
        })
      ).toEqual({ status: 'ignored' })
    }

    expect(routed.route(snapshot(2))).toEqual({ status: 'pending' })
    expect(routed.bind(SUBSCRIPTION)).toMatchObject([{ status: 'complete' }])
  })

  it('requests recovery when same-chunk pre-ack delivery exceeds its bound', () => {
    const routed = new ZcodeV4SubscriptionFrames()
    routed.begin(TOPIC)
    for (let index = 0; index < 9; index += 1) {
      expect(routed.route(snapshot(index + 1))).toEqual({ status: 'pending' })
    }

    expect(routed.bind(SUBSCRIPTION)).toContainEqual({ status: 'failed' })
  })

  it('resets fragmented frame state when a new subscription begins', () => {
    const routed = new ZcodeV4SubscriptionFrames()
    routed.begin(TOPIC)
    routed.bind(SUBSCRIPTION)
    const complete = snapshot(2)
    const fragment: ZcodeV4WireFrameCandidate = {
      wireVersion: complete.wireVersion,
      kind: 'fragment',
      deliveryKind: complete.deliveryKind,
      logicalFrameId: complete.logicalFrameId,
      logicalFrameOrdinal: complete.logicalFrameOrdinal,
      topic: complete.topic,
      subscriptionId: complete.subscriptionId,
      fragmentIndex: 0,
      fragmentCount: 2,
      logicalBytes: 2,
      checksum: { algorithm: 'crc32', value: '00000000' },
      dataBase64: Buffer.from('{}').toString('base64')
    }
    expect(routed.route(fragment)).toEqual({ status: 'pending' })

    routed.begin(TOPIC)
    routed.bind(SUBSCRIPTION)

    expect(routed.route(fragment)).toEqual({ status: 'pending' })
  })

  it('requires a valid snapshot before admitting deltas', () => {
    const routed = frames()

    expect(routed.route(delta('early', 0, 1))).toEqual({ status: 'ignored' })
    expect(routed.route(snapshot(2))).toMatchObject({ status: 'complete' })
    expect(routed.route(delta('online', 2, 3))).toMatchObject({ status: 'complete' })
  })

  it('ignores replayed frames without projecting their deltas twice', () => {
    const routed = frames()
    routed.route(snapshot(2))
    routed.route(delta('online', 2, 3))

    expect(routed.route(delta('replay', 2, 3))).toEqual({ status: 'ignored' })
  })

  it('does not let a late snapshot rewind an accepted epoch', () => {
    const routed = frames()
    routed.route(snapshot(2))
    routed.route(delta('online', 2, 3))

    expect(routed.route(snapshot(2))).toEqual({ status: 'ignored' })
    expect(routed.route(delta('next', 3, 4))).toMatchObject({ status: 'complete' })
  })

  it('reports each recovery fault while blocking deltas until a snapshot', () => {
    const routed = frames()
    routed.route(snapshot(2))

    expect(routed.route(delta('gap', 4, 5))).toEqual({ status: 'failed' })
    expect(routed.route(delta('more-gap', 5, 6))).toEqual({ status: 'ignored' })
    const malformedRecovery = snapshot(6)
    if (malformedRecovery.kind === 'complete' && typeof malformedRecovery.frame === 'object') {
      malformedRecovery.frame = { ...malformedRecovery.frame, fromSeq: 1 }
    }
    expect(routed.route(malformedRecovery)).toEqual({ status: 'failed' })
    expect(routed.route(snapshot(6))).toMatchObject({ status: 'complete' })
    expect(routed.route(delta('recovered', 6, 7))).toMatchObject({ status: 'complete' })
  })

  it('drops incomplete assemblies when recovery establishes a new snapshot barrier', () => {
    let now = 0
    const routed = new ZcodeV4SubscriptionFrames(() => now)
    routed.begin(TOPIC)
    routed.bind(SUBSCRIPTION)
    routed.route(snapshot(2))
    const fragment: ZcodeV4WireFrameCandidate = {
      wireVersion: 3,
      kind: 'fragment',
      deliveryKind: 'online',
      logicalFrameId: 'stale-fragment',
      logicalFrameOrdinal: 2,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION,
      fragmentIndex: 0,
      fragmentCount: 2,
      logicalBytes: 2,
      checksum: { algorithm: 'crc32', value: '00000000' },
      dataBase64: Buffer.from('{}').toString('base64')
    }
    expect(routed.route(fragment)).toEqual({ status: 'pending' })
    expect(routed.route(delta('gap', 4, 5))).toEqual({ status: 'failed' })
    expect(routed.route(snapshot(5))).toMatchObject({ status: 'complete' })

    now = 30_000

    expect(routed.route(delta('recovered', 5, 6))).toMatchObject({ status: 'complete' })
  })

  it('lets a recovery snapshot at the current watermark reopen delta delivery', () => {
    const routed = frames()
    routed.route(snapshot(2))
    expect(routed.route(delta('gap', 4, 5))).toEqual({ status: 'failed' })

    expect(routed.route(snapshot(2))).toMatchObject({ status: 'complete' })
    expect(routed.route(delta('recovered', 2, 3))).toMatchObject({ status: 'complete' })
  })

  it('allows another recovery request after the previous one failed', () => {
    const routed = frames()
    routed.route(snapshot(2))
    expect(routed.route(delta('first-gap', 4, 5))).toEqual({ status: 'failed' })

    routed.retryRecovery()

    expect(routed.route(delta('retry-gap', 5, 6))).toEqual({ status: 'failed' })
  })

  it('requests recovery when a matching outer frame carries another logical subscription', () => {
    const routed = frames()
    const mismatched = snapshot(2)
    if (
      mismatched.kind === 'complete' &&
      typeof mismatched.frame === 'object' &&
      mismatched.frame
    ) {
      mismatched.frame = { ...mismatched.frame, subscriptionId: 'sub-other' }
    }

    expect(routed.route(mismatched)).toEqual({ status: 'failed' })
  })

  it('rejects a snapshot for another session even when its subscription matches', () => {
    const routed = frames()
    const mismatched = snapshot(2)
    if (
      mismatched.kind === 'complete' &&
      typeof mismatched.frame === 'object' &&
      mismatched.frame
    ) {
      mismatched.frame = {
        ...mismatched.frame,
        payload: {
          kind: 'snapshot',
          snapshot: {
            protocolVersion: 1,
            sessionId: 'session-2',
            logEpoch: 'epoch-1',
            seq: 2,
            rows: []
          }
        }
      }
    }

    expect(routed.route(mismatched)).toEqual({ status: 'failed' })
  })

  it('rejects malformed snapshot sequence metadata', () => {
    const routed = frames()
    const malformed = snapshot(2)
    if (malformed.kind === 'complete') {
      malformed.frame = {
        topic: TOPIC,
        subscriptionId: SUBSCRIPTION,
        fromSeq: 1,
        toSeq: 2,
        sentAt: 1_000,
        payload: {
          kind: 'snapshot',
          snapshot: {
            protocolVersion: 1,
            sessionId: 'session-1',
            logEpoch: 'epoch-1',
            seq: 2,
            rows: []
          }
        }
      }
    }

    expect(routed.route(malformed)).toEqual({ status: 'failed' })
  })
})
