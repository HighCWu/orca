// A submission's execution options are its own dispatch's: the child switches selection before
// its send, an unchanged pick costs no wire traffic, and a pick the listing cannot name refuses
// the send instead of running another model.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import type { ZcodeAgentConnection } from './zcode-protocol-connection'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import type { ZcodeV4ConversationChannel } from './v4/zcode-v4-conversation-channel'

const SELECTION = { providerId: 'bigmodel', modelId: 'GLM-5.3' }
const OTHER_MODEL_ID = '["bigmodel","GLM-5.3-Flash"]'

function childWith(overrides?: Partial<ZcodeStructuredChild>): {
  child: ZcodeStructuredChild
  calls: string[]
} {
  const calls: string[] = []
  let v4PendingId: string | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture fills what the dispatch reads; unread scaffolding stays out.
  const child = {
    sessionId: 's1',
    fence: 1,
    acquisitionGeneration: 'g1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the v4 dispatch reads nothing of the connection; the v3 lanes have their own tests.
    connection: {
      request: vi.fn(async (method: string) => {
        calls.push(method)
        return {}
      })
    } as unknown as ZcodeAgentConnection,
    prompts: {},
    lane: null,
    resume: null,
    providerSessionId: 'sess_p',
    currentModel: SELECTION.modelId,
    currentSelection: { ...SELECTION },
    currentEffort: 'high',
    contextWindow: null,
    slashCommands: null,
    modelOptions: null,
    optionRestoreFailures: new Set(),
    launch: { cwd: '/w', workspaceId: 'w', env: {} },
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    closeRequested: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch touches only command and the two translator marks of the channel.
    v4Channel: {
      command: vi.fn(async (method: string) => {
        calls.push(method)
        return { status: 'accepted' }
      }),
      translator: {
        openPrompt: vi.fn((clientMessageId: string) => {
          v4PendingId = clientMessageId
        }),
        dropPrompt: vi.fn(() => {
          v4PendingId = null
        }),
        get pendingPromptId(): string | null {
          return v4PendingId
        }
      }
    } as unknown as ZcodeV4ConversationChannel,
    open: async () => ({ reportedOptions: {} }),
    dispose: () => {},
    ...overrides
  } as ZcodeStructuredChild
  return { child, calls }
}
function adapterWith(child: ZcodeStructuredChild): ZcodeStructuredSessionAdapter {
  const adapter = new ZcodeStructuredSessionAdapter({
    resolveLaunch: () => Promise.reject(new Error('no launch in this test'))
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test plants one live child directly; the map is otherwise acquire's to fill.
  ;(adapter as unknown as { children: Map<string, ZcodeStructuredChild> }).children.set('s1', child)
  return adapter
}

function dispatchInput(executionOptions?: Record<string, string>) {
  return {
    sessionId: 's1',
    clientMessageId: 'm1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch reads only the text blocks of a submission body.
    body: { blocks: [{ type: 'text', text: 'hi' }] } as AgentJournalMessageItem,
    ...(executionOptions ? { executionOptions } : {}),
    fence: 1
  }
}

describe('zcode execution options at dispatch', () => {
  it('revalidates immediately after choices and before the provider send', async () => {
    const { child, calls } = childWith()
    const beforeDispatch = vi.fn(async () => {
      calls.push('beforeDispatch')
    })

    await adapterWith(child).dispatch({
      ...dispatchInput({ model: OTHER_MODEL_ID, effort: 'max' }),
      beforeDispatch
    })

    expect(calls).toEqual(['switchModelConfig', 'beforeDispatch', 'sendText'])
    expect(beforeDispatch).toHaveBeenCalledOnce()
  })

  it('switches the child to the picked selection before its send', async () => {
    const { child, calls } = childWith()
    const outcome = await adapterWith(child).dispatch(
      dispatchInput({
        model: OTHER_MODEL_ID,
        effort: 'max'
      })
    )

    expect(outcome.state).toBe('admitted')
    expect(calls).toEqual(['switchModelConfig', 'sendText'])
    expect(child.v4Channel!.command).toHaveBeenCalledWith(
      'switchModelConfig',
      { provider: 'bigmodel', model: 'GLM-5.3-Flash', thought: 'max' },
      { cas: true }
    )
    expect(child.currentModel).toBe('GLM-5.3-Flash')
    expect(child.currentEffort).toBe('max')
  })

  it('revalidates the legacy path immediately before session/send', async () => {
    const { child, calls } = childWith({ v4Channel: null })
    child.connection.request = vi.fn(async (method: string) => {
      calls.push(method)
      return method === 'session/send'
        ? { sessionId: 'sess_p', accepted: true, stateRevision: 1 }
        : {}
    })
    const beforeDispatch = vi.fn(async () => {
      calls.push('beforeDispatch')
    })

    await adapterWith(child).dispatch({ ...dispatchInput(), beforeDispatch })

    expect(calls).toEqual(['beforeDispatch', 'session/send'])
  })

  it('costs the selection wire nothing when the pick matches what the child runs', async () => {
    const { child, calls } = childWith()
    await adapterWith(child).dispatch(
      dispatchInput({
        model: '["bigmodel","GLM-5.3"]',
        effort: 'high'
      })
    )

    expect(calls).toEqual(['sendText'])
  })

  it('uses and records the target model default effort instead of the previous model effort', async () => {
    const { child } = childWith({
      currentEffort: 'high',
      modelOptions: [
        {
          id: OTHER_MODEL_ID,
          label: 'GLM-5.3-Flash',
          isDefault: false,
          efforts: [],
          defaultEffort: 'medium'
        }
      ]
    })

    await adapterWith(child).setOption({
      sessionId: 's1',
      key: 'model',
      value: OTHER_MODEL_ID,
      fence: 1
    })

    expect(child.v4Channel!.command).toHaveBeenCalledWith(
      'switchModelConfig',
      { provider: 'bigmodel', model: 'GLM-5.3-Flash', thought: 'medium' },
      { cas: true }
    )
    expect(child.currentEffort).toBe('medium')
  })

  it('keeps the model an effort-only pick was made under', async () => {
    const { child, calls } = childWith()
    await adapterWith(child).dispatch(dispatchInput({ effort: 'low' }))

    expect(calls).toEqual(['switchModelConfig', 'sendText'])
    expect(child.v4Channel!.command).toHaveBeenCalledWith(
      'switchModelConfig',
      { provider: 'bigmodel', model: 'GLM-5.3', thought: 'low' },
      { cas: true }
    )
    expect(child.currentModel).toBe('GLM-5.3')
  })

  it('refuses the send when the pick names no model the listing offered', async () => {
    const { child, calls } = childWith()
    await expect(
      adapterWith(child).dispatch(dispatchInput({ model: 'not-json' }))
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)

    expect(calls).toEqual([])
    expect(child.currentModel).toBe('GLM-5.3')
  })

  it('does not retry a v4 send on the legacy wire when its result is unknown', async () => {
    const { child, calls } = childWith()
    child.v4Channel!.command = vi.fn(async (method: string) => {
      calls.push(method)
      throw new Error('request timed out')
    })

    const outcome = await adapterWith(child).dispatch(dispatchInput())

    expect(outcome).toEqual({ state: 'unknown', reason: 'request timed out' })
    expect(calls).toEqual(['sendText'])
    expect(child.connection.request).not.toHaveBeenCalled()
    expect(child.v4Channel!.translator.pendingPromptId).toBe('m1')
  })

  it('uses the client message id as the retry-stable v4 command id', async () => {
    const { child } = childWith()

    await adapterWith(child).dispatch(dispatchInput())

    expect(child.v4Channel!.command).toHaveBeenCalledWith(
      'sendText',
      { text: 'hi', requestedDelivery: 'startNow' },
      { commandId: 'm1' }
    )
  })

  it('carries no choices for a submission that names none', async () => {
    const { child, calls } = childWith()
    await adapterWith(child).dispatch(dispatchInput())

    expect(calls).toEqual(['sendText'])
  })
})

describe('zcode setOption through the same selection switch', () => {
  it('answers what the child now runs and skips a pick that changes nothing', async () => {
    const { child, calls } = childWith()
    const adapter = adapterWith(child)

    const changed = await adapter.setOption({
      sessionId: 's1',
      key: 'effort',
      value: 'low',
      fence: 1
    })
    expect(changed).toEqual({ model: 'GLM-5.3', effort: 'low' })
    expect(calls).toEqual(['switchModelConfig'])

    const unchanged = await adapter.setOption({
      sessionId: 's1',
      key: 'model',
      value: '["bigmodel","GLM-5.3"]',
      fence: 1
    })
    expect(unchanged).toEqual({ model: 'GLM-5.3', effort: 'low' })
    expect(calls).toEqual(['switchModelConfig'])
  })
})

describe('zcode held sends', () => {
  it('names the in-flight send the child holds, per wire and per session', async () => {
    const { child, calls } = childWith()
    const adapter = adapterWith(child)

    // No child owns this id: the host falls back to reading unanswered sends as held.
    expect(adapter.heldSends('other')).toBeUndefined()

    await adapter.dispatch(dispatchInput())
    expect(calls).toEqual(['sendText'])
    expect(adapter.heldSends('s1')).toEqual(new Set(['m1']))

    // The provider refused the send before any turn: nothing left to hold.
    child.v4Channel!.translator.dropPrompt()
    expect(adapter.heldSends('s1')).toEqual(new Set())
  })
})
