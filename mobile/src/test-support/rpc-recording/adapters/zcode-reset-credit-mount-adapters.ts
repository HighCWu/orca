import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { AccountsSnapshot } from '../../../components/accounts-snapshot'

const ACCOUNT_REVISION = 1_700_000_000_000

/**
 * The inventory the scenario spends from. The request carries no client key or scope — the host
 * coordinator owns the idempotency key — so the wire bytes are fully determined by the card type.
 */
const ZCODE_ACCOUNTS = mountFixture<AccountsSnapshot>({
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    zcode: {
      provider: 'zcode',
      session: null,
      weekly: null,
      rateLimitResetCredits: { availableCount: 1 },
      updatedAt: ACCOUNT_REVISION,
      error: null,
      status: 'ok'
    },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
})

/** Spending one zcode rate-limit reset (重置卡); the host coordinator is what makes it idempotent. */
export function zcodeResetCreditMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'accounts.zcode-reset-credit': ({ client }) => {
      const card = modules.load<typeof import('../../../components/zcode-reset-credit')>(
        'mobile/src/components/zcode-reset-credit.ts'
      )
      // Why: decode here too — a fixture the product's own reader refuses must not record.
      modules
        .load<typeof import('../../../components/accounts-snapshot')>(
          'mobile/src/components/accounts-snapshot.ts'
        )
        .decodeAccountsSnapshot(ZCODE_ACCOUNTS)
      let settled: unknown = null
      return {
        action(name, args) {
          if (name !== 'confirm') {
            throw new Error(`Unknown rate-limit reset action: ${name}`)
          }
          const resetType = args.resetType === 'WEEK' ? 'WEEK' : 'FIVE_HOUR'
          const pending = card.requestZcodeResetCredit(client, resetType)
          void pending.then(
            (refreshed) => {
              settled = { resetType, snapshot: refreshed }
            },
            () => undefined
          )
          return pending
        },
        state: () => ({ settled }),
        dispose: () => {}
      }
    }
  }
}
