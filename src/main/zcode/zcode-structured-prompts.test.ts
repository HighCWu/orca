import { describe, expect, it, vi } from 'vitest'
import type { ZcodeRequestContext } from './zcode-protocol-connection'
import { ZcodeStructuredPrompts } from './zcode-structured-prompts'
import type { ZcodeRequestTranslation } from './zcode-timeline-translator'

function translation(): ZcodeRequestTranslation {
  return {
    events: [
      {
        type: 'request.open',
        request: 'request-1',
        body: {
          kind: 'approval',
          title: 'Approve',
          detail: null,
          options: [{ id: 'yes', label: 'Yes' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        join: { thread: 'provider-1' }
      }
    ],
    presentation: {
      body: {
        kind: 'approval',
        title: 'Approve',
        detail: null,
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      },
      reply: () => ({ decision: 'deny' })
    }
  }
}

function context(
  abort: AbortController,
  respond = vi.fn(),
  id = 'server-1',
  settle = vi.fn()
): ZcodeRequestContext {
  return {
    id,
    respond,
    respondError: vi.fn(),
    settle,
    signal: abort.signal
  }
}

describe('zcode structured prompts', () => {
  it('moves withdrawal ownership to the latest request announcement', async () => {
    const apply = vi.fn()
    const prompts = new ZcodeStructuredPrompts(
      () => ({ apply, isRequestRow: () => true }),
      () => true
    )
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const firstRespond = vi.fn()
    const secondRespond = vi.fn()
    const first = prompts.handle(translation(), context(firstAbort, firstRespond, 'server-1'))
    const second = prompts.handle(translation(), context(secondAbort, secondRespond, 'server-2'))

    firstAbort.abort()
    await first
    expect(prompts.size).toBe(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(firstRespond).not.toHaveBeenCalled()

    secondAbort.abort()
    await second
    expect(prompts.size).toBe(0)
    expect(secondRespond).not.toHaveBeenCalled()
    expect(apply).toHaveBeenLastCalledWith([{ type: 'request.withdrawn', request: 'request-1' }])
  })

  it('settles an older live announcement when the latest one is withdrawn', async () => {
    const apply = vi.fn()
    const prompts = new ZcodeStructuredPrompts(
      () => ({ apply, isRequestRow: () => true }),
      () => true
    )
    const latestAbort = new AbortController()
    const firstRespond = vi.fn()
    const latestRespond = vi.fn()
    const first = prompts.handle(
      translation(),
      context(new AbortController(), firstRespond, 'server-1')
    )
    const latest = prompts.handle(translation(), context(latestAbort, latestRespond, 'server-2'))

    latestAbort.abort()
    await Promise.all([first, latest])

    expect(prompts.size).toBe(0)
    expect(firstRespond).toHaveBeenCalledWith({ decision: 'deny' })
    expect(latestRespond).not.toHaveBeenCalled()
    expect(apply).toHaveBeenLastCalledWith([{ type: 'request.withdrawn', request: 'request-1' }])
  })

  it('silently releases every announcement the server resolved itself', async () => {
    const prompts = new ZcodeStructuredPrompts(
      () => ({ apply: vi.fn(), isRequestRow: () => true }),
      () => true
    )
    const firstRespond = vi.fn()
    const secondRespond = vi.fn()
    const firstSettle = vi.fn()
    const secondSettle = vi.fn()
    const first = prompts.handle(
      translation(),
      context(new AbortController(), firstRespond, 'server-1', firstSettle)
    )
    const second = prompts.handle(
      translation(),
      context(new AbortController(), secondRespond, 'server-2', secondSettle)
    )

    prompts.settle('request-1')
    await Promise.all([first, second])

    expect(firstSettle).toHaveBeenCalledOnce()
    expect(secondSettle).toHaveBeenCalledOnce()
    expect(firstRespond).not.toHaveBeenCalled()
    expect(secondRespond).not.toHaveBeenCalled()
    expect(prompts.size).toBe(0)
  })

  it('settles every live announcement with the committed answer', async () => {
    const prompts = new ZcodeStructuredPrompts(
      () => ({ apply: vi.fn(), isRequestRow: () => true }),
      () => true
    )
    const firstRespond = vi.fn()
    const secondRespond = vi.fn()
    const first = prompts.handle(
      translation(),
      context(new AbortController(), firstRespond, 'server-1')
    )
    const second = prompts.handle(
      translation(),
      context(new AbortController(), secondRespond, 'server-2')
    )

    await prompts.answer({
      itemId: 'item-1',
      response: { kind: 'option', optionId: 'yes' },
      commit: () => Promise.resolve()
    })
    await Promise.all([first, second])

    expect(firstRespond).toHaveBeenCalledOnce()
    expect(firstRespond).toHaveBeenCalledWith({ decision: 'deny' })
    expect(secondRespond).toHaveBeenCalledOnce()
    expect(secondRespond).toHaveBeenCalledWith({ decision: 'deny' })
    expect(prompts.size).toBe(0)
  })
})
