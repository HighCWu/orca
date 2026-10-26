import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ZcodeResetCreditsModule from '../../zcode/zcode-reset-credits'
import {
  requestZcodeResetOpportunity,
  ZcodeResetOpportunityThrottledError
} from '../../zcode/zcode-reset-credits'
import {
  nextZcodeResetOpportunityCheckAt,
  pollZcodeResetOpportunity,
  type ZcodeResetOpportunityPollState
} from './zcode-reset-opportunity-poll'

vi.mock('../../zcode/zcode-reset-credits', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeResetCreditsModule>()),
  requestZcodeResetOpportunity: vi.fn()
}))

const NOW = 1_792_800_000_000

function state(accountId: string | null = null): ZcodeResetOpportunityPollState {
  return { accountId, nextCheckAt: 0, retryIdempotencyKey: null, inFlight: null }
}

beforeEach(() => {
  vi.mocked(requestZcodeResetOpportunity).mockReset()
})

describe('zcode reset opportunity cooldown', () => {
  it('waits ten minutes after a granted opportunity', () => {
    expect(nextZcodeResetOpportunityCheckAt({ granted: true }, NOW)).toBe(NOW + 10 * 60_000)
  })

  it('floors a denied opportunity at five minutes', () => {
    expect(nextZcodeResetOpportunityCheckAt({ granted: false, nextTryAt: NOW - 1 }, NOW)).toBe(
      NOW + 5 * 60_000
    )
    expect(nextZcodeResetOpportunityCheckAt({ granted: false, nextTryAt: NOW + 60_000 }, NOW)).toBe(
      NOW + 5 * 60_000
    )
  })

  it('honors a later denied boundary and falls back for invalid values', () => {
    expect(
      nextZcodeResetOpportunityCheckAt({ granted: false, nextTryAt: NOW + 20 * 60_000 }, NOW)
    ).toBe(NOW + 20 * 60_000)
    expect(nextZcodeResetOpportunityCheckAt({ granted: false, nextTryAt: 0 }, NOW)).toBe(
      NOW + 10 * 60_000
    )
  })

  it('drops the previous account cooldown and retry key after an account switch', async () => {
    const poll = state('account-a')
    poll.nextCheckAt = Number.MAX_SAFE_INTEGER
    poll.retryIdempotencyKey = 'account-a-key'
    vi.mocked(requestZcodeResetOpportunity).mockResolvedValue({ granted: true })

    await pollZcodeResetOpportunity(poll, undefined, () => 'account-b')

    expect(requestZcodeResetOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-b' })
    )
    expect(vi.mocked(requestZcodeResetOpportunity).mock.calls[0]?.[0].idempotencyKey).not.toBe(
      'account-a-key'
    )
  })

  it('polls the new account after an old account request settles', async () => {
    let accountId = 'account-a'
    let resolve!: (value: { granted: true }) => void
    vi.mocked(requestZcodeResetOpportunity)
      .mockImplementationOnce(() => new Promise((done) => (resolve = done)))
      .mockResolvedValueOnce({ granted: true })
    const poll = state()
    const first = pollZcodeResetOpportunity(poll, undefined, () => accountId)
    await vi.waitFor(() => expect(requestZcodeResetOpportunity).toHaveBeenCalledOnce())
    accountId = 'account-b'
    const switched = pollZcodeResetOpportunity(poll, undefined, () => accountId)
    resolve({ granted: true })
    await Promise.all([first, switched])

    expect(requestZcodeResetOpportunity).toHaveBeenCalledTimes(2)
    expect(vi.mocked(requestZcodeResetOpportunity).mock.calls[1]?.[0].accountId).toBe('account-b')
    expect(poll.accountId).toBe('account-b')
    expect(poll.nextCheckAt).toBeGreaterThan(Date.now())
    expect(poll.retryIdempotencyKey).toBeNull()
  })

  it('clears cooldown and retry state when the CLI account disappears', async () => {
    const poll = state('account-a')
    poll.nextCheckAt = Number.MAX_SAFE_INTEGER
    poll.retryIdempotencyKey = 'account-a-key'

    await pollZcodeResetOpportunity(poll, undefined, () => null)

    expect(poll).toEqual({
      accountId: null,
      nextCheckAt: 0,
      retryIdempotencyKey: null,
      inFlight: null
    })
    expect(requestZcodeResetOpportunity).not.toHaveBeenCalled()
  })

  it('reuses the same key after an ambiguous failure', async () => {
    vi.mocked(requestZcodeResetOpportunity)
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce({ granted: true })
    const poll = state()
    await pollZcodeResetOpportunity(poll, undefined, () => 'account-a')
    const firstKey = poll.retryIdempotencyKey
    expect(firstKey).toBeTruthy()

    poll.nextCheckAt = 0
    await pollZcodeResetOpportunity(poll, undefined, () => 'account-a')

    expect(vi.mocked(requestZcodeResetOpportunity).mock.calls[1]?.[0].idempotencyKey).toBe(firstKey)
  })

  it('keeps the key but does not impose a cooldown after caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('refresh superseded'))
    vi.mocked(requestZcodeResetOpportunity).mockRejectedValueOnce(controller.signal.reason)
    const poll = state()

    await pollZcodeResetOpportunity(poll, controller.signal, () => 'account-a')

    expect(poll.nextCheckAt).toBe(0)
    expect(poll.retryIdempotencyKey).toBeTruthy()
  })

  it('never reuses a throttled key after switching accounts', async () => {
    let accountId = 'account-a'
    vi.mocked(requestZcodeResetOpportunity).mockRejectedValueOnce(
      new ZcodeResetOpportunityThrottledError(null)
    )
    const poll = state()
    await pollZcodeResetOpportunity(poll, undefined, () => accountId)
    const oldKey = poll.retryIdempotencyKey
    expect(oldKey).toBeTruthy()

    accountId = 'account-b'
    vi.mocked(requestZcodeResetOpportunity).mockResolvedValueOnce({ granted: true })
    await pollZcodeResetOpportunity(poll, undefined, () => accountId)

    const newCall = vi.mocked(requestZcodeResetOpportunity).mock.calls[1]?.[0]
    expect(newCall?.accountId).toBe('account-b')
    expect(newCall?.idempotencyKey).not.toBe(oldKey)
  })
})
