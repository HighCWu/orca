import { describe, expect, it } from 'vitest'
import {
  EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS,
  parseZcodeResetCreditAttempts
} from './zcode-reset-credit-attempts'

describe('zcode reset credit attempts record', () => {
  it('round-trips an account-bound pending attempt', () => {
    const record = {
      version: 2 as const,
      pending: [
        {
          resetType: 'FIVE_HOUR' as const,
          idempotencyKey: 'k1',
          accountId: 'account-a',
          startedAt: 123
        }
      ]
    }
    expect(parseZcodeResetCreditAttempts(record)).toEqual(record)
    expect(parseZcodeResetCreditAttempts(EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS)).toEqual({
      version: 2,
      pending: []
    })
  })

  it('migrates an empty v1 record but rejects an unbound pending attempt', () => {
    expect(parseZcodeResetCreditAttempts({ version: 1, pending: [] })).toEqual({
      version: 2,
      pending: []
    })
    expect(() =>
      parseZcodeResetCreditAttempts({
        version: 1,
        pending: [{ resetType: 'FIVE_HOUR', idempotencyKey: 'k1', startedAt: 123 }]
      })
    ).toThrow('corrupt')
  })

  it('rejects unknown fields and malformed attempts', () => {
    expect(() => parseZcodeResetCreditAttempts({ version: 3, pending: [] })).toThrow('corrupt')
    expect(() =>
      parseZcodeResetCreditAttempts({
        version: 2,
        pending: [{ resetType: 'MONTH', idempotencyKey: 'k', accountId: 'account-a', startedAt: 1 }]
      })
    ).toThrow('corrupt')
    expect(() =>
      parseZcodeResetCreditAttempts({
        version: 2,
        pending: [{ resetType: 'WEEK', idempotencyKey: '', accountId: 'account-a', startedAt: 1 }]
      })
    ).toThrow('corrupt')
  })
})
