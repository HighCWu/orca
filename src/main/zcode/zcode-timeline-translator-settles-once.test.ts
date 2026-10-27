// The settle-once invariants of the zcode event translation: a terminal frame lands its
// turn end exactly once no matter how often the provider repeats or reorders its reports,
// and a session end settles everything still open.

import { describe, expect, it } from 'vitest'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

const envelope = (overrides: { type: string; turnId?: string; payload?: unknown }) => ({
  sessionId: 'sess_p',
  type: overrides.type,
  ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
  payload: overrides.payload ?? {}
})

const completedPayload = { resultType: 'success', duration: 1_000 }
const failedPayload = {
  error: { kind: 'provider', message: 'boom' }
}

function turnEnds(events: ReturnType<ZcodeTimelineTranslator['sessionEvent']>) {
  return events.filter((event) => event.type === 'turn.end')
}

describe('zcode timeline settles each turn once', () => {
  it('ignores a repeated terminal frame for the same turn', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 10)
    expect(
      turnEnds(
        translator.sessionEvent(
          envelope({ type: 'turn.completed', turnId: 'turn_1', payload: completedPayload }),
          20
        )
      )
    ).toHaveLength(1)
    expect(
      turnEnds(
        translator.sessionEvent(
          envelope({ type: 'turn.completed', turnId: 'turn_1', payload: completedPayload }),
          30
        )
      )
    ).toHaveLength(0)
  })

  it('does not re-end a completed turn when a failure frame arrives later', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 10)
    translator.sessionEvent(
      envelope({ type: 'turn.completed', turnId: 'turn_1', payload: completedPayload }),
      20
    )
    const events = translator.sessionEvent(
      envelope({ type: 'turn.failed', turnId: 'turn_1', payload: failedPayload }),
      30
    )
    expect(turnEnds(events)).toHaveLength(0)
  })

  it('settles a terminal frame for a turn that never opened', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    const events = translator.sessionEvent(
      envelope({ type: 'turn.completed', turnId: 'turn_late', payload: completedPayload }),
      10
    )
    expect(turnEnds(events)).toHaveLength(1)
    // A second report of the same never-opened turn stays settled.
    expect(
      turnEnds(
        translator.sessionEvent(
          envelope({ type: 'turn.completed', turnId: 'turn_late', payload: completedPayload }),
          20
        )
      )
    ).toHaveLength(0)
  })

  it('ignores terminal frames without a turn id', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    expect(
      turnEnds(
        translator.sessionEvent(envelope({ type: 'turn.completed', payload: completedPayload }), 10)
      )
    ).toHaveLength(0)
  })

  it('settles every open turn on a session end and stays settled afterwards', () => {
    const translator = new ZcodeTimelineTranslator('sess_p')
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_1' }), 10)
    translator.sessionEvent(envelope({ type: 'turn.started', turnId: 'turn_2' }), 15)

    const ended = translator.sessionEnded(20)
    const ends = ended.filter((event) => event.type === 'turn.end')
    expect(ends).toHaveLength(2)
    expect(ends.map((event) => ('turn' in event ? event.turn : ''))).toEqual(
      expect.arrayContaining(['turn_1', 'turn_2'])
    )
    expect(ended.find((event) => event.type === 'session.ended')).toMatchObject({
      endedAt: 20
    })

    // Post-end frames settle nothing: the session is gone.
    expect(
      turnEnds(
        translator.sessionEvent(
          envelope({ type: 'turn.completed', turnId: 'turn_1', payload: completedPayload }),
          30
        )
      )
    ).toHaveLength(0)
    expect(translator.sessionEnded(40).filter((event) => event.type === 'turn.end')).toHaveLength(0)
  })
})
