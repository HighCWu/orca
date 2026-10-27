import { randomUUID } from 'node:crypto'
import type {
  ZcodeResetCreditAttempts,
  ZcodeResetCreditPendingAttempt
} from '../../shared/zcode-reset-credit-attempts'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/profile-state-writer-errors'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { zcodeCredentialStorePath } from '../rate-limits/zcode-usage-credentials'
import { readZcodeResetAccountId, type ZcodeResetType } from './zcode-reset-credits'

type ZcodeResetCreditCoordinatorDependencies = {
  store: Pick<Store, 'getZcodeResetCreditAttempts' | 'replaceZcodeResetCreditAttemptsAndFlush'>
  rateLimits: Pick<RateLimitService, 'consumeZcodeResetCredit'>
  readAccountId?: () => string | null
}

const readCurrentAccountId = (): string | null =>
  readZcodeResetAccountId(zcodeCredentialStorePath())

/** Serializes zcode reset-credit (重置卡) redemptions and owns their idempotency keys. The pending
 *  key persists before the provider call, so a crash, a second window, or an unknown outcome
 *  reuses the server's dedupe on the next attempt instead of spending a second card. */
export class ZcodeResetCreditCoordinator {
  private stateError: Error | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly inFlight = new Map<
    string,
    Promise<Awaited<ReturnType<RateLimitService['consumeZcodeResetCredit']>>>
  >()

  constructor(private readonly dependencies: ZcodeResetCreditCoordinatorDependencies) {}

  consumeCurrent(
    resetType: ZcodeResetType
  ): Promise<Awaited<ReturnType<RateLimitService['consumeZcodeResetCredit']>>> {
    const accountId = (this.dependencies.readAccountId ?? readCurrentAccountId)()
    if (!accountId) {
      return Promise.reject(new Error('zcode reset-credit account identity is unavailable'))
    }
    // Why: a second window (or a double click) on the same account joins the in-flight
    // redemption, while an account switch must never inherit another account's result.
    const operationKey = JSON.stringify([accountId, resetType])
    const running = this.inFlight.get(operationKey)
    if (running) {
      return running
    }
    const operation = this.queue.then(() => this.consume(resetType, accountId))
    this.inFlight.set(operationKey, operation)
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    void operation
      .finally(() => {
        if (this.inFlight.get(operationKey) === operation) {
          this.inFlight.delete(operationKey)
        }
      })
      .catch(() => undefined)
    return operation
  }

  private async consume(
    resetType: ZcodeResetType,
    requestedAccountId: string
  ): Promise<Awaited<ReturnType<RateLimitService['consumeZcodeResetCredit']>>> {
    if (this.stateError) {
      throw this.stateError
    }
    const attempts = this.readAttempts()
    const pending = attempts.pending.find((attempt) => attempt.resetType === resetType)
    const accountId = (this.dependencies.readAccountId ?? readCurrentAccountId)()
    if (!accountId) {
      throw new Error('zcode reset-credit account identity is unavailable')
    }
    if (accountId !== requestedAccountId) {
      throw new Error('zcode reset-credit CLI account changed before redemption')
    }
    if (pending && pending.accountId !== accountId) {
      throw new Error('zcode reset-credit retry belongs to another CLI account')
    }
    // Why: one key per reset type and account across retries, windows, and restarts — the server
    // dedupes by key, so reuse can never spend twice or cross an account switch.
    const idempotencyKey = pending?.idempotencyKey ?? randomUUID()
    if (!pending) {
      await this.persist({
        version: 2,
        pending: [
          ...attempts.pending.filter((entry) => entry.resetType !== resetType),
          { resetType, idempotencyKey, accountId, startedAt: Date.now() }
        ]
      })
    }
    try {
      const state = await this.dependencies.rateLimits.consumeZcodeResetCredit(
        resetType,
        idempotencyKey,
        accountId
      )
      // Clear only this type's pending key: another reset type may hold a still-unresolved
      // pending key whose server dedupe a full wipe would discard.
      const remaining = this.readAttempts().pending.filter(
        (attempt) => attempt.resetType !== resetType
      )
      await this.persist({ version: 2, pending: remaining })
      return state
    } catch (error) {
      // Why: keep the pending key — the server may still have spent the card, so the next
      // attempt must reuse the key for its dedupe instead of drawing a fresh one.
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        this.stateError = new Error(
          'The zcode reset-credit record could not be persisted; further resets are refused.'
        )
      }
      throw error
    }
  }

  private readAttempts(): ZcodeResetCreditAttempts {
    try {
      return this.dependencies.store.getZcodeResetCreditAttempts()
    } catch {
      this.stateError ??= new Error(
        'The zcode reset-credit record is corrupt; further resets are refused.'
      )
      throw this.stateError
    }
  }

  private async persist(next: {
    version: 2
    pending: ZcodeResetCreditPendingAttempt[]
  }): Promise<void> {
    try {
      await this.dependencies.store.replaceZcodeResetCreditAttemptsAndFlush(next)
    } catch (error) {
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        this.stateError = new Error(
          'The zcode reset-credit record could not be persisted; further resets are refused.'
        )
      }
      throw error
    }
  }
}
