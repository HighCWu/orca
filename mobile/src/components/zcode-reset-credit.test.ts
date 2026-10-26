import { describe, expect, it, vi } from 'vitest'

import type { ProviderRateLimits } from './accounts-snapshot'
import {
  getZcodeResetCreditSuccessCopy,
  getZcodeResetCreditSummary,
  getZcodeWeeklyResetCreditSummary,
  requestZcodeResetCredit
} from './zcode-reset-credit'

function makeLimits(availableCount: number, nextExpiresAt: number | null): ProviderRateLimits {
  return {
    provider: 'zcode',
    session: null,
    weekly: null,
    rateLimitResetCredits: { availableCount, nextExpiresAt },
    updatedAt: 100,
    error: null,
    status: 'ok'
  }
}

describe('getZcodeResetCreditSummary', () => {
  const now = 1_700_000_000_000

  it('hides the action when no rate-limit reset is available', () => {
    expect(getZcodeResetCreditSummary(null, now)).toBeNull()
    expect(getZcodeResetCreditSummary(makeLimits(0, now + 60_000), now)).toBeNull()
  })

  it('formats singular and plural five-hour availability with the next expiry', () => {
    expect(getZcodeResetCreditSummary(makeLimits(1, now + 2 * 60 * 60_000), now)).toEqual({
      availableCount: 1,
      availabilityLabel: '1 five-hour reset available',
      expiryLabel: 'Expires in 2h'
    })
    expect(getZcodeResetCreditSummary(makeLimits(2, now + 90 * 60_000), now)).toEqual({
      availableCount: 2,
      availabilityLabel: '2 five-hour resets available',
      expiryLabel: 'Next expires in 1h 30m'
    })
  })
})

describe('getZcodeResetCreditSuccessCopy', () => {
  it('names the per-window outcome each spend has', () => {
    expect(getZcodeResetCreditSuccessCopy('FIVE_HOUR')).toEqual({
      title: 'Rate limits reset',
      message: 'The five-hour usage window has been reset.'
    })
    expect(getZcodeResetCreditSuccessCopy('WEEK')).toEqual({
      title: 'Rate limits reset',
      message: 'The weekly usage window has been reset.'
    })
  })
})

describe('getZcodeWeeklyResetCreditSummary', () => {
  const now = 1_700_000_000_000

  it('hides the action when no weekly card is available', () => {
    expect(getZcodeWeeklyResetCreditSummary(null, now)).toBeNull()
    expect(getZcodeWeeklyResetCreditSummary(makeLimits(1, now), now)).toBeNull()
  })

  it('labels the weekly pool with its own expiry', () => {
    const limits = {
      ...makeLimits(0, null),
      rateLimitResetCredits: {
        availableCount: 0,
        weekAvailableCount: 2,
        weekNextExpiresAt: now + 90 * 60_000
      }
    }
    expect(getZcodeWeeklyResetCreditSummary(limits, now)).toEqual({
      availableCount: 2,
      availabilityLabel: '2 weekly resets available',
      expiryLabel: 'Next expires in 1h 30m'
    })
  })
})

const REFRESHED_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

describe('requestZcodeResetCredit', () => {
  function reply(result: unknown) {
    return vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-1' }
    })
  }

  it('sends only the reset type with a 90s timeout and returns the refreshed snapshot', async () => {
    const sendRequest = reply({ snapshot: REFRESHED_SNAPSHOT })

    await expect(requestZcodeResetCredit({ sendRequest }, 'FIVE_HOUR')).resolves.toEqual(
      REFRESHED_SNAPSHOT
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'accounts.consumeZcodeResetCredit',
      { resetType: 'FIVE_HOUR' },
      { timeoutMs: 90_000 }
    )
  })

  it('surfaces the host sentence and refuses a reply without a snapshot', async () => {
    const lost = vi.fn().mockRejectedValue(new Error('gateway 502'))
    await expect(requestZcodeResetCredit({ sendRequest: lost }, 'FIVE_HOUR')).rejects.toThrow(
      'gateway 502'
    )

    await expect(
      requestZcodeResetCredit({ sendRequest: reply({ used: true }) }, 'FIVE_HOUR')
    ).rejects.toThrow('Invalid reset response from host')
    await expect(
      requestZcodeResetCredit({ sendRequest: reply(null) }, 'FIVE_HOUR')
    ).rejects.toThrow('Invalid reset response from host')
  })
})
