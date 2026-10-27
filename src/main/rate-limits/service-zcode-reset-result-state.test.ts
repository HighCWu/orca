// The post-redemption verification read: a retrying refresh until the five-hour reset shows
// through, and the pure visibility rule that decides when to stop.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type * as ZcodeUsageFetcherModule from './zcode-usage-fetcher'
import { RateLimitService } from './service'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import type * as ZcodeUsageCredentialsModule from './zcode-usage-credentials'
import { readZcodeUsageCredentials } from './zcode-usage-credentials'
import { zcodeResetUsageVisible } from './service/service-fetch-targets'
import { readZcodeResetAccountId, redeemZcodeResetCredit } from '../zcode/zcode-reset-credits'

vi.mock('./zcode-usage-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeUsageFetcherModule>()),
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./zcode-usage-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeUsageCredentialsModule>()),
  readZcodeUsageCredentials: vi.fn()
}))

vi.mock('../zcode/zcode-reset-credits', () => ({
  readZcodeResetAccountId: vi.fn(),
  redeemZcodeResetCredit: vi.fn(),
  fetchZcodeResetCredits: vi.fn(() => Promise.resolve(null)),
  requestZcodeResetOpportunity: vi.fn(),
  ZcodeResetOpportunityThrottledError: class extends Error {}
}))

function zcodeLimits(sessionUsedPercent: number): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: {
      usedPercent: sessionUsedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt: 1_700_000_000_000,
    error: null,
    status: 'ok'
  }
}

describe('zcodeResetUsageVisible', () => {
  it('follows only the five-hour window the card resets', () => {
    expect(zcodeResetUsageVisible({ ...zcodeLimits(50), status: 'error' }, null)).toBe(false)
    expect(zcodeResetUsageVisible(zcodeLimits(0), null)).toBe(true)
    expect(zcodeResetUsageVisible(zcodeLimits(50), null)).toBe(false)
    expect(zcodeResetUsageVisible(zcodeLimits(50), zcodeLimits(90))).toBe(true)
    expect(zcodeResetUsageVisible(zcodeLimits(90), zcodeLimits(90))).toBe(false)
  })

  it('follows the weekly window when the WEEK card is spent', () => {
    const previous = {
      ...zcodeLimits(90),
      weekly: {
        usedPercent: 80,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      }
    }
    expect(
      zcodeResetUsageVisible(
        { ...zcodeLimits(90), weekly: { ...previous.weekly, usedPercent: 0 } },
        previous,
        'WEEK'
      )
    ).toBe(true)
    expect(
      zcodeResetUsageVisible({ ...zcodeLimits(0), weekly: previous.weekly }, previous, 'WEEK')
    ).toBe(false)
  })

  it('ignores a weekly-only drop, which the FIVE_HOUR card does not cause', () => {
    const previous = {
      ...zcodeLimits(90),
      weekly: {
        usedPercent: 80,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      }
    }
    const fresh = {
      ...zcodeLimits(90),
      weekly: {
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      }
    }
    expect(zcodeResetUsageVisible(fresh, previous)).toBe(false)
  })
})

describe('consumeZcodeResetCredit post-redemption read', () => {
  const fetchMock = vi.mocked(fetchZcodeRateLimits)
  const redeemMock = vi.mocked(redeemZcodeResetCredit)

  beforeEach(() => {
    fetchMock.mockReset()
    redeemMock.mockReset().mockResolvedValue({ used: true })
    vi.mocked(readZcodeResetAccountId).mockReset().mockReturnValue('reset-account')
    vi.mocked(readZcodeUsageCredentials).mockReturnValue({
      status: 'ok',
      source: '/home/test/.zcode/v2/credentials.json',
      credentials: {
        apiKey: 'cli-key',
        quotaUrl: 'https://api.z.ai/api/monitor/usage/quota/limit',
        authProvenance: 'cli-account'
      }
    })
  })

  it('retries the refresh until the reset shows through and publishes that reading', async () => {
    fetchMock.mockResolvedValueOnce(zcodeLimits(90)).mockResolvedValueOnce(zcodeLimits(0))
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))

    const result = await service.consumeZcodeResetCredit('FIVE_HOUR', 'retry-key-1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: null
    })
    expect(redeemMock).toHaveBeenCalledWith(
      expect.objectContaining({ resetType: 'FIVE_HOUR', idempotencyKey: 'retry-key-1' })
    )
    expect(result.zcode?.session?.usedPercent).toBe(0)
    expect(service.getState().zcode?.session?.usedPercent).toBe(0)
  })

  it('publishes the last reading after the retries run out', async () => {
    fetchMock.mockResolvedValue(zcodeLimits(90))
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))

    const result = await service.consumeZcodeResetCredit('FIVE_HOUR')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.zcode?.session?.usedPercent).toBe(90)
  })

  it('does not publish another account after redemption', async () => {
    let accountId = 'reset-account'
    vi.mocked(readZcodeResetAccountId).mockImplementation(() => accountId)
    fetchMock.mockImplementation(async () => {
      accountId = 'other-account'
      return zcodeLimits(0)
    })
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))

    await expect(service.consumeZcodeResetCredit('FIVE_HOUR', 'retry-key-2')).rejects.toThrow(
      'account changed during refresh'
    )

    expect(service.getState().zcode).toBeNull()
  })

  it('refuses to spend CLI reset cards while a saved plan-key account is active', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: 'other-account-key' }))

    await expect(service.consumeZcodeResetCredit('FIVE_HOUR')).rejects.toThrow(
      'require the active ZCode CLI account'
    )

    expect(redeemMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to spend when no CLI quota credential can verify the reset account', async () => {
    vi.mocked(readZcodeUsageCredentials).mockReturnValue({ status: 'unavailable' })
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))

    await expect(service.consumeZcodeResetCredit('FIVE_HOUR')).rejects.toThrow(
      'require the active ZCode CLI account'
    )

    expect(redeemMock).not.toHaveBeenCalled()
  })
})
