// ZCode event and reverse-request translation into the shared timeline grammar.

import { describe, expect, it } from 'vitest'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

const envelope = (overrides: {
  type: string
  turnId?: string
  payload?: unknown
  sessionId?: string
}) => ({
  sessionId: overrides.sessionId ?? 'sess_p',
  type: overrides.type,
  ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
  payload: overrides.payload ?? {}
})

describe('zcode timeline translator', () => {
  it('binds an Orca send to the provider turn its turn.started names', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    expect(
      translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 10)
    ).toEqual([{ type: 'turn.open', turn: 'turn_1', at: 10 }])
    translator.openPrompt('cm_1', 5)
    const events = translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_2' }), 20)
    expect(events).toEqual([
      { type: 'turn.open', turn: 'turn_2', at: 20 },
      {
        type: 'input.accepted',
        clientMessageId: 'cm_1',
        requestedAt: 5,
        join: { thread: 'sess_p', turn: 'turn_2' }
      }
    ])
  })

  it('streams assistant and reasoning deltas under named items', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const assistant = translator.sessionEvent(
      envelope({
        type: 'model.streaming',
        turnId: 'turn_1',
        payload: { kind: 'text_delta', delta: 'hello', assistantMessageId: 'msg_1' }
      }),
      1
    )
    expect(assistant).toEqual([
      {
        type: 'text.delta',
        item: { id: 'message:["msg_1","assistant"]' },
        channel: 'assistant',
        text: 'hello',
        join: { thread: 'sess_p', turn: 'turn_1' }
      }
    ])
    const reasoning = translator.sessionEvent(
      envelope({
        type: 'model.streaming',
        turnId: 'turn_1',
        payload: { kind: 'reasoning_delta', delta: 'hmm', partId: 'part_2' }
      }),
      2
    )
    expect(reasoning[0]).toMatchObject({ channel: 'reasoning', text: 'hmm' })
  })

  it('reports the provider token accounting as context usage before the turn ends', () => {
    const translator = new ZcodeTimelineTranslator('sess_p', () => 200000)
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 1)
    const events = translator.sessionEvent(
      envelope({
        type: 'turn.completed',
        turnId: 'turn_1',
        payload: {
          resultType: 'success',
          usage: {
            inputTokens: 12000,
            outputTokens: 800,
            cacheReadTokens: 3000,
            cacheWriteTokens: 200
          }
        }
      }),
      9
    )
    expect(events[0]).toEqual({
      type: 'context.usage',
      usage: {
        window: { tokens: 200000, capturedAt: 9 },
        used: {
          kind: 'estimate',
          capturedAt: 9,
          usage: {
            inputTokens: 12000,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 3000,
            outputTokens: 800
          }
        }
      },
      join: { thread: 'sess_p' }
    })
    expect(events[1]).toMatchObject({ type: 'turn.end', outcome: 'success' })
  })

  it('emits live context usage from model_complete steps on session.updated frames', () => {
    const translator = new ZcodeTimelineTranslator('sess_p', () => 200000)
    const events = translator.sessionEvent(
      envelope({
        type: 'session.updated',
        turnId: 'turn_1',
        payload: {
          querySource: 'main_turn',
          stopReason: 'tool_use',
          contextWindow: 262144,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 40 }
        }
      }),
      5
    )
    expect(events).toEqual([
      {
        type: 'context.usage',
        usage: {
          window: { tokens: 262144, capturedAt: 5 },
          used: {
            kind: 'estimate',
            capturedAt: 5,
            usage: {
              inputTokens: 100,
              cacheCreationInputTokens: 40,
              cacheReadInputTokens: 9000,
              outputTokens: 50
            }
          }
        },
        join: { thread: 'sess_p' }
      }
    ])
  })

  it('requires an explicit main-turn marker on session.updated usage frames', () => {
    const translator = new ZcodeTimelineTranslator('sess_p', () => 200000)
    expect(
      translator.sessionEvent(
        envelope({
          type: 'session.updated',
          payload: { usage: { inputTokens: 1, outputTokens: 1 } }
        }),
        5
      )
    ).toEqual([])
  })

  it('drops tool_input streaming so raw JSON never enters the prose items', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    expect(
      translator.sessionEvent(
        envelope({
          type: 'model.streaming',
          turnId: 'turn_1',
          payload: { kind: 'tool_input_delta', delta: '{"command":"ls"}' }
        }),
        3
      )
    ).toEqual([])
  })

  it('journals the reference tool result content and error messages', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const completed = translator.sessionEvent(
      envelope({
        type: 'tool.updated',
        turnId: 'turn_1',
        payload: {
          kind: 'result',
          toolCallId: 'call_1',
          toolName: 'bash',
          result: { content: 'file contents' }
        }
      }),
      3
    )
    expect(completed[0]).toMatchObject({
      type: 'item.close',
      body: { state: 'completed', output: { head: 'file contents', truncated: false } }
    })
    const failed = translator.sessionEvent(
      envelope({
        type: 'tool.updated',
        turnId: 'turn_1',
        payload: {
          kind: 'error',
          toolCallId: 'call_2',
          toolName: 'bash',
          error: { message: 'permission denied' }
        }
      }),
      4
    )
    expect(failed[0]).toMatchObject({
      type: 'item.close',
      body: { state: 'failed', output: { head: 'permission denied', truncated: false } }
    })
  })

  it('routes background-task frames that ride session.updated on the reference runtime', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const events = translator.sessionEvent(
      envelope({
        type: 'session.updated',
        turnId: 'turn_1',
        payload: { taskId: 'task_9', taskKind: 'bash', command: 'sleep 5', status: 'running' }
      }),
      6
    )
    expect(events[0]).toMatchObject({ type: 'item.update', item: 'background-task:task_9' })
    expect(translator.runningBackgroundTaskIds()).toEqual(['task_9'])
  })

  it('shows stream-recovery retries on the activity line and clears them on the next delta', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 1)
    const recovery = translator.sessionEvent(
      envelope({
        type: 'streamRecovery.updated',
        turnId: 'turn_1',
        payload: { retryNumber: 2, maxRetries: 10, message: 'connection reset' }
      }),
      5
    )
    expect(recovery).toEqual([
      {
        type: 'activity',
        text: 'Model stream interrupted — re-requesting (retry 2/10): connection reset'
      }
    ])
    const resumed = translator.sessionEvent(
      envelope({
        type: 'model.streaming',
        turnId: 'turn_1',
        payload: { kind: 'text_delta', delta: 'back', assistantMessageId: 'msg_1' }
      }),
      6
    )
    expect(resumed[0]).toEqual({ type: 'activity', text: null })
    expect(resumed[1]).toMatchObject({ type: 'text.delta', text: 'back' })
  })

  it('names a usage-limit failure and answers runtime headers gracefully', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 1)
    const events = translator.sessionEvent(
      envelope({
        type: 'turn.failed',
        turnId: 'turn_1',
        payload: {
          error: {
            type: 'model_error',
            message: 'quota insufficient',
            attribution: { statusCode: 429, providerErrorCode: 'insufficient_quota' }
          },
          turnPhase: 'model'
        }
      }),
      9
    )
    expect(events).toEqual([
      {
        type: 'item.open',
        item: 'terminal-failure:zcode:["sess_p","turn_1"]',
        body: {
          kind: 'status',
          text: expect.any(String),
          failure: { kind: 'usageLimitReached' },
          tone: 'error'
        },
        join: { thread: 'sess_p', turn: 'turn_1' }
      },
      { type: 'turn.end', turn: 'turn_1', at: 9, state: 'completed', outcome: 'failure' }
    ])
    const ordinary = translator.sessionEvent(
      envelope({
        type: 'turn.failed',
        turnId: 'turn_2',
        payload: {
          error: { type: 'model_error', message: 'boom', attribution: { statusCode: 500 } }
        }
      }),
      10
    )
    expect(ordinary).toEqual([
      { type: 'turn.end', turn: 'turn_2', at: 10, state: 'completed', outcome: 'failure' }
    ])
    const headers = translator.request('interaction/requestProviderRuntimeHeaders', {})
    expect(headers.settled).toEqual({
      reply: {
        headersApplied: false,
        errorMessage: 'Orca does not provide provider runtime headers'
      }
    })
  })

  it('seeds the context meter from a snapshot-reported total', () => {
    const translator = new ZcodeTimelineTranslator('sess_p', () => 262144)
    expect(translator.contextUsageSeedEvent(48000, 12)).toEqual({
      type: 'context.usage',
      usage: {
        window: { tokens: 262144, capturedAt: 12 },
        used: {
          kind: 'estimate',
          capturedAt: 12,
          usage: {
            inputTokens: 48000,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0
          }
        }
      },
      join: { thread: 'sess_p' }
    })
  })

  it('withdraws permission and user-input cards the server settled itself', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    expect(
      translator.sessionEvent(
        envelope({
          type: 'permission.resolved',
          payload: { requestId: 'perm_1', decision: 'deny' }
        }),
        7
      )
    ).toEqual([{ type: 'request.withdrawn', request: 'interaction/requestPermission:"perm_1"' }])
    expect(
      translator.sessionEvent(
        envelope({
          type: 'userInput.resolved',
          payload: { requestId: 'ask_1', cancelled: true }
        }),
        8
      )
    ).toEqual([{ type: 'request.withdrawn', request: 'interaction/requestUserInput:"ask_1"' }])
    expect(
      translator.sessionEvent(envelope({ type: 'permission.resolved', payload: {} }), 9)
    ).toEqual([])
  })

  it('accepts the reference model_complete usage shape and skips subagent steps', () => {
    const translator = new ZcodeTimelineTranslator('sess_p', () => 200000)
    const reference = translator.sessionEvent(
      envelope({
        type: 'session.updated',
        payload: {
          querySource: 'main_turn',
          usage: { input: 100, output: 50, reasoning: 10, cache: { read: 9000, write: 40 } }
        }
      }),
      5
    )
    expect(reference[0]).toMatchObject({
      type: 'context.usage',
      usage: {
        window: { tokens: 200000 },
        used: {
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 9000 }
        }
      }
    })
    expect(
      translator.sessionEvent(
        envelope({
          type: 'session.updated',
          payload: { querySource: 'subagent', usage: { inputTokens: 1, outputTokens: 1 } }
        }),
        6
      )
    ).toEqual([])
    expect(
      translator.sessionEvent(
        envelope({ type: 'session.updated', payload: { title: 'untitled session' } }),
        7
      )
    ).toEqual([])
  })

  it('closes a tool call from its result frame', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const events = translator.sessionEvent(
      envelope({
        type: 'tool.updated',
        turnId: 'turn_1',
        payload: { kind: 'result', toolCallId: 'call_1', toolName: 'bash', output: 'done' }
      }),
      3
    )
    expect(events).toEqual([
      {
        type: 'item.close',
        item: 'tool:"call_1"',
        body: {
          kind: 'tool-call',
          name: 'bash',
          input: null,
          callId: 'call_1',
          state: 'completed',
          output: { head: 'done', byteLength: 4, digest: expect.any(String), truncated: false }
        },
        join: { thread: 'sess_p', turn: 'turn_1' }
      }
    ])
  })

  it('ends a turn with the provider verdict', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 1)
    const events = translator.sessionEvent(
      envelope({
        type: 'turn.completed',
        turnId: 'turn_1',
        payload: { resultType: 'success', duration: 1500 }
      }),
      9
    )
    expect(events).toEqual([
      {
        type: 'turn.end',
        turn: 'turn_1',
        at: 9,
        state: 'completed',
        outcome: 'success',
        durationMs: 1500
      }
    ])
    // A second end for a settled turn is dropped.
    expect(
      translator.sessionEvent(
        envelope({ type: 'turn.completed', turnId: 'turn_1', payload: {} }),
        10
      )
    ).toEqual([])
  })

  it('labels permission buttons from the wire name before the raw option id', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const translation = translator.request('interaction/requestPermission', {
      requestId: 'perm-2',
      sessionId: 'sess_p',
      toolName: 'bash',
      options: [
        {
          optionId: 'allow_once',
          name: 'Allow once',
          kind: 'allow_once',
          response: { decision: 'allow' }
        },
        { optionId: 'deny', kind: 'deny_once', response: { decision: 'deny' } }
      ]
    })
    expect(translation.events[0]).toMatchObject({
      type: 'request.open',
      body: {
        options: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'deny', label: 'deny' }
        ]
      }
    })
  })

  it('opens a permission request and echoes the chosen option back', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const translation = translator.request('interaction/requestPermission', {
      requestId: 'perm-1',
      sessionId: 'sess_p',
      toolName: 'bash',
      reason: 'run a command',
      options: [
        { optionId: 'allow', kind: 'allow_once', response: { decision: 'allow' } },
        { optionId: 'deny', kind: 'deny_once', response: { decision: 'deny' } }
      ]
    })
    expect(translation.events).toHaveLength(1)
    expect(translation.events[0]).toMatchObject({
      type: 'request.open',
      request: 'interaction/requestPermission:"perm-1"',
      body: { kind: 'approval', title: 'bash', options: [{ id: 'allow' }, { id: 'deny' }] }
    })
    expect(translation.presentation?.reply({ kind: 'option', optionId: 'deny' })).toEqual({
      decision: 'deny'
    })
    expect(translation.presentation?.reply(null)).toEqual({
      decision: 'deny',
      reason: 'cancelled in Orca'
    })
    expect(() => translation.presentation?.reply({ kind: 'option', optionId: 'nope' })).toThrow()
  })

  it('answers host capability requests at once and fails unknown methods loudly', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const preferences = translator.request('session/requestRuntimePreferences', {
      sessionId: 'sess_p'
    })
    expect(preferences.settled?.reply).toEqual({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false
    })
    const subagents = translator.request('subagents/readRuntimeConfig', { sessionId: 'sess_p' })
    expect(subagents.settled?.reply).toEqual({ kind: 'built-in-fallback' })
    const officialMcp = translator.request('interaction/requestOfficialMcpAuthHeaders', {
      mcpKey: 'official:test'
    })
    expect(officialMcp.settled?.reply).toEqual({
      ok: false,
      reason: 'official_auth_unavailable'
    })
    const unknown = translator.request('totally/unknown', {})
    expect(unknown.settled?.error?.code).toBe(-32601)
  })

  it('settles open turns unverifiable when the session ends', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 1)
    const events = translator.sessionEnded(99)
    expect(events).toEqual([
      { type: 'turn.end', turn: 'turn_1', at: 99, state: 'completed', outcome: 'failure' },
      { type: 'session.ended', verdict: { state: 'unverifiable' }, endedAt: 99 }
    ])
  })
})

describe('zcode user input requests', () => {
  const translator = new ZcodeTimelineTranslator('sess_p')
  const askParams = {
    requestId: 'ask-1',
    sessionId: 'sess_p',
    toolName: 'AskUserQuestion',
    prompt: 'choose wisely',
    questions: [
      {
        question: 'Which framework?',
        header: 'Framework',
        multiSelect: false,
        options: [{ label: 'Vite', description: 'fast' }, { label: 'Webpack' }]
      }
    ]
  }

  it('opens a question card whose options keep their labels as ids', () => {
    const translation = translator.request('interaction/requestUserInput', askParams)
    expect(translation.events).toHaveLength(1)
    expect(translation.events[0]).toMatchObject({
      type: 'request.open',
      request: 'interaction/requestUserInput:"ask-1"',
      body: {
        kind: 'question',
        question: 'Which framework?',
        options: [
          { id: 'Vite', label: 'Vite', description: 'fast' },
          { id: 'Webpack', label: 'Webpack' }
        ]
      }
    })
  })

  it('maps an Orca answers pick to accept content keyed by question text', () => {
    const reply = translator.request('interaction/requestUserInput', askParams).presentation?.reply
    expect(
      reply?.({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['Vite'] }] })
    ).toEqual({ action: 'accept', content: { answers: { 'Which framework?': 'Vite' } } })
    expect(reply?.(null)).toEqual({ action: 'cancel' })
    expect(() =>
      reply?.({ kind: 'answers', answers: [{ questionId: 'qX', optionIds: [] }] })
    ).toThrow()
  })

  it('reads a question-less request as an approval card', () => {
    const translation = translator.request('interaction/requestUserInput', {
      requestId: 'plan-1',
      sessionId: 'sess_p',
      toolName: 'ExitPlanMode',
      prompt: 'the plan'
    })
    expect(translation.events[0]).toMatchObject({
      body: {
        kind: 'approval',
        title: 'ExitPlanMode',
        options: [{ id: 'accept' }, { id: 'decline' }]
      }
    })
    expect(translation.presentation?.reply({ kind: 'option', optionId: 'accept' })).toEqual({
      action: 'accept',
      content: {}
    })
  })
})
