import { useCallback, useRef, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from './account-usage-state'
import {
  getZcodeResetCreditSuccessCopy,
  requestZcodeResetCredit,
  type ZcodeResetCreditType
} from './zcode-reset-credit'
import { useZcodeResetCreditCapability } from './zcode-reset-credit-capability'

type ZcodeResetCreditDialog = { title: string; message: string }

export function useZcodeResetCreditAction({
  client,
  connected,
  accountMutationBusy,
  onSnapshot,
  onNotice
}: {
  client: RpcClient | null
  connected: boolean
  accountMutationBusy: boolean
  onSnapshot: (snapshot: AccountsSnapshot) => void
  onNotice: (notice: ZcodeResetCreditDialog) => void
}): {
  supported: boolean
  resetting: boolean
  confirmReset: (resetType: ZcodeResetCreditType) => void
  /** The pending confirmation prompt, or null when none is open. */
  confirmation: ZcodeResetCreditDialog | null
  acceptReset: () => void
  cancelReset: () => void
} {
  const t = useMobileTranslation()
  const supported = useZcodeResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState<ZcodeResetCreditType | null>(null)
  const inFlightRef = useRef(false)

  const consume = useCallback(
    async (resetType: ZcodeResetCreditType) => {
      if (!client || inFlightRef.current) {
        return
      }
      inFlightRef.current = true
      setResetting(true)
      try {
        onSnapshot(await requestZcodeResetCredit(client, resetType))
        onNotice(getZcodeResetCreditSuccessCopy(resetType))
      } catch (error) {
        onNotice({
          title: t('components.zcodeResetCredit.failed', 'Could not use the rate-limit reset'),
          message: error instanceof Error ? error.message : String(error)
        })
      } finally {
        inFlightRef.current = false
        setResetting(false)
      }
    },
    [client, onNotice, onSnapshot, t]
  )

  const confirmReset = useCallback(
    (resetType: ZcodeResetCreditType) => {
      if (!supported || !connected || accountMutationBusy || resetting) {
        return
      }
      setConfirming(resetType)
    },
    [accountMutationBusy, connected, resetting, supported]
  )

  const acceptReset = useCallback(() => {
    if (confirming !== null) {
      setConfirming(null)
      void consume(confirming)
    }
  }, [confirming, consume])
  const cancelReset = useCallback(() => setConfirming(null), [])
  const confirmation: ZcodeResetCreditDialog | null =
    confirming === 'WEEK'
      ? {
          title: t('components.zcodeResetCredit.confirmWeekly', 'Use a weekly rate-limit reset?'),
          message: t(
            'components.zcodeResetCredit.confirmWeeklyMessage',
            'This spends one GLM Coding Plan weekly rate-limit reset on this account and resets its weekly usage window immediately.'
          )
        }
      : confirming === 'FIVE_HOUR'
        ? {
            title: t('components.zcodeResetCredit.confirm', 'Use a rate-limit reset?'),
            message: t(
              'components.zcodeResetCredit.confirmMessage',
              'This spends one GLM Coding Plan rate-limit reset on this account and resets its five-hour usage window immediately.'
            )
          }
        : null

  return {
    supported,
    resetting,
    confirmReset,
    confirmation,
    acceptReset,
    cancelReset
  }
}
