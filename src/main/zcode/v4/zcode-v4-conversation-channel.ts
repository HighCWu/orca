// The v4 conversation channel for one zcode child: arms `v4/conversation/subscribe` on the
// child's own connection, turns frame notifications into journal-lane events, and carries
// commands plus the attachment upload transaction. Used unconditionally — mirroring the
// zcode desktop host, whose mainline is v4. A subscribe failure (an app-server predating
// v4 included) falls the open back to the legacy `session/subscribe` path.

import { randomUUID } from 'node:crypto'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ZcodeV4ConversationTranslator } from './zcode-v4-conversation-projection'
import { ZcodeV4SubscriptionFrames } from './zcode-v4-subscription-frames'
import {
  V4_METHODS,
  conversationTopic,
  zcodeV4CommandAckSchema,
  zcodeV4ConversationSubscribeParamsSchema,
  zcodeV4FrameNotificationSchema,
  zcodeV4SubscribeResultSchema
} from './zcode-v4-protocol-messages'
import type { ZcodeV4AttachmentRef, ZcodeV4CommandAck } from './zcode-v4-protocol-messages'
import { abortZcodeV4Attachment, uploadZcodeV4Attachment } from './zcode-v4-attachment-upload'
import { readZcodeV4RowsBefore } from './zcode-v4-row-range-reader'
import type { ZcodeV4ConversationRow } from './zcode-v4-conversation-frames'
import type { ZcodeAgentConnection } from '../zcode-protocol-connection'

const INITIAL_SNAPSHOT_TIMEOUT_MS = 10_000

export class ZcodeV4CommandRejectedError extends Error {
  constructor(
    readonly commandType: string,
    readonly acknowledgement: ZcodeV4CommandAck
  ) {
    super(
      `zcode v4 command ${commandType} ${acknowledgement.status}: ${acknowledgement.reasonCode ?? ''} ${acknowledgement.message ?? ''}`.trim()
    )
    this.name = 'ZcodeV4CommandRejectedError'
  }
}

export class ZcodeV4ConversationChannel {
  private readonly subscriptionFrames = new ZcodeV4SubscriptionFrames()

  readonly translator: ZcodeV4ConversationTranslator

  /** The connection identity this channel armed itself under; attachment transactions bind
   *  to it, so a re-arm on a new connection re-binds them too. */
  private connectionId: string | null = null
  private topic: string | null = null
  private subscriptionId: string | null = null
  private readonly readyEvents: ProviderTimelineEvent[] = []
  private resyncing: Promise<void> | null = null
  private resyncQueued = false
  private resyncRetryAvailable = true
  private disposed = false

  /** The client identity one Orca connection presents; stable for the channel's life. */
  private readonly clientId = `orca-${randomUUID()}`
  private initialFrameSettled = false
  private initialFrameResolve: (() => void) | null = null
  private initialFrame = new Promise<void>((resolve) => {
    this.initialFrameResolve = resolve
  })

  constructor(
    translator: ZcodeV4ConversationTranslator,
    private readonly connection: ZcodeAgentConnection,
    private readonly sessionId: string
  ) {
    this.translator = translator
  }

  /** Arms the subscription; false means this CLI has no v4 conversation surface. */
  async arm(providerSessionId: string): Promise<boolean> {
    if (this.disposed) {
      return false
    }
    this.connectionId = `orca-${providerSessionId}`
    const topic = conversationTopic(providerSessionId)
    this.topic = topic
    this.subscriptionFrames.begin(topic)
    const params = zcodeV4ConversationSubscribeParamsSchema.parse({
      topic,
      connectionId: this.connectionId,
      clientMode: 'desktop-continuous',
      visibility: 'foreground'
    })
    try {
      const ack = zcodeV4SubscribeResultSchema.parse(
        await this.connection.request(V4_METHODS.conversationSubscribe, params, 10_000)
      )
      this.subscriptionId = ack.subscriptionId
      if (this.disposed) {
        await this.unsubscribe().catch(() => undefined)
        return false
      }
      this.translator.seedLogEpoch(ack.logEpoch)
      for (const result of this.subscriptionFrames.bind(ack.subscriptionId)) {
        this.readyEvents.push(...this.applyFrameResult(result))
      }
      await this.waitForInitialFrame()
      return !this.disposed
    } catch {
      await this.unsubscribe().catch(() => undefined)
      this.connectionId = null
      this.topic = null
      this.subscriptionId = null
      this.subscriptionFrames.clear()
      this.readyEvents.length = 0
      return false
    }
  }

  /** Routes one notification; non-frame methods yield nothing. */
  handle(method: string, params: unknown): ProviderTimelineEvent[] {
    if (this.disposed || method !== 'v4/conversation/frame') {
      return []
    }
    const parsed = zcodeV4FrameNotificationSchema.safeParse({ method, params })
    if (!parsed.success) {
      return []
    }
    return this.applyFrameResult(this.subscriptionFrames.route(parsed.data.params))
  }

  drainReadyEvents(): ProviderTimelineEvent[] {
    return this.readyEvents.splice(0)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.resyncQueued = false
    this.subscriptionFrames.clear()
    this.readyEvents.length = 0
    if (!this.initialFrameSettled) {
      this.initialFrameSettled = true
      this.initialFrameResolve?.()
      this.initialFrameResolve = null
    }
    void this.unsubscribe().catch(() => undefined)
  }

  private applyFrameResult(
    result: ReturnType<ZcodeV4SubscriptionFrames['route']>
  ): ProviderTimelineEvent[] {
    if (result.status === 'failed') {
      void this.resync()
      return []
    }
    if (result.status !== 'complete') {
      return []
    }
    if (result.frame.payload.kind === 'snapshot') {
      this.resyncQueued = false
      this.resyncRetryAvailable = true
    }
    const events = this.translator.apply(result.frame)
    if (!this.initialFrameSettled) {
      this.initialFrameSettled = true
      this.initialFrameResolve?.()
      this.initialFrameResolve = null
    }
    return events
  }

  private resync(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.resyncing) {
      if (this.resyncRetryAvailable) {
        this.resyncRetryAvailable = false
        this.resyncQueued = true
      }
      return this.resyncing
    }
    const watermark = this.translator.watermark()
    if (!this.subscriptionId || !this.connectionId || !this.topic || !watermark.logEpoch) {
      return Promise.resolve()
    }
    const request = this.connection
      .request(
        V4_METHODS.conversationResync,
        {
          topic: this.topic,
          connectionId: this.connectionId,
          subscriptionId: this.subscriptionId,
          base: { logEpoch: watermark.logEpoch, seq: watermark.seq },
          forceSnapshot: true
        },
        10_000
      )
      .then(() => undefined)
      .catch(() => {
        this.subscriptionFrames.retryRecovery()
      })
      .finally(() => {
        if (this.resyncing !== request) {
          return
        }
        this.resyncing = null
        if (!this.disposed && this.resyncQueued) {
          this.resyncQueued = false
          void this.resync()
        }
      })
    this.resyncing = request
    return request
  }

  private unsubscribe(): Promise<unknown> {
    if (!this.connectionId || !this.topic || !this.subscriptionId) {
      return Promise.resolve()
    }
    return this.connection.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: this.topic,
        subscriptionId: this.subscriptionId,
        connectionId: this.connectionId
      },
      10_000
    )
  }

  private async waitForInitialFrame(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.initialFrame,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('zcode v4 initial conversation frame timed out')),
            INITIAL_SNAPSHOT_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  watermark(): { logEpoch: string | null; seq: number } {
    return this.translator.watermark()
  }

  /** Pops the child-work evidence the subagent rows accumulated since the last drain. */
  drainChildWorkEvidence() {
    return this.translator.drainChildWorkEvidence()
  }

  /** The revision CAS commands compare against; undefined until a frame carries one. */
  revision(): number | undefined {
    return this.translator.revision()
  }

  logEpoch(): string | null {
    return this.translator.watermark().logEpoch
  }

  /** Uploads one attachment through begin → chunk* → commit, resuming from the server cursor. */
  uploadAttachment(input: {
    fileName: string
    mime: string
    bytes: Buffer
    signal?: AbortSignal
  }): Promise<ZcodeV4AttachmentRef> {
    if (!this.connectionId) {
      return Promise.reject(new Error('zcode v4: the channel is not armed'))
    }
    return uploadZcodeV4Attachment({
      connection: this.connection,
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      ...input
    })
  }

  abortAttachment(uploadId: string): Promise<void> {
    return this.connectionId
      ? abortZcodeV4Attachment({
          connection: this.connection,
          connectionId: this.connectionId,
          uploadId,
          sessionId: this.sessionId
        })
      : Promise.resolve()
  }

  rowsBefore(beforeRowId: number): Promise<ZcodeV4ConversationRow[]> {
    return readZcodeV4RowsBefore({
      connection: this.connection,
      sessionId: this.sessionId,
      beforeRowId,
      logEpoch: this.logEpoch()
    })
  }

  /** Sends one command envelope. A `duplicate` ack replays the original outcome, so it
   *  resolves like an acceptance; every other non-accepted status rejects. */
  async command(
    type: string,
    payload: Record<string, unknown>,
    options?: { cas?: boolean; rowTarget?: boolean; commandId?: string }
  ): Promise<ZcodeV4CommandAck> {
    const revision = this.translator.revision()
    if (options?.cas && revision === undefined) {
      throw new Error(`zcode v4 command ${type} needs a state revision; none has arrived`)
    }
    if (options?.rowTarget && !this.logEpoch()) {
      throw new Error(`zcode v4 command ${type} needs a row log epoch; none has arrived`)
    }
    const envelope = {
      commandId: options?.commandId ?? randomUUID(),
      clientId: this.clientId,
      sessionId: this.sessionId,
      ...(options?.cas ? { baseRevision: revision } : {}),
      ...(options?.rowTarget ? { baseLogEpoch: this.translator.watermark().logEpoch } : {}),
      type,
      payload,
      issuedAt: Date.now()
    }
    const ack = zcodeV4CommandAckSchema.parse(
      await this.connection.request(V4_METHODS.command, envelope, undefined)
    )
    if (ack.commandId !== envelope.commandId) {
      throw new Error(`zcode v4 command ${type} returned a mismatched command id`)
    }
    if (ack.status !== 'accepted' && ack.status !== 'duplicate') {
      throw new ZcodeV4CommandRejectedError(type, ack)
    }
    return ack
  }
}
