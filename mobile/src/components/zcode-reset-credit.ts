import { z } from 'zod'
import { translate } from '../i18n/mobile-i18n'
import { formatResetCountdown } from '../../../src/shared/rate-limit-reset-format'
import {
  decodeAccountsSnapshot,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'
import type { CodexResetCreditSummary } from './codex-reset-credit'
import {
  zcodeResetCreditConsume,
  type MobileZcodeResetCreditRpcSender
} from './zcode-reset-credit-consume-operations'

export type ZcodeResetCreditType = 'FIVE_HOUR' | 'WEEK'

/** The rate-limit reset inventory label the GLM Coding Plan and Codex report in the same wire shape. */
export type ZcodeResetCreditSummary = CodexResetCreditSummary

const RESET_RPC_TIMEOUT_MS = 90_000

export function getZcodeResetCreditSummary(
  limits: ProviderRateLimits | null,
  now: number
): ZcodeResetCreditSummary | null {
  const credits = limits?.rateLimitResetCredits
  const count = credits?.availableCount ?? 0
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  const expiry = credits?.nextExpiresAt
  const expiryLabel =
    typeof expiry === 'number' && Number.isFinite(expiry)
      ? formatResetCountdown(expiry - now).replace(
          /^Resets/,
          count === 1 ? 'Expires' : 'Next expires'
        )
      : null
  return {
    availableCount: count,
    availabilityLabel: `${count} ${count === 1 ? 'five-hour reset' : 'five-hour resets'} available`,
    expiryLabel
  }
}

/** The weekly-window pool rides optional fields beside codex's single-flavor inventory. */
export function getZcodeWeeklyResetCreditSummary(
  limits: ProviderRateLimits | null,
  now: number
): ZcodeResetCreditSummary | null {
  const credits = limits?.rateLimitResetCredits
  const count = credits?.weekAvailableCount ?? 0
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  const expiry = credits?.weekNextExpiresAt
  const expiryLabel =
    typeof expiry === 'number' && Number.isFinite(expiry)
      ? formatResetCountdown(expiry - now).replace(
          /^Resets/,
          count === 1 ? 'Expires' : 'Next expires'
        )
      : null
  return {
    availableCount: count,
    availabilityLabel: `${count} ${count === 1 ? 'weekly reset' : 'weekly resets'} available`,
    expiryLabel
  }
}

/** The spend has one outcome per window; every failure throws, and the sheet shows that. */
export function getZcodeResetCreditSuccessCopy(resetType: ZcodeResetCreditType): {
  title: string
  message: string
} {
  return resetType === 'WEEK'
    ? {
        title: translate('components.zcodeResetCredit.success', 'Rate limits reset'),
        message: translate(
          'components.zcodeResetCredit.weeklySuccess',
          'The weekly usage window has been reset.'
        )
      }
    : {
        title: translate('components.zcodeResetCredit.success', 'Rate limits reset'),
        message: translate(
          'components.zcodeResetCredit.fiveHourSuccess',
          'The five-hour usage window has been reset.'
        )
      }
}

const zcodeResetResultSchema = z.looseObject({ snapshot: z.unknown() })

function decodeZcodeResetResult(value: unknown): AccountsSnapshot {
  const parsed = zcodeResetResultSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Invalid reset response from host')
  }
  return decodeAccountsSnapshot(parsed.data.snapshot)
}

/**
 * One redeem; nothing is kept on the phone. The host coordinator owns the idempotency key and
 * persists it before the provider call, so a lost reply reuses the server's dedupe instead of
 * spending a second card.
 */
export async function requestZcodeResetCredit(
  client: MobileZcodeResetCreditRpcSender,
  resetType: ZcodeResetCreditType
): Promise<AccountsSnapshot> {
  const response = await zcodeResetCreditConsume.request(
    client,
    { resetType },
    {
      timeoutMs: RESET_RPC_TIMEOUT_MS
    }
  )
  return decodeZcodeResetResult(zcodeResetCreditConsume.interpret(response))
}
