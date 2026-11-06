import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from '../components/account-usage-state'
import { getActiveProviderRateLimits, hasActiveProviderUsage } from '../components/AccountUsage'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import {
  getZcodeResetCreditSummary,
  getZcodeWeeklyResetCreditSummary
} from '../components/zcode-reset-credit'
import { ResetCreditAction } from '../components/reset-credit-action'
import { useZcodeResetCreditAction } from '../components/use-zcode-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { styles } from './mobile-accounts-screen-styles'

/**
 * The GLM Coding Plan's own usage plus its rate-limit reset action. Why not a renderProviderSection
 * call: zcode has no Orca-managed accounts to select, so the section owns its hook and confirm
 * dialog instead of the account-row machinery.
 */
export function ZcodeUsageSection({
  client,
  connected,
  snapshot,
  busyAccountId,
  now,
  onSnapshot,
  onNotice
}: {
  client: RpcClient | null
  connected: boolean
  snapshot: AccountsSnapshot | null
  busyAccountId: string | null
  now: number
  onSnapshot: (snapshot: AccountsSnapshot) => void
  onNotice: (notice: { title: string; message: string }) => void
}) {
  const t = useMobileTranslation()
  const { supported, resetting, confirmReset, confirmation, acceptReset, cancelReset } =
    useZcodeResetCreditAction({
      client,
      connected,
      accountMutationBusy: busyAccountId !== null,
      onSnapshot,
      onNotice
    })
  const activeUsage = snapshot ? getActiveProviderRateLimits(snapshot, 'zcode') : null
  if (!snapshot || !hasActiveProviderUsage(activeUsage)) {
    return null
  }
  const resetCard = getZcodeResetCreditSummary(activeUsage, now)
  const weeklyResetCredit = getZcodeWeeklyResetCreditSummary(activeUsage, now)
  return (
    <>
      <View>
        <SectionHeader title={t('accounts.zcode.title', 'GLM Coding Plan')} />
        <ListGroup style={styles.group}>
          <ListRow
            title={t('accounts.zcode.title', 'GLM Coding Plan')}
            detail={<ProviderUsageWindows limits={activeUsage} now={now} />}
          />
          {resetCard && supported && connected ? (
            <ResetCreditAction
              summary={resetCard}
              subtitleFallback={t(
                'accounts.zcode.resetSubtitle',
                'GLM Coding Plan rate-limit reset'
              )}
              useA11yLabel={t('accounts.zcode.useReset', 'Use GLM rate-limit reset')}
              busyA11yLabel={t('accounts.zcode.resetting', 'Resetting GLM rate-limit reset')}
              hintFallback={t(
                'accounts.zcode.resetHint',
                "Spends one rate-limit reset on this account's five-hour window"
              )}
              busy={resetting}
              disabled={resetting || busyAccountId !== null || !connected}
              onPress={() => confirmReset('FIVE_HOUR')}
            />
          ) : null}
          {weeklyResetCredit && supported && connected ? (
            <ResetCreditAction
              summary={weeklyResetCredit}
              subtitleFallback={t(
                'accounts.zcode.weeklyResetSubtitle',
                'GLM Coding Plan weekly rate-limit reset'
              )}
              useA11yLabel={t('accounts.zcode.useWeeklyReset', 'Use GLM weekly rate-limit reset')}
              busyA11yLabel={t(
                'accounts.zcode.resettingWeekly',
                'Resetting GLM weekly rate-limit reset'
              )}
              hintFallback={t(
                'accounts.zcode.weeklyResetHint',
                "Spends one weekly rate-limit reset on this account's weekly window"
              )}
              busy={resetting}
              disabled={resetting || busyAccountId !== null || !connected}
              onPress={() => confirmReset('WEEK')}
            />
          ) : null}
        </ListGroup>
      </View>
      <ConfirmModal
        visible={confirmation !== null}
        title={confirmation?.title ?? ''}
        message={confirmation?.message}
        confirmLabel={t('accounts.zcode.confirmReset', 'Use reset')}
        onConfirm={acceptReset}
        onCancel={cancelReset}
      />
    </>
  )
}
