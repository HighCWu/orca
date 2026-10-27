import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { codexResetCapabilityListSchema } from './codex-reset-credit-reply-schema'

/**
 * status.get read for the zcode reset-credit probe, with the same policy as the Codex probe:
 * a refusal, a null result and a non-object result all read as "unsupported" and never throw.
 */
export const zcodeResetCreditCapabilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.zcode-reset-credit-capability',
    method: 'status.get',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('capabilities', codexResetCapabilityListSchema)
  })
)

/** What the probe sends with, named from an operation so no module names the raw port. */
export type MobileZcodeResetCreditCapabilityRpcSender = Parameters<
  typeof zcodeResetCreditCapabilityRead.request
>[0]
