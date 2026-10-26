// The agent's open requests to the user (permission), each held as the protocol call it is until a
// person answers it, the child exits, or the server withdraws it. ZCode re-announces the same
// business `requestId` while it waits, so an entry is keyed by that id and retains every live wire
// delivery. An answer claims the request, commits the journal compare-and-set while the claim is
// held, and only then settles each announcement with the same business result.

import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodeRequestContext } from './zcode-protocol-connection'
import type { ZcodeRequestTranslation } from './zcode-timeline-translator'
import type { ZcodeStructuredLane } from './zcode-structured-lane'

type ZcodePromptLane = Pick<ZcodeStructuredLane, 'apply' | 'isRequestRow'>

type PromptDelivery = {
  respond: (result: unknown) => void
  settle: () => void
  signal: AbortSignal
  resolve: () => void
  settled: boolean
}

type OpenRequest = {
  key: string
  reply: (response: unknown) => unknown
  deliveries: Set<PromptDelivery>
  latest: PromptDelivery | null
  claimed: boolean
  withdraw: () => void
}

export class ZcodeStructuredPrompts {
  private readonly open = new Map<string, OpenRequest>()

  constructor(
    private readonly lane: () => ZcodePromptLane | null,
    /** Whether a request arriving now belongs to a turn that may still ask the person. */
    private readonly admits: () => boolean
  ) {}

  get size(): number {
    return this.open.size
  }

  /** Answers one server request: a row the user can act on, or the translator's verdict on it. */
  handle(translation: ZcodeRequestTranslation, context: ZcodeRequestContext): Promise<unknown> {
    if (translation.settled) {
      if (translation.settled.error) {
        context.respondError(translation.settled.error.code, translation.settled.error.message)
      } else {
        context.respond(translation.settled.reply)
      }
      return Promise.resolve(translation.settled.reply)
    }
    const lane = this.lane()
    const opened = translation.events.find((event) => event.type === 'request.open')
    const presentation = translation.presentation
    if (!lane || !presentation || opened?.type !== 'request.open') {
      context.respondError(-32601, 'Unsupported ZCode client request')
      return Promise.resolve(undefined)
    }
    const key = opened.request
    const existing = this.open.get(key)
    if (existing) {
      // Every JSON-RPC announcement needs the eventual business result, even though the row stays one.
      return new Promise((resolve) => {
        const delivery = this.addDelivery(existing, context, () => resolve(undefined))
        existing.latest = delivery
      })
    }
    if (!this.admits()) {
      // No prompt of Orca's runs (a Stop or steer is cutting the turn short): nobody is there to ask.
      const reply = presentation.reply(null)
      context.respond(reply)
      return Promise.resolve(reply)
    }
    lane.apply(translation.events)
    return new Promise((resolve) => {
      const entry: OpenRequest = {
        key,
        reply: presentation.reply,
        deliveries: new Set(),
        latest: null,
        claimed: false,
        withdraw: () => {
          if (this.open.get(key) === entry) {
            this.open.delete(key)
          }
          lane.apply([{ type: 'request.withdrawn', request: key }])
          this.respondAll(entry, entry.reply(null))
        }
      }
      this.open.set(key, entry)
      entry.latest = this.addDelivery(entry, context, () => resolve(undefined))
    })
  }

  async answer(input: {
    itemId: string
    response: AgentSessionPromptResponse
    commit: () => Promise<void>
  }): Promise<void> {
    const entry = this.find(input.itemId)
    if (!entry) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    let reply: unknown
    try {
      reply = entry.reply(input.response)
    } catch (error) {
      throw new AgentSessionPromptAnswerRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    entry.claimed = true
    try {
      await input.commit()
    } catch (error) {
      entry.claimed = false
      throw error
    }
    // Delivered even after an abort raced the save: every live announcement hears the durable answer.
    this.respondAll(entry, reply)
    this.open.delete(entry.key)
  }

  /** The user dismissed the card: the journal already recorded the cancellation (the caller held
   *  the claim through its commit), so the provider hears a cancelled answer and nothing is left. */
  async dismiss(itemId: string, commit: () => Promise<void>): Promise<void> {
    const entry = this.find(itemId)
    if (!entry) {
      throw new AgentSessionPromptUnavailableError(itemId)
    }
    entry.claimed = true
    try {
      await commit()
    } catch (error) {
      entry.claimed = false
      throw error
    }
    this.open.delete(entry.key)
    this.respondAll(entry, entry.reply(null))
  }

  /** A Stop or steer: the agent hears its own cancelled reply to everything no answer has claimed. */
  withdrawAll(): void {
    for (const entry of Array.from(this.open.values())) {
      if (!entry.claimed) {
        entry.withdraw()
      }
    }
  }

  /** The server independently resolved this business request; release every wire delivery silently. */
  settle(key: string): void {
    const entry = this.open.get(key)
    if (!entry || entry.claimed) {
      return
    }
    this.open.delete(key)
    for (const delivery of Array.from(entry.deliveries)) {
      if (!delivery.settled) {
        delivery.settled = true
        delivery.settle()
        delivery.resolve()
      }
    }
    entry.deliveries.clear()
  }

  /** The child is gone: nobody can answer for it any more. */
  clear(): void {
    for (const [key, entry] of Array.from(this.open.entries())) {
      if (!entry.claimed) {
        this.open.delete(key)
      }
    }
  }

  private addDelivery(
    entry: OpenRequest,
    context: ZcodeRequestContext,
    resolve: () => void
  ): PromptDelivery {
    const delivery: PromptDelivery = {
      respond: context.respond,
      settle: context.settle,
      signal: context.signal,
      resolve,
      settled: false
    }
    entry.deliveries.add(delivery)
    context.signal.addEventListener(
      'abort',
      () => {
        if (!delivery.settled) {
          delivery.settled = true
          entry.deliveries.delete(delivery)
          delivery.resolve()
        }
        if (entry.latest === delivery && this.open.get(entry.key) === entry && !entry.claimed) {
          entry.withdraw()
        }
      },
      { once: true }
    )
    return delivery
  }

  private respondAll(entry: OpenRequest, result: unknown): void {
    for (const delivery of Array.from(entry.deliveries)) {
      if (!delivery.settled) {
        delivery.settled = true
        delivery.respond(result)
        delivery.resolve()
      }
    }
    entry.deliveries.clear()
  }

  private find(itemId: string): OpenRequest | null {
    const lane = this.lane()
    if (!lane) {
      return null
    }
    for (const entry of this.open.values()) {
      if (!entry.claimed && lane.isRequestRow(itemId, entry.key)) {
        return entry
      }
    }
    return null
  }
}
