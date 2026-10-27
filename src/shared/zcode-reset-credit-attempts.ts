import { z } from 'zod'

/** Main-owned record of rate-limit reset (重置卡) redemptions whose outcome may still be unknown.
 *  The pending idempotency key survives restarts so a retry reuses the server's dedupe instead
 *  of spending a second card. Never expose this through renderer settings APIs. */

const pendingAttemptSchema = z.strictObject({
  resetType: z.enum(['FIVE_HOUR', 'WEEK']),
  idempotencyKey: z.string().min(1).max(64),
  accountId: z.string().min(1).max(128),
  startedAt: z.number().int().positive()
})

export const zcodeResetCreditAttemptsSchema = z.strictObject({
  version: z.literal(2),
  pending: z.array(pendingAttemptSchema)
})

const emptyLegacyAttemptsSchema = z.strictObject({
  version: z.literal(1),
  pending: z.tuple([])
})

export type ZcodeResetCreditAttempts = z.infer<typeof zcodeResetCreditAttemptsSchema>

export type ZcodeResetCreditPendingAttempt = z.infer<typeof pendingAttemptSchema>

export const EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS: ZcodeResetCreditAttempts = {
  version: 2,
  pending: []
}

export function parseZcodeResetCreditAttempts(value: unknown): ZcodeResetCreditAttempts {
  const parsed = zcodeResetCreditAttemptsSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  if (emptyLegacyAttemptsSchema.safeParse(value).success) {
    return EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS
  }
  throw new Error('zcode reset-credit attempt record is corrupt')
}
