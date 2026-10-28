import { randomUUID } from 'node:crypto'
import {
  readZcodeResetAccountId,
  requestZcodeResetOpportunity,
  ZcodeResetOpportunityThrottledError
} from '../../zcode/zcode-reset-credits'
import { zcodeCredentialStorePath } from '../zcode-usage-credentials'

export type ZcodeResetOpportunityPollState = {
  accountId: string | null
  nextCheckAt: number
  retryIdempotencyKey: string | null
  inFlight: Promise<boolean> | null
}

const MIN_DENIED_COOLDOWN_MS = 5 * 60_000
const DEFAULT_COOLDOWN_MS = 10 * 60_000

export function pollZcodeResetOpportunity(
  state: ZcodeResetOpportunityPollState,
  signal?: AbortSignal,
  readAccountId: () => string | null = () => readZcodeResetAccountId(zcodeCredentialStorePath())
): Promise<boolean> {
  const accountId = readAccountId()
  if (!accountId) {
    state.accountId = null
    state.nextCheckAt = 0
    state.retryIdempotencyKey = null
    return Promise.resolve(false)
  }
  const accountChanged = state.accountId !== accountId
  if (accountChanged) {
    state.accountId = accountId
    state.nextCheckAt = 0
    state.retryIdempotencyKey = null
  }
  const now = Date.now()
  if (now < state.nextCheckAt) {
    return Promise.resolve(false)
  }
  if (state.inFlight) {
    const active = state.inFlight
    return accountChanged
      ? active.then(() => pollZcodeResetOpportunity(state, signal, readAccountId))
      : active
  }
  const idempotencyKey = state.retryIdempotencyKey ?? randomUUID()
  const request = Promise.resolve()
    .then(() =>
      requestZcodeResetOpportunity({
        credentialStorePath: zcodeCredentialStorePath(),
        idempotencyKey,
        accountId,
        ...(signal ? { signal } : {})
      })
    )
    .then((opportunity) => {
      if (state.accountId === accountId && readAccountId() === accountId) {
        state.nextCheckAt = nextZcodeResetOpportunityCheckAt(opportunity, now)
        state.retryIdempotencyKey = null
        return opportunity.granted
      }
      return false
    })
    .catch((error: unknown) => {
      if (state.accountId === accountId && readAccountId() === accountId) {
        const throttled = error instanceof ZcodeResetOpportunityThrottledError
        state.nextCheckAt = signal?.aborted ? 0 : now + (throttled ? 10 * 60_000 : 5 * 60_000)
        state.retryIdempotencyKey = idempotencyKey
      }
      return false
    })
    .finally(() => {
      if (state.inFlight === request) {
        state.inFlight = null
      }
    })
  state.inFlight = request
  return request
}

export function nextZcodeResetOpportunityCheckAt(
  opportunity: { granted: true } | { granted: false; nextTryAt: number },
  now: number
): number {
  if (opportunity.granted) {
    return now + DEFAULT_COOLDOWN_MS
  }
  return Number.isFinite(opportunity.nextTryAt) && opportunity.nextTryAt > 0
    ? Math.max(opportunity.nextTryAt, now + MIN_DENIED_COOLDOWN_MS)
    : now + DEFAULT_COOLDOWN_MS
}
