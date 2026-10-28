import type { ZcodePlanCredential } from '../zcode-usage-fetcher'
import { fetchZcodeRateLimits } from '../zcode-usage-fetcher'
import type { ProviderRateLimits } from './service-types'

export async function fetchZcodeFullCycle(input: {
  signal: AbortSignal
  planCredential: ZcodePlanCredential | null
  requestResetOpportunity: () => Promise<boolean>
}): Promise<ProviderRateLimits> {
  const initial = await fetchZcodeRateLimits({
    signal: input.signal,
    planCredential: input.planCredential
  })
  if (input.planCredential || initial.status !== 'ok') {
    return initial
  }
  const granted = await input.requestResetOpportunity().catch(() => false)
  return granted
    ? fetchZcodeRateLimits({ signal: input.signal, planCredential: input.planCredential })
    : initial
}
