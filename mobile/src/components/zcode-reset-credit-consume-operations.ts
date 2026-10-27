import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { z } from 'zod'

/**
 * Spending one zcode rate-limit reset (重置卡).
 *
 * `require-result-or-throw-message` for the same reason as the Codex redeem next door: the
 * confirm sheet shows the host's own sentence. Unlike Codex there is no client key or scope —
 * the host coordinator owns the idempotency key and zcode has one implicit account — so the
 * decoded reply is just the refreshed accounts snapshot, which `decodeZcodeResetResult`
 * (zcode-reset-credit.ts) checks.
 */
export const zcodeResetCreditConsume = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.zcode-reset-credit',
    method: 'accounts.consumeZcodeResetCredit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('zcode-reset-credit', z.unknown())
  })
)

/** What the redeem sends with, named from the operation so no module names the raw port. */
export type MobileZcodeResetCreditRpcSender = Parameters<typeof zcodeResetCreditConsume.request>[0]
