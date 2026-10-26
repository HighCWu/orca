import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitRuntimeTarget } from '../../shared/rate-limit-types'
import type { CodexAccountService } from '../codex-accounts/service'
import type { ZcodeResetCreditCoordinator } from '../zcode/zcode-reset-credit-coordinator'

export function registerRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService,
  zcodeResetCredits: ZcodeResetCreditCoordinator
): void {
  ipcMain.handle('rateLimits:get', () => rateLimits.getState())
  ipcMain.handle('rateLimits:refresh', () => rateLimits.refresh())
  ipcMain.handle('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  // Why: managed desktop resets must share the mobile mutation queue and durable ledger.
  ipcMain.handle('rateLimits:consumeCodexResetCredit', () =>
    codexAccounts.consumeCurrentRateLimitResetCredit()
  )
  ipcMain.handle('rateLimits:consumeZcodeResetCredit', (_event, resetType?: string) => {
    if (resetType !== undefined && resetType !== 'FIVE_HOUR' && resetType !== 'WEEK') {
      throw new Error(`unknown zcode reset type: ${resetType}`)
    }
    return zcodeResetCredits.consumeCurrent(resetType ?? 'FIVE_HOUR')
  })
  ipcMain.handle('rateLimits:refreshClaudeForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshClaudeForTarget(target)
  )
  ipcMain.handle('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:refreshGrok', () => rateLimits.refreshGrok())
}
