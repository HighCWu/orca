import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { ProviderPanel } from './tooltip'

afterEach(() => vi.useRealTimers())

describe('ZCode reset inventory rendering', () => {
  it('shows five-hour and weekly available reset counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    const limits: ProviderRateLimits = {
      provider: 'zcode',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      rateLimitResetCredits: {
        availableCount: 2,
        nextExpiresAt: Date.now() + 60 * 60_000,
        credits: [],
        weekAvailableCount: 1,
        weekNextExpiresAt: Date.now() + 2 * 60 * 60_000
      }
    }

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: limits }))

    expect(markup).toContain('2 five-hour rate-limit resets available')
    expect(markup).toContain('1 weekly rate-limit reset available')
    expect(markup).toContain('Next expires in 1h')
    expect(markup).toContain('Expires in 2h')
  })
})
