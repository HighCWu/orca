import type { Readable, Writable } from 'node:stream'
import {
  type ZcodeProtocolFrame,
  zcodeProtocolFrameSchema,
  zcodeStorageStateSchema
} from './zcode-protocol-messages'
import {
  ZcodeConnectionClosedError,
  type ZcodeProtocolRuntimeOptions
} from './zcode-protocol-runtime-contract'
import { createZcodeReverseRequestContext } from './zcode-reverse-request-context'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const STORAGE_READY_TIMEOUT_MS = 60_000
const MAX_LINE_CHARS = 8 * 1024 * 1024

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  cancelQueuedWrite: () => void
}

/** Stream-level protocol seam over an already-owned stdio pair; tests stand in both ends. */
export class ZcodeProtocolRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private readonly reverseRequests = new Set<AbortController>()
  private readonly gated: (() => void)[] = []
  private storageReady = false
  private storageTimer: ReturnType<typeof setTimeout> | null = null
  private buffer = ''
  private closedError?: Error
  private nextRequestId = 1

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: ZcodeProtocolRuntimeOptions = {}
  ) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.ingest(chunk))
    input.on('error', (error: Error) => this.close(error))
    input.on('end', () => {
      this.close(new ZcodeConnectionClosedError('The ZCode agent closed its protocol stream'))
    })
    output.on('error', (error: Error) => this.close(error))
    this.holdForStorage()
  }

  get closed(): boolean {
    return this.closedError !== undefined
  }

  subscribe(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }
    const id = this.nextRequestId++
    const frame: ZcodeProtocolFrame = { id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        cancelQueuedWrite: () => undefined
      }
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(String(id))) {
            pending.cancelQueuedWrite()
            reject(new Error(`ZCode agent request timed out: ${method}`))
          }
        }, timeoutMs)
      }
      this.pending.set(String(id), pending)
      pending.cancelQueuedWrite = this.send(JSON.stringify(frame), false)
    })
  }

  /** Answers a server request; only the owner of the reverse-request flow calls this. */
  respond(id: string, result: unknown): void {
    this.send(JSON.stringify({ id, result }), true)
  }

  respondError(id: string, code: number, message: string): void {
    this.send(JSON.stringify({ id, error: { code, message } }), true)
  }

  /** Ends stdin like the reference client; the child drains and exits, or its owner kills it. */
  endInput(): void {
    this.output.end()
  }

  close(error?: Error): void {
    if (this.closedError) {
      return
    }
    this.closedError = error ?? new ZcodeConnectionClosedError('The ZCode agent connection closed')
    if (this.storageTimer) {
      clearTimeout(this.storageTimer)
      this.storageTimer = null
    }
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.cancelQueuedWrite()
      pending.reject(this.closedError)
    }
    this.pending.clear()
    this.gated.length = 0
    this.buffer = ''
    for (const reverseRequest of this.reverseRequests) {
      reverseRequest.abort(this.closedError)
    }
    this.reverseRequests.clear()
    for (const listener of Array.from(this.listeners)) {
      try {
        listener('', this.closedError)
      } catch (failure) {
        this.diagnose(`ZCode close notification listener failed: ${String(failure)}`)
      }
    }
    this.listeners.clear()
    try {
      this.options.onClose?.(this.closedError)
    } catch (failure) {
      this.diagnose(`ZCode close listener failed: ${String(failure)}`)
    }
  }

  private ingest(chunk: string): void {
    if (this.closedError) {
      return
    }
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > MAX_LINE_CHARS) {
        this.close(new ZcodeConnectionClosedError('The ZCode agent sent an oversized frame'))
        return
      }
      if (line.trim().length > 0) {
        this.handleLine(line)
      }
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.close(new ZcodeConnectionClosedError('The ZCode agent sent an oversized frame'))
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      try {
        this.options.onOtherLine?.(line)
      } catch {
        /* Diagnostics cannot affect the stream. */
      }
      return
    }
    const frame = zcodeProtocolFrameSchema.safeParse(parsed)
    if (!frame.success) {
      this.diagnose('Ignored an invalid ZCode Protocol frame')
      return
    }
    const message = frame.data
    if (message.method !== undefined && message.id !== undefined) {
      this.handleServerRequest(message.method, message.params, String(message.id))
      return
    }
    if (message.method !== undefined) {
      this.handleNotification(message.method, message.params)
      return
    }
    if (message.id !== undefined) {
      this.handleReply(String(message.id), message)
    }
  }

  private handleReply(id: string, message: ZcodeProtocolFrame): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    if (message.error) {
      pending.reject(
        new Error(`ZCode agent request failed (${message.error.code}): ${message.error.message}`)
      )
      return
    }
    pending.resolve(message.result)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'startup/storageState') {
      const state = zcodeStorageStateSchema.safeParse(params)
      if (state.success) {
        this.storageStateChanged(state.data.phase, state.data.error)
      }
      return
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(method, params)
      } catch (error) {
        this.diagnose(`ZCode notification listener failed: ${String(error)}`)
      }
    }
  }

  private handleServerRequest(method: string, params: unknown, id: string): void {
    const { context, settle } = createZcodeReverseRequestContext({
      id,
      active: this.reverseRequests,
      respond: (requestId, result) => this.respond(requestId, result),
      respondError: (requestId, code, message) => this.respondError(requestId, code, message)
    })
    if (!this.options.onRequest) {
      context.respondError(-32601, `Method not found: ${method}`)
      return
    }
    try {
      this.options.onRequest(method, params, context)
    } catch (error) {
      this.diagnose(`ZCode reverse-request handler failed: ${String(error)}`)
      if (settle()) {
        this.respondError(id, -32603, String(error instanceof Error ? error.message : error))
      }
    }
  }

  private storageStateChanged(phase: string, error?: string): void {
    if (this.storageReady || this.closedError) {
      return
    }
    if (phase === 'ready') {
      this.storageReady = true
      if (this.storageTimer) {
        clearTimeout(this.storageTimer)
        this.storageTimer = null
      }
      for (const flush of this.gated.splice(0)) {
        flush()
      }
      return
    }
    if (phase === 'failed') {
      this.close(
        new ZcodeConnectionClosedError(
          `The ZCode agent storage failed: ${error ?? 'unknown error'}`
        )
      )
    }
  }

  private holdForStorage(): void {
    this.storageTimer = setTimeout(() => {
      this.close(new ZcodeConnectionClosedError('The ZCode agent storage never became ready'))
    }, STORAGE_READY_TIMEOUT_MS)
  }

  private send(line: string, response: boolean): () => void {
    if (this.closedError) {
      return () => undefined
    }
    let active = true
    const write = (): void => {
      if (active) {
        active = false
        this.output.write(`${line}\n`)
      }
    }
    // Responses to the server's own requests must flush even before storage is ready: it waits
    // on them, so gating those deadlocks the handshake it is gating for.
    if (this.storageReady || response) {
      write()
      return () => undefined
    }
    this.gated.push(write)
    return () => {
      active = false
    }
  }

  private diagnose(message: string): void {
    try {
      this.options.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot affect the stream. */
    }
  }
}

export type { ZcodeAgentConnection, ZcodeAgentConnectionOptions } from './zcode-agent-connection'
export { createZcodeAgentConnection } from './zcode-agent-connection'
export { ZcodeConnectionClosedError } from './zcode-protocol-runtime-contract'
export type {
  ZcodeProtocolRuntimeOptions,
  ZcodeRequestContext
} from './zcode-protocol-runtime-contract'
