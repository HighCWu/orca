import { RateLimitServiceFullCycleApplication } from './service-full-cycle-application'
import { randomUUID } from 'node:crypto'
import { fetchClaudeRateLimits } from '../claude-fetcher'
import { fetchCodexRateLimits } from '../codex-fetcher'
import { fetchGrokRateLimits } from '../grok-fetcher'
import { readGrokAuthSession } from '../grok-auth'
import { readZcodeResetAccountId, redeemZcodeResetCredit } from '../../zcode/zcode-reset-credits'
import { readZcodeUsageCredentials, zcodeCredentialStorePath } from '../zcode-usage-credentials'
import type { ProviderRateLimits } from './service-types'

export abstract class RateLimitServiceProviderCycles extends RateLimitServiceFullCycleApplication {
  protected async runFetchCodexOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const codexTarget = this.codexFetchTarget
    const codexGeneration = this.codexFetchGeneration
    const codexHome = await this.resolveCodexHome(codexTarget)
    // Why: return before the "fetching" mark — a skipped cycle never settles it (#STA-4422).
    if (codexHome.skip) {
      if (
        codexGeneration === this.codexFetchGeneration &&
        this.state.codex?.status === 'fetching'
      ) {
        this.updateState({ ...this.state, codex: null })
      }
      return
    }
    const codexHomePath = codexHome.homePath
    const codexProvenance = this.getCodexProvenance(codexTarget, codexHomePath)
    const previousState = this.state

    this.updateState({
      ...previousState,
      codex: this.withFetchingStatus(previousState.codex, 'codex')
    })

    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    const codex = await (
      missingWslCodexHome
        ? Promise.resolve(missingWslCodexHome)
        : fetchCodexRateLimits({
            codexHomePath,
            networkProxySettings: this.networkProxySettingsResolver?.(),
            signal
          })
    ).catch((err): ProviderRateLimits => ({
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    const latestCodexHome = await this.resolveCodexHome(codexTarget)
    if (latestCodexHome.skip && codexGeneration === this.codexFetchGeneration) {
      this.updateState({
        ...this.state,
        codex: previousState.codex?.status === 'fetching' ? null : previousState.codex
      })
      return
    }
    const shouldApplyCodex =
      !latestCodexHome.skip &&
      codexGeneration === this.codexFetchGeneration &&
      codexProvenance === this.getCodexProvenance(codexTarget, latestCodexHome.homePath)

    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    this.updateState({
      ...this.state,
      codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
    })
  }

  protected async runFetchClaudeOnlyCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    if (signal.aborted) {
      return
    }
    // Why: automated checks must honor the endpoint's Retry-After even when live display is available.
    if (!options?.force && this.shouldSkipAutomatedFetch('claude', this.state.claude)) {
      return
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const previousState = this.state

    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude')
    })

    const claude = await fetchClaudeRateLimits({
      authPreparation: claudeAuthPreparation,
      allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
      allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    }).catch((err): ProviderRateLimits => ({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const shouldApplyClaude =
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claude)
    }
    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.resolveClaudeFetchApply(claude, previousState.claude)
        : this.state.claude
    })
  }

  protected async runFetchGrokOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const previousState = this.state
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    this.updateState({
      ...previousState,
      grok: this.withFetchingStatus(previousState.grok, 'grok')
    })

    const grok = await fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).catch((err): ProviderRateLimits => ({
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }))

    if (signal.aborted) {
      return
    }

    this.trackActiveFailureStreak('grok', grok)
    this.updateState({
      ...this.state,
      grok: this.applyStalePolicy(grok, previousState.grok)
    })
  }

  /** Spends one five-hour-window rate-limit reset; the next full cycle reads the refreshed quota. */
  protected async consumeZcodeResetOnCycles(
    resetType: 'FIVE_HOUR' | 'WEEK',
    idempotencyKey: string = randomUUID(),
    accountId?: string
  ): Promise<string> {
    const planConfig = this.resolveZcodePlanConfig()
    if (
      planConfig.error ||
      planConfig.config.apiKey ||
      readZcodeUsageCredentials().status !== 'ok'
    ) {
      throw new Error('zcode rate-limit resets require the active ZCode CLI account')
    }
    const credentialStorePath = zcodeCredentialStorePath()
    const resetAccountId = accountId ?? readZcodeResetAccountId(credentialStorePath)
    if (!resetAccountId) {
      throw new Error('zcode reset-credit account identity is unavailable')
    }
    await redeemZcodeResetCredit({
      credentialStorePath,
      resetType,
      idempotencyKey,
      accountId: resetAccountId
    })
    this.zcodeOpportunityPoll.nextCheckAt = 0
    return resetAccountId
  }
}
