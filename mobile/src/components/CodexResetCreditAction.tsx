import { ResetCreditAction } from './reset-credit-action'
import type { CodexResetCreditSummary } from './codex-reset-credit'

export function CodexResetCreditAction({
  summary,
  scopeLabel,
  busy,
  disabled,
  onPress
}: {
  summary: CodexResetCreditSummary
  scopeLabel?: string | null
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  return (
    <ResetCreditAction
      summary={summary}
      subtitleFallback="Earned Codex rate-limit reset"
      useA11yLabel="Use Codex rate-limit reset"
      busyA11yLabel="Resetting Codex rate limits"
      hintFallback="Uses one earned reset for the active Codex account"
      scopeLabel={scopeLabel}
      busy={busy}
      disabled={disabled}
      onPress={onPress}
    />
  )
}
