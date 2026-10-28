// The pure mappings behind the model catalog and the goal control: option rows in, chat-model
// rows out, and a pick that round-trips into the selection `session/setModel` wants.

import { describe, expect, it } from 'vitest'
import {
  zcodeModelOptionId,
  zcodeModelOptionsOf,
  zcodeModelSelectionOf
} from './zcode-session-snapshot-facts'
import { zcodeGoalActionOf } from './zcode-structured-session-adapter'
import { zcodeAttachmentsOf } from './zcode-message-attachments'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'

const snapshot = {
  session: { sessionId: 'sess_p' },
  settings: {
    model: {
      current: { providerId: 'bigmodel', modelId: 'glm-5' },
      available: [
        {
          ref: { providerId: 'bigmodel', modelId: 'glm-5' },
          label: 'GLM-5',
          description: 'flagship',
          properties: {}
        },
        {
          ref: { providerId: 'bigmodel', modelId: 'glm-5-air' },
          label: 'GLM-5 Air',
          properties: {},
          disabledReason: 'not in plan'
        },
        {
          ref: {
            providerId: 'bigmodel',
            modelId: 'glm-5',
            options: { reasoningLevel: 'high' }
          },
          label: 'GLM-5 (high)',
          properties: {}
        }
      ]
    }
  }
}

describe('zcode model catalog mapping', () => {
  it('maps available rows, marks the configured one, skips disabled rows', () => {
    const models = zcodeModelOptionsOf(snapshot)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: '["bigmodel","glm-5"]',
      label: 'GLM-5',
      isDefault: true
    })
    expect(models[1]).toMatchObject({ label: 'GLM-5 (high)', isDefault: false })
  })

  it('marks the matching model when the configured ref adds a reasoning level', () => {
    const models = zcodeModelOptionsOf({
      ...snapshot,
      settings: {
        model: {
          ...snapshot.settings.model,
          current: {
            providerId: 'bigmodel',
            modelId: 'glm-5',
            options: { reasoningLevel: 'max' }
          }
        }
      }
    })

    expect(models[0]).toMatchObject({ label: 'GLM-5', isDefault: true })
    expect(models[1]).toMatchObject({ label: 'GLM-5 (high)', isDefault: false })
  })

  it('round-trips a pick into the selection session/setModel takes', () => {
    const id = zcodeModelOptionId(snapshot.settings.model.available[0])
    expect(zcodeModelSelectionOf(id)).toEqual({ providerId: 'bigmodel', modelId: 'glm-5' })
    expect(zcodeModelSelectionOf('not-json')).toBeNull()
  })
})

describe('zcode goal action mapping', () => {
  it('maps set, replace, pause, resume and clear', () => {
    expect(zcodeGoalActionOf({ kind: 'set', objective: 'ship it' }, false)).toEqual({
      action: 'set',
      objective: 'ship it'
    })
    expect(zcodeGoalActionOf({ kind: 'set', objective: 'ship it' }, true)).toEqual({
      action: 'replace',
      objective: 'ship it'
    })
    expect(zcodeGoalActionOf({ kind: 'status', status: 'paused' }, false)).toEqual({
      action: 'pause'
    })
    expect(zcodeGoalActionOf({ kind: 'status', status: 'active' }, false)).toEqual({
      action: 'resume'
    })
    expect(zcodeGoalActionOf({ kind: 'clear' }, false)).toEqual({ action: 'clear' })
  })
})

describe('zcode send attachments', () => {
  const body = (blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks
  })

  it('maps path-based image blocks to prompt attachments', () => {
    expect(
      zcodeAttachmentsOf(
        body([
          { type: 'text', text: 'look at this' },
          { type: 'image-ref', path: '/tmp/shot.png', alt: 'screenshot' }
        ])
      )
    ).toEqual([{ kind: 'image', filename: 'shot.png', localPath: '/tmp/shot.png' }])
  })

  it('skips url-only images and returns none without them', () => {
    expect(zcodeAttachmentsOf(body([{ type: 'image-ref', url: 'https://x/img.png' }]))).toEqual([])
    expect(zcodeAttachmentsOf(body([{ type: 'text', text: 'plain' }]))).toEqual([])
  })
})
