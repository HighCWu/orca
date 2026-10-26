import { Loader2, RotateCcw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { formatResetCreditExpiry } from './tooltip'

type ResetCreditType = 'FIVE_HOUR' | 'WEEK'

/** The per-window confirm copy; the GLM plan issues five-hour and weekly cards separately. */
function confirmCopyOf(resetType: ResetCreditType): { title: string; body: string } {
  return resetType === 'WEEK'
    ? {
        title: translate(
          'auto.components.status.bar.StatusBar.zcode.weekCardTitle',
          'Use a weekly rate-limit reset?'
        ),
        body: translate(
          'auto.components.status.bar.StatusBar.zcode.weekCardBody',
          'This spends one GLM Coding Plan weekly rate-limit reset on this account and resets its weekly usage window immediately.'
        )
      }
    : {
        title: translate(
          'auto.components.status.bar.StatusBar.zcode.resetCreditTitle',
          'Use a rate-limit reset?'
        ),
        body: translate(
          'auto.components.status.bar.StatusBar.zcode.resetCreditBody',
          'This spends one GLM Coding Plan rate-limit reset on this account and resets its five-hour usage window immediately.'
        )
      }
}

/** The zcode reset-credit (重置卡) block for the provider details menu: inventory label, the
 *  redeem actions, and their confirm dialog. Renders nothing while no inventory is reported. */
export function ZcodeResetCreditAction({
  zcode
}: {
  zcode: ProviderRateLimits
}): React.JSX.Element | null {
  const consumeZcodeResetCredit = useAppStore((s) => s.consumeZcodeResetCredit)
  const skipConfirm = useAppStore((s) => s.settings?.skipZcodeResetCreditConfirm)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [isRedeeming, setIsRedeeming] = React.useState(false)
  const [pendingType, setPendingType] = React.useState<ResetCreditType | null>(null)
  const [skipFuture, setSkipFuture] = React.useState(false)
  const mountedRef = React.useRef(true)
  React.useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const credits = zcode.rateLimitResetCredits
  const count = credits?.availableCount ?? null
  const weekCount = credits?.weekAvailableCount ?? 0
  const expiry = count !== null ? formatResetCreditExpiry(credits?.nextExpiresAt, count) : null
  const weekExpiry =
    weekCount > 0 ? formatResetCreditExpiry(credits?.weekNextExpiresAt, weekCount) : null

  const redeem = async (resetType: ResetCreditType): Promise<void> => {
    if (isRedeeming) {
      return
    }
    setIsRedeeming(true)
    try {
      await consumeZcodeResetCredit(resetType)
    } catch (error) {
      console.error('Failed to use a zcode rate-limit reset from the status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsRedeeming(false)
      }
    }
  }

  const requestReset = (resetType: ResetCreditType): void => {
    if (skipConfirm) {
      void redeem(resetType)
      return
    }
    setSkipFuture(false)
    setPendingType(resetType)
  }

  if (count === null || (count === 0 && weekCount === 0)) {
    return null
  }
  const confirming = pendingType !== null
  const confirmCopy = pendingType !== null ? confirmCopyOf(pendingType) : null

  return (
    <>
      <Dialog open={confirming} onOpenChange={(open) => !open && setPendingType(null)}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>{confirmCopy?.title}</DialogTitle>
            <DialogDescription>{confirmCopy?.body}</DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFuture}
              onCheckedChange={(checked) => setSkipFuture(checked === true)}
            />
            <span>
              {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingType(null)}>
              {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                void (async () => {
                  if (pendingType === null) {
                    return
                  }
                  if (skipFuture) {
                    try {
                      await updateSettings({ skipZcodeResetCreditConfirm: true })
                    } catch (error) {
                      console.error('Failed to save zcode rate-limit reset preference:', error)
                    }
                  }
                  await redeem(pendingType)
                  if (mountedRef.current) {
                    setPendingType(null)
                    setSkipFuture(false)
                  }
                })()
              }}
              disabled={isRedeeming}
            >
              {isRedeeming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeeming
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenuLabel>
        <div>
          {count === 1
            ? translate(
                'auto.components.status.bar.StatusBar.zcode.oneFiveHourCard',
                '1 five-hour rate-limit reset available'
              )
            : translate(
                'auto.components.status.bar.StatusBar.zcode.fiveHourCards',
                '{{value0}} five-hour rate-limit resets available',
                { value0: count }
              )}
        </div>
        {expiry ? (
          <div className="text-[11px] font-normal text-muted-foreground">{expiry}</div>
        ) : null}
        {weekCount > 0 ? (
          <>
            <div>
              {weekCount === 1
                ? translate(
                    'auto.components.status.bar.StatusBar.zcode.oneWeekCard',
                    '1 weekly rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.StatusBar.zcode.weekCards',
                    '{{value0}} weekly rate-limit resets available',
                    { value0: weekCount }
                  )}
            </div>
            {weekExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">{weekExpiry}</div>
            ) : null}
          </>
        ) : null}
      </DropdownMenuLabel>
      {count > 0 ? (
        <DropdownMenuItem
          disabled={isRedeeming}
          onSelect={(event) => {
            event.preventDefault()
            requestReset('FIVE_HOUR')
          }}
        >
          {isRedeeming ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          {isRedeeming
            ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
            : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
        </DropdownMenuItem>
      ) : null}
      {weekCount > 0 ? (
        <DropdownMenuItem
          disabled={isRedeeming}
          onSelect={(event) => {
            event.preventDefault()
            requestReset('WEEK')
          }}
        >
          {isRedeeming ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          {translate('auto.components.status.bar.StatusBar.zcode.useWeekCard', 'Use weekly reset')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
    </>
  )
}
