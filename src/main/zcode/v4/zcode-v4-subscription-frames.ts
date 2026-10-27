import { ZcodeV4FrameReassembler } from './zcode-v4-frame-reassembly'
import { zcodeV4ConversationLogicalFrameSchema } from './zcode-v4-conversation-frames'
import type { ZcodeV4ConversationLogicalFrame } from './zcode-v4-conversation-frames'
import type { ZcodeV4WireFrameCandidate } from './zcode-v4-protocol-messages'

const MAX_PRE_ACK_FRAMES = 8

export type ZcodeV4SubscriptionFrameResult =
  | { status: 'complete'; frame: ZcodeV4ConversationLogicalFrame }
  | { status: 'pending' | 'ignored' | 'failed' }

export class ZcodeV4SubscriptionFrames {
  private readonly reassembler: ZcodeV4FrameReassembler
  private readonly preAck: ZcodeV4WireFrameCandidate[] = []
  private preAckOverflowed = false
  private topic: string | null = null
  private subscriptionId: string | null = null
  private acceptedSeq: number | null = null
  private acceptedLogEpoch: string | null = null
  private recovering = false
  private active = false

  constructor(now: () => number = Date.now) {
    this.reassembler = new ZcodeV4FrameReassembler(now)
  }

  begin(topic: string): void {
    this.clear()
    this.topic = topic
    this.active = true
  }

  bind(subscriptionId: string): ZcodeV4SubscriptionFrameResult[] {
    this.subscriptionId = subscriptionId
    const results = this.preAck.splice(0).map((frame) => this.route(frame))
    if (this.preAckOverflowed) {
      this.preAckOverflowed = false
      results.push(this.fail())
    }
    return results
  }

  retryRecovery(): void {
    if (this.recovering) {
      this.recovering = false
    }
  }

  clear(): void {
    this.topic = null
    this.subscriptionId = null
    this.acceptedSeq = null
    this.acceptedLogEpoch = null
    this.recovering = false
    this.active = false
    this.preAck.length = 0
    this.preAckOverflowed = false
    this.reassembler.clear()
  }

  route(frame: ZcodeV4WireFrameCandidate): ZcodeV4SubscriptionFrameResult {
    if (!this.active) {
      return { status: 'ignored' }
    }
    if (!this.subscriptionId) {
      if (frame.topic !== this.topic) {
        return { status: 'ignored' }
      }
      if (this.preAck.length < MAX_PRE_ACK_FRAMES) {
        this.preAck.push(frame)
      } else {
        this.preAckOverflowed = true
      }
      return { status: 'pending' }
    }
    if (frame.topic !== this.topic || frame.subscriptionId !== this.subscriptionId) {
      return { status: 'ignored' }
    }
    const reassembled = this.reassembler.feed(frame)
    if (reassembled.status !== 'complete') {
      return reassembled.status === 'failed' ? this.fail() : reassembled
    }
    const parsed = zcodeV4ConversationLogicalFrameSchema.safeParse(reassembled.frame)
    if (!parsed.success || parsed.data.toSeq < parsed.data.fromSeq) {
      return this.fail()
    }
    if (parsed.data.topic !== this.topic || parsed.data.subscriptionId !== this.subscriptionId) {
      return this.fail()
    }
    return this.accept(parsed.data)
  }

  private accept(frame: ZcodeV4ConversationLogicalFrame): ZcodeV4SubscriptionFrameResult {
    if (frame.payload.kind === 'snapshot') {
      const sessionId = this.topic?.slice('conversation/'.length)
      if (
        !sessionId ||
        frame.payload.snapshot.sessionId !== sessionId ||
        frame.fromSeq !== 0 ||
        frame.toSeq !== frame.payload.snapshot.seq
      ) {
        return this.fail()
      }
      if (this.acceptedLogEpoch === frame.payload.snapshot.logEpoch && this.acceptedSeq !== null) {
        if (
          frame.toSeq < this.acceptedSeq ||
          (frame.toSeq === this.acceptedSeq && !this.recovering)
        ) {
          return { status: 'ignored' }
        }
      }
      this.acceptedSeq = frame.toSeq
      this.acceptedLogEpoch = frame.payload.snapshot.logEpoch
      this.recovering = false
      this.reassembler.clear()
      return { status: 'complete', frame }
    }
    if (this.recovering || this.acceptedSeq === null) {
      return { status: 'ignored' }
    }
    if (frame.toSeq <= this.acceptedSeq) {
      return { status: 'ignored' }
    }
    if (frame.fromSeq !== this.acceptedSeq) {
      return this.fail()
    }
    this.acceptedSeq = frame.toSeq
    return { status: 'complete', frame }
  }

  private fail(): ZcodeV4SubscriptionFrameResult {
    this.recovering = true
    this.reassembler.clear()
    return { status: 'failed' }
  }
}
