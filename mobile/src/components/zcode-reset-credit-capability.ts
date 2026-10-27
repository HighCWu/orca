import { useEffect, useState } from 'react'
import { ZCODE_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../src/shared/account-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import {
  zcodeResetCreditCapabilityRead,
  type MobileZcodeResetCreditCapabilityRpcSender
} from './zcode-reset-credit-capability-operations'

// Why: source the capability string from the shared contract so a host bump can never
// silently drift from the mobile probe.
export const MOBILE_ZCODE_RESET_CREDIT_CAPABILITY = ZCODE_RESET_CREDIT_RUNTIME_CAPABILITY

export async function readZcodeResetCreditCapability(
  client: MobileZcodeResetCreditCapabilityRpcSender
): Promise<boolean> {
  try {
    const capabilities = zcodeResetCreditCapabilityRead.interpret(
      await zcodeResetCreditCapabilityRead.request(client)
    )
    return (
      Array.isArray(capabilities) && capabilities.includes(MOBILE_ZCODE_RESET_CREDIT_CAPABILITY)
    )
  } catch {
    return false
  }
}

export function useZcodeResetCreditCapability(
  client: RpcClient | null,
  connected: boolean
): boolean {
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: a reconnect re-probes from "unsupported" so a host that loses the feature never keeps the action visible; the probe repopulates it.
    setSupported(false)
    if (!client || !connected) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setSupported(capabilities.includes(MOBILE_ZCODE_RESET_CREDIT_CAPABILITY))
    })
  }, [client, connected])

  return supported
}
