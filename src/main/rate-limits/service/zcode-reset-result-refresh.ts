import type { ProviderRateLimits } from './service-types'
import { toErrorMessage } from './service-types'
import { fetchZcodeRateLimits } from '../zcode-usage-fetcher'
import { zcodeCredentialStorePath } from '../zcode-usage-credentials'
import { readZcodeResetAccountId } from '../../zcode/zcode-reset-credits'

const RESET_REFRESH_RETRIES = 3
const RESET_REFRESH_DELAY_MS = 250

function waitForResetRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RESET_REFRESH_DELAY_MS))
}

export function zcodeResetUsageVisible(
  fresh: ProviderRateLimits,
  previous: ProviderRateLimits | null,
  resetType: 'FIVE_HOUR' | 'WEEK' = 'FIVE_HOUR'
): boolean {
  if (fresh.status !== 'ok') {
    return false
  }
  const windowOf = (limits: ProviderRateLimits | null) =>
    resetType === 'WEEK' ? (limits?.weekly ?? null) : (limits?.session ?? null)
  const freshWindow = windowOf(fresh)
  const previousWindow = windowOf(previous)
  return previous
    ? freshWindow !== null &&
        (previousWindow === null || freshWindow.usedPercent < previousWindow.usedPercent)
    : (freshWindow?.usedPercent ?? 0) <= 0
}

export async function fetchZcodeResetResult(input: {
  previous: ProviderRateLimits | null
  resetType: 'FIVE_HOUR' | 'WEEK'
  accountId: string
  beginFetch: () => AbortController
  finishFetch: (controller: AbortController) => void
}): Promise<ProviderRateLimits> {
  const credentialStorePath = zcodeCredentialStorePath()
  let fresh: ProviderRateLimits = input.previous ?? {
    provider: 'zcode',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'fetching'
  }
  for (let attempt = 0; attempt <= RESET_REFRESH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await waitForResetRefresh()
    }
    assertZcodeResetAccount(credentialStorePath, input.accountId)
    const controller = input.beginFetch()
    try {
      fresh = await fetchZcodeRateLimits({ signal: controller.signal, planCredential: null })
    } catch (error) {
      fresh = {
        provider: 'zcode',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: toErrorMessage(error),
        status: 'error'
      }
    } finally {
      input.finishFetch(controller)
    }
    assertZcodeResetAccount(credentialStorePath, input.accountId)
    if (zcodeResetUsageVisible(fresh, input.previous, input.resetType)) {
      break
    }
  }
  return fresh
}

function assertZcodeResetAccount(credentialStorePath: string, accountId: string): void {
  if (readZcodeResetAccountId(credentialStorePath) !== accountId) {
    throw new Error('zcode reset-credit CLI account changed during refresh')
  }
}
