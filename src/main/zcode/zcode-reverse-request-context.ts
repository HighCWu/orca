import type { ZcodeRequestContext } from './zcode-protocol-runtime-contract'

export function createZcodeReverseRequestContext(input: {
  id: string
  active: Set<AbortController>
  respond: (id: string, result: unknown) => void
  respondError: (id: string, code: number, message: string) => void
}): { context: ZcodeRequestContext; settle: () => boolean } {
  const abort = new AbortController()
  input.active.add(abort)
  const settle = (): boolean => {
    if (!input.active.delete(abort)) {
      return false
    }
    abort.abort()
    return true
  }
  return {
    settle,
    context: {
      id: input.id,
      respond: (result) => {
        if (settle()) {
          input.respond(input.id, result)
        }
      },
      respondError: (code, message) => {
        if (settle()) {
          input.respondError(input.id, code, message)
        }
      },
      settle: () => {
        settle()
      },
      signal: abort.signal
    }
  }
}
