// The reset-credit coordinator against typed fakes: key persistence order, reuse across failures
// and concurrent calls, and the corrupt-record refusal.

import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS,
  type ZcodeResetCreditAttempts
} from '../../shared/zcode-reset-credit-attempts'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import type { ZcodeResetType } from './zcode-reset-credits'
import { ZcodeResetCreditCoordinator } from './zcode-reset-credit-coordinator'

const fakeStore = () => {
  const history: ZcodeResetCreditAttempts[] = []
  let state: ZcodeResetCreditAttempts = structuredClone(EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS)
  return {
    history,
    get state(): ZcodeResetCreditAttempts {
      return state
    },
    getZcodeResetCreditAttempts: (): ZcodeResetCreditAttempts => state,
    replaceZcodeResetCreditAttemptsAndFlush(next: ZcodeResetCreditAttempts): Promise<void> {
      state = structuredClone(next)
      history.push(structuredClone(next))
      return Promise.resolve()
    }
  } satisfies Pick<
    Store,
    'getZcodeResetCreditAttempts' | 'replaceZcodeResetCreditAttemptsAndFlush'
  > & {
    history: ZcodeResetCreditAttempts[]
    state: ZcodeResetCreditAttempts
  }
}

const fakeService = (
  behavior: (resetType: ZcodeResetType) => Promise<ReturnType<typeof createEmptyRateLimitState>>
) =>
  ({
    consumeZcodeResetCredit: vi.fn(
      (resetType: ZcodeResetType, _key?: string, _accountId?: string) => behavior(resetType)
    )
  }) satisfies Pick<RateLimitService, 'consumeZcodeResetCredit'>

describe('zcode reset credit coordinator', () => {
  it('persists the pending key before the provider call and clears it after success', async () => {
    const store = fakeStore()
    const service = fakeService(() => Promise.resolve(createEmptyRateLimitState()))
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => 'account-a'
    })
    await coordinator.consumeCurrent('FIVE_HOUR')
    expect(service.consumeZcodeResetCredit).toHaveBeenCalledWith(
      'FIVE_HOUR',
      expect.any(String),
      'account-a'
    )
    expect(store.history).toHaveLength(2)
    expect(store.history[0]?.pending).toEqual([
      {
        resetType: 'FIVE_HOUR',
        idempotencyKey: store.history[0]?.pending[0]?.idempotencyKey,
        accountId: 'account-a',
        startedAt: expect.any(Number)
      }
    ])
    expect(store.history[1]?.pending).toEqual([])
  })

  it('reuses the pending key when a retry follows a provider failure', async () => {
    const store = fakeStore()
    let fail = true
    const service = fakeService(() =>
      fail ? Promise.reject(new Error('gateway 502')) : Promise.resolve(createEmptyRateLimitState())
    )
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => 'account-a'
    })
    await expect(coordinator.consumeCurrent('FIVE_HOUR')).rejects.toThrow('gateway 502')
    expect(store.history).toHaveLength(1)
    fail = false
    await coordinator.consumeCurrent('FIVE_HOUR')
    const [firstKey, secondKey] = service.consumeZcodeResetCredit.mock.calls.map((call) => call[1])
    expect(firstKey).toBe(secondKey)
    expect(store.history.at(-1)?.pending).toEqual([])
  })

  it('answers concurrent calls with one provider operation under one key', async () => {
    const store = fakeStore()
    let finish!: () => void
    const service = fakeService(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(createEmptyRateLimitState())
        })
    )
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => 'account-a'
    })
    const pending = [
      coordinator.consumeCurrent('FIVE_HOUR'),
      coordinator.consumeCurrent('FIVE_HOUR')
    ]
    await vi.waitFor(() => expect(service.consumeZcodeResetCredit).toHaveBeenCalledTimes(1))
    finish()
    await Promise.all(pending)
    expect(service.consumeZcodeResetCredit).toHaveBeenCalledTimes(1)
    expect(store.history.at(-1)?.pending).toEqual([])
  })

  it('does not join an in-flight redemption from another CLI account', async () => {
    const store = fakeStore()
    let accountId = 'account-a'
    let finishFirst!: () => void
    let calls = 0
    const service = fakeService(() => {
      calls += 1
      return calls === 1
        ? new Promise((resolve) => {
            finishFirst = () => resolve(createEmptyRateLimitState())
          })
        : Promise.resolve(createEmptyRateLimitState())
    })
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => accountId
    })

    const first = coordinator.consumeCurrent('FIVE_HOUR')
    await vi.waitFor(() => expect(service.consumeZcodeResetCredit).toHaveBeenCalledOnce())
    accountId = 'account-b'
    const second = coordinator.consumeCurrent('FIVE_HOUR')
    finishFirst()
    await Promise.all([first, second])

    expect(service.consumeZcodeResetCredit).toHaveBeenCalledTimes(2)
    expect(service.consumeZcodeResetCredit.mock.calls.map((call) => call[2])).toEqual([
      'account-a',
      'account-b'
    ])
  })

  it('keeps a failed type’s pending key when a different type succeeds', async () => {
    const store = fakeStore()
    let failFiveHour = true
    const service = fakeService((resetType: ZcodeResetType) =>
      resetType === 'FIVE_HOUR' && failFiveHour
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(createEmptyRateLimitState())
    )
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => 'account-a'
    })

    // FIVE_HOUR fails (its key stays pending), then WEEK succeeds.
    const failure = await coordinator.consumeCurrent('FIVE_HOUR').then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    const fiveHourKey = store.state.pending.find((a) => a.resetType === 'FIVE_HOUR')?.idempotencyKey
    await coordinator.consumeCurrent('WEEK')

    expect(store.state.pending).toEqual([
      {
        resetType: 'FIVE_HOUR',
        idempotencyKey: fiveHourKey,
        accountId: 'account-a',
        startedAt: expect.any(Number)
      }
    ])
    // The failed type's retry still reuses its original key.
    failFiveHour = false
    await coordinator.consumeCurrent('FIVE_HOUR')
    expect(service.consumeZcodeResetCredit).toHaveBeenLastCalledWith(
      'FIVE_HOUR',
      fiveHourKey,
      'account-a'
    )
  })

  it('refuses to reuse an unresolved attempt after the CLI account changes', async () => {
    const store = fakeStore()
    let accountId = 'account-a'
    const service = fakeService(() => Promise.reject(new Error('gateway 502')))
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => accountId
    })

    await expect(coordinator.consumeCurrent('FIVE_HOUR')).rejects.toThrow('gateway 502')
    accountId = 'account-b'
    await expect(coordinator.consumeCurrent('FIVE_HOUR')).rejects.toThrow('another CLI account')
    expect(service.consumeZcodeResetCredit).toHaveBeenCalledTimes(1)
  })

  it('refuses further resets once the durable record reads as corrupt', async () => {
    const store = fakeStore()
    vi.spyOn(store, 'getZcodeResetCreditAttempts').mockImplementation(() => {
      throw new Error('zcode reset-credit attempt record is corrupt')
    })
    const service = fakeService(() => Promise.resolve(createEmptyRateLimitState()))
    const coordinator = new ZcodeResetCreditCoordinator({
      store,
      rateLimits: service,
      readAccountId: () => 'account-a'
    })
    await expect(coordinator.consumeCurrent('WEEK')).rejects.toThrow('corrupt')
    await expect(coordinator.consumeCurrent('WEEK')).rejects.toThrow('corrupt')
    expect(service.consumeZcodeResetCredit).not.toHaveBeenCalled()
  })
})
