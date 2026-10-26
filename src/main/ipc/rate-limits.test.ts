import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

import { registerRateLimitHandlers } from './rate-limits'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitState } from '../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS } from '../../shared/zcode-reset-credit-attempts'
import type { CodexAccountService } from '../codex-accounts/service'
import { ZcodeResetCreditCoordinator } from '../zcode/zcode-reset-credit-coordinator'

function makeCodexAccounts() {
  const consumeCurrentRateLimitResetCredit = vi.fn(() =>
    Promise.resolve({ outcome: 'noCredit', state: {} as RateLimitState })
  )
  return {
    service: { consumeCurrentRateLimitResetCredit } as unknown as CodexAccountService,
    consumeCurrentRateLimitResetCredit
  }
}

function makeZcodeResetCredits() {
  const coordinator = new ZcodeResetCreditCoordinator({
    store: {
      getZcodeResetCreditAttempts: () => EMPTY_ZCODE_RESET_CREDIT_ATTEMPTS,
      replaceZcodeResetCreditAttemptsAndFlush: () => Promise.resolve()
    },
    rateLimits: {
      consumeZcodeResetCredit: () => Promise.resolve(createEmptyRateLimitState())
    }
  })
  const consumeCurrent = vi
    .spyOn(coordinator, 'consumeCurrent')
    .mockResolvedValue(createEmptyRateLimitState())
  return { coordinator, consumeCurrent }
}

function makeService(): {
  service: RateLimitService
  refresh: ReturnType<typeof vi.fn>
  refreshGrok: ReturnType<typeof vi.fn>
  consumeCodexRateLimitResetCredit: ReturnType<typeof vi.fn>
} {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const refreshGrok = vi.fn(() => Promise.resolve({} as RateLimitState))
  const consumeCodexRateLimitResetCredit = vi.fn(() =>
    Promise.resolve({ outcome: 'noCredit', state: {} as RateLimitState })
  )
  const service = {
    getState: vi.fn(() => ({}) as RateLimitState),
    refresh,
    refreshGrok,
    refreshCodexForTarget: vi.fn(() => Promise.resolve({} as RateLimitState)),
    refreshClaudeForTarget: vi.fn(() => Promise.resolve({} as RateLimitState)),
    consumeCodexRateLimitResetCredit,
    setPollingInterval: vi.fn(() => Promise.resolve()),
    fetchInactiveClaudeAccountsOnOpen: vi.fn(() => Promise.resolve()),
    fetchInactiveCodexAccountsOnOpen: vi.fn(() => Promise.resolve())
  }
  return {
    service: service as unknown as RateLimitService,
    refresh,
    refreshGrok,
    consumeCodexRateLimitResetCredit
  }
}

describe('registerRateLimitHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
  })

  it('keeps the existing rate-limit channels registered', () => {
    const { service } = makeService()
    registerRateLimitHandlers(
      service,
      makeCodexAccounts().service,
      makeZcodeResetCredits().coordinator
    )
    expect(ipcState.handleHandlers.has('rateLimits:get')).toBe(true)
    expect(ipcState.handleHandlers.has('rateLimits:refresh')).toBe(true)
    expect(ipcState.handleHandlers.has('rateLimits:consumeZcodeResetCredit')).toBe(true)
    expect(ipcState.handleHandlers.has('rateLimits:refreshGrok')).toBe(true)
  })

  it('registers a refreshGrok channel that delegates to refreshGrok()', async () => {
    const { service, refreshGrok } = makeService()
    registerRateLimitHandlers(
      service,
      makeCodexAccounts().service,
      makeZcodeResetCredits().coordinator
    )
    const handler = ipcState.handleHandlers.get('rateLimits:refreshGrok')
    expect(handler).toBeDefined()
    await handler!({})
    expect(refreshGrok).toHaveBeenCalledTimes(1)
  })

  it('serializes desktop reset consumption through CodexAccountService', async () => {
    const { service, consumeCodexRateLimitResetCredit } = makeService()
    const codexAccounts = makeCodexAccounts()
    registerRateLimitHandlers(service, codexAccounts.service, makeZcodeResetCredits().coordinator)
    const handler = ipcState.handleHandlers.get('rateLimits:consumeCodexResetCredit')

    await handler!({})

    expect(codexAccounts.consumeCurrentRateLimitResetCredit).toHaveBeenCalledOnce()
    expect(consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('serializes zcode rate-limit reset consumption through the coordinator', async () => {
    const { service, consumeCodexRateLimitResetCredit } = makeService()
    const zcodeResetCredits = makeZcodeResetCredits()
    registerRateLimitHandlers(service, makeCodexAccounts().service, zcodeResetCredits.coordinator)
    const handler = ipcState.handleHandlers.get('rateLimits:consumeZcodeResetCredit')

    await handler!({})

    expect(zcodeResetCredits.consumeCurrent).toHaveBeenCalledWith('FIVE_HOUR')
    expect(consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()

    await handler!({}, 'WEEK')
    expect(zcodeResetCredits.consumeCurrent).toHaveBeenCalledWith('WEEK')
    expect(() => handler!({}, 'MONTH')).toThrow('unknown zcode reset type')
  })
})
