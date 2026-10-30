import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZcodeUsageCredentials } from './zcode-usage-credentials'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import type * as ZcodeUsageFetcherModule from './zcode-usage-fetcher'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { hasZcodePlanApiKey } from '../zcode/zcode-plan-api-key-store'
import { readZcodeResetAccountId, requestZcodeResetOpportunity } from '../zcode/zcode-reset-credits'
import {
  deferred,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof ZcodeUsageFetcherModule>()),
  fetchZcodeRateLimits: vi.fn(),
  hasZcodeCliPlanCredentials: vi.fn(() => false)
}))

vi.mock('../zcode/zcode-reset-credits', () => ({
  redeemZcodeResetCredit: vi.fn(),
  fetchZcodeResetCredits: vi.fn(() => Promise.resolve(null)),
  readZcodeResetAccountId: vi.fn(() => null),
  requestZcodeResetOpportunity: vi.fn(),
  ZcodeResetOpportunityThrottledError: class extends Error {}
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

vi.mock('../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: vi.fn(() => false),
  readZcodePlanApiKey: vi.fn(() => null),
  saveZcodePlanApiKey: vi.fn(),
  clearZcodePlanApiKey: vi.fn()
}))

const NOW = 1_792_800_000_000

afterEach(() => vi.useRealTimers())

describe('RateLimitService zcode plan credentials', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches zcode with the site-resolved plan credential when a resolver is set', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'bigmodel', apiKey: 'glm-key' }))
    vi.mocked(hasZcodePlanApiKey).mockReturnValue(true)
    vi.mocked(fetchZcodeRateLimits).mockResolvedValueOnce(okProvider('zcode', 33, NOW))

    await service.refresh()

    expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchZcodeRateLimits).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn' }
    })
    const state = service.getState()
    expect(state.zcode?.status).toBe('ok')
    expect(state.zcode?.session?.usedPercent).toBe(33)
    expect(state.zcodePlanApiKeyConfigured).toBe(true)
    expect(requestZcodeResetOpportunity).not.toHaveBeenCalled()
  })

  it('re-reads CLI reset inventory after an opportunity is granted', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))
    vi.mocked(readZcodeResetAccountId).mockReturnValue('account-a')
    vi.mocked(requestZcodeResetOpportunity).mockResolvedValueOnce({ granted: true })
    vi.mocked(fetchZcodeRateLimits)
      .mockImplementationOnce(async () => {
        expect(requestZcodeResetOpportunity).not.toHaveBeenCalled()
        return okProvider('zcode', 12, NOW)
      })
      .mockImplementationOnce(async () => {
        expect(requestZcodeResetOpportunity).toHaveBeenCalledTimes(1)
        return {
          ...okProvider('zcode', 12, NOW),
          rateLimitResetCredits: {
            availableCount: 1,
            nextExpiresAt: NOW + 60_000,
            credits: []
          }
        }
      })

    await service.refresh()

    expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchZcodeRateLimits).toHaveBeenLastCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: null
    })
    expect(service.getState().zcode?.session?.usedPercent).toBe(12)
    expect(service.getState().zcode?.rateLimitResetCredits?.availableCount).toBe(1)
  })

  it('surfaces a resolver failure as a zcode-only error without fetching', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => {
      throw new Error('GLM Coding Plan API key could not be decrypted')
    })

    await service.refresh()

    expect(fetchZcodeRateLimits).not.toHaveBeenCalled()
    const zcode = service.getState().zcode
    expect(zcode?.status).toBe('error')
    expect(zcode?.error).toContain('could not be decrypted')
    expect(zcode?.usageMetadata?.failureKind).toBe('keychain-unavailable')
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('discards the previous zcode snapshot when the saved site changes', async () => {
    const service = new RateLimitService()
    let site: 'zai' | 'bigmodel' = 'zai'
    service.setZcodePlanConfigResolver(() => ({ site, apiKey: 'glm-key' }))
    vi.mocked(fetchZcodeRateLimits)
      .mockResolvedValueOnce(okProvider('zcode', 40, NOW))
      .mockRejectedValueOnce(new Error('Zcode quota request failed (401)'))

    await service.refresh()
    expect(service.getState().zcode?.session?.usedPercent).toBe(40)

    site = 'bigmodel'
    await service.refresh()

    const state = service.getState()
    expect(fetchZcodeRateLimits).toHaveBeenLastCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn' }
    })
    expect(state.zcode?.status).toBe('error')
    expect(state.zcode?.session).toBeNull()
  })

  it('does not apply an in-flight zcode result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstZcode = deferred<ProviderRateLimits>()
    const secondZcode = deferred<ProviderRateLimits>()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: 'glm-key' }))
    vi.mocked(fetchZcodeRateLimits)
      .mockImplementationOnce(() => firstZcode.promise)
      .mockImplementationOnce(() => secondZcode.promise)

    const firstRefresh = service.refresh()
    await vi.waitFor(() => expect(service.getState().claude?.status).toBe('ok'))

    service.invalidateZcodeCredentialState()
    const queuedRefresh = service.refresh()
    await Promise.resolve()

    firstZcode.resolve(okProvider('zcode', 50, NOW))
    await vi.waitFor(() => expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(2))

    expect(service.getState().zcode?.status).toBe('fetching')
    expect(service.getState().zcode?.session).toBeNull()

    secondZcode.resolve(okProvider('zcode', 10, NOW))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(2)
    expect(state.zcode?.session?.usedPercent).toBe(10)
  })
  it('rejects an old CLI account result after sibling-provider waits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-zcode-service-v2-'))
    const fixtures = join(import.meta.dirname, '..', 'zcode', 'fixtures', 'v2-upstream')
    vi.stubEnv('ZCODE_DATA_BASE_DIR', home)
    vi.stubEnv('ZCODE_CREDENTIAL_SECRET', 'synthetic-secret')
    // A developer shell launched by ZCode desktop exports a real personal overlay; the
    // fixture store must be read as one self-consistent account.
    vi.stubEnv('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', '')
    try {
      cpSync(join(fixtures, 'zai'), join(home, '.zcode', 'v2'), { recursive: true })
      const selected = readZcodeUsageCredentials()
      if (selected.status !== 'ok') {
        throw new Error('Synthetic fixture could not be read')
      }
      const claude = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => claude.promise)
      vi.mocked(fetchZcodeRateLimits).mockResolvedValueOnce({
        ...okProvider('zcode', 44, NOW),
        usageMetadata: {
          authProvenance: selected.credentials.authProvenance,
          credentialSource: selected.source
        }
      })
      const service = new RateLimitService()
      const refreshing = service.refresh()
      await vi.waitFor(() => expect(fetchZcodeRateLimits).toHaveBeenCalled())
      cpSync(join(fixtures, 'zai-other'), join(home, '.zcode', 'v2'), { recursive: true })
      claude.resolve(okProvider('claude', 7))
      await refreshing
      expect(service.getState().zcode?.status).toBe('unavailable')
      expect(service.getState().zcode?.session).toBeNull()
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
