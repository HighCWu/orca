export class ZcodeConnectionClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeConnectionClosedError'
  }
}

export type ZcodeRequestContext = {
  id: string
  respond: (result: unknown) => void
  respondError: (code: number, message: string) => void
  /** Releases a request the server independently resolved, without writing a second answer. */
  settle: () => void
  signal: AbortSignal
}

export type ZcodeProtocolRuntimeOptions = {
  onRequest?: (method: string, params: unknown, context: ZcodeRequestContext) => void
  onOtherLine?: (line: string) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
  onInputEnd?: () => void
  defaultRequestTimeoutMs?: number
}
