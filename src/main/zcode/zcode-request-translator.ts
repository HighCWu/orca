import { z } from 'zod'
import type {
  ProviderTimelineEvent,
  ProviderTimelineRequestBody
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  ZCODE_OFFICIAL_MCP_AUTH_HEADERS_REPLY,
  ZCODE_RUNTIME_PREFERENCES_REPLY,
  zcodePermissionRequestSchema,
  zcodeUserInputRequestSchema
} from './zcode-protocol-messages'

const pendingResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export type ZcodeRequestTranslation = {
  events: ProviderTimelineEvent[]
  presentation?: {
    body: ProviderTimelineRequestBody
    reply: (response: unknown) => unknown
  }
  settled?: { reply?: unknown; error?: { code: number; message: string } }
}

function userInputRequest(
  providerSessionId: string,
  request: z.infer<typeof zcodeUserInputRequestSchema>
): ZcodeRequestTranslation {
  const key = `interaction/requestUserInput:${JSON.stringify(request.requestId)}`
  const questions = request.questions
  if (questions.length === 0) {
    const options = [
      { id: 'accept', label: 'Approve' },
      { id: 'decline', label: 'Decline' }
    ]
    const body = {
      kind: 'approval' as const,
      title: request.toolName ?? 'Approval requested',
      detail: request.prompt ?? null,
      options,
      resolution: pendingResolution
    }
    return {
      events: [{ type: 'request.open', request: key, body, join: { thread: providerSessionId } }],
      presentation: {
        body,
        reply: (response) => {
          const chosen = z
            .looseObject({ kind: z.literal('option'), optionId: z.string() })
            .safeParse(response)
          if (!chosen.success) {
            return { action: 'cancel' }
          }
          return chosen.data.optionId === 'accept'
            ? { action: 'accept', content: {} }
            : { action: 'decline' }
        }
      }
    }
  }
  const optionsOf = (
    question: (typeof questions)[number]
  ): { id: string; label: string; description?: string }[] =>
    question.options.map((option) => ({
      id: option.value ?? option.label,
      label: option.label,
      ...(option.description ? { description: option.description } : {})
    }))
  const answerContentOf = (response: unknown): Record<string, unknown> => {
    const answersSchema = z.looseObject({
      kind: z.literal('answers'),
      answers: z.array(
        z.looseObject({
          questionId: z.string(),
          optionIds: z.array(z.string()).default([]),
          other: z.string().optional()
        })
      )
    })
    const parsed = answersSchema.safeParse(response)
    if (!parsed.success) {
      throw new Error('The answer does not match the questions ZCode asked')
    }
    const answers: Record<string, string> = {}
    for (const answer of parsed.data.answers) {
      const question = questions.find((_, index) => `q${index + 1}` === answer.questionId)
      if (!question) {
        throw new Error(`The answer names no question ZCode asked (${answer.questionId})`)
      }
      const chosen = answer.optionIds
        .map(
          (optionId) =>
            question.options.find((option) => (option.value ?? option.label) === optionId)?.label ??
            optionId
        )
        .join(', ')
      answers[question.question] = answer.other || chosen
    }
    return { answers }
  }
  const body =
    questions.length === 1
      ? {
          kind: 'question' as const,
          question: questions[0].question,
          options: optionsOf(questions[0]),
          resolution: pendingResolution
        }
      : {
          kind: 'question' as const,
          question: questions[0].question,
          options: optionsOf(questions[0]),
          questions: questions.map((question, index) => ({
            id: `q${index + 1}`,
            question: question.question,
            ...(question.header ? { header: question.header } : {}),
            multiSelect: question.multiSelect === true,
            options: optionsOf(question)
          })),
          resolution: pendingResolution
        }
  return {
    events: [{ type: 'request.open', request: key, body, join: { thread: providerSessionId } }],
    presentation: {
      body,
      reply: (response) => {
        if (response === null) {
          return { action: 'cancel' }
        }
        return { action: 'accept', content: answerContentOf(response) }
      }
    }
  }
}

export function translateZcodeRequest(
  providerSessionId: string,
  method: string,
  params: unknown,
  resolveProviderRuntimeAuth?: (params: unknown) => unknown
): ZcodeRequestTranslation {
  if (method === 'interaction/requestPermission') {
    const request = zcodePermissionRequestSchema.parse(params)
    const key = `interaction/requestPermission:${JSON.stringify(request.requestId)}`
    const options = request.options.map((option) => ({
      id: option.optionId,
      label: option.label ?? option.name ?? option.optionId
    }))
    const body = {
      kind: 'approval' as const,
      title: request.toolName ?? 'Permission requested',
      detail: request.reason ?? null,
      options,
      resolution: pendingResolution
    }
    return {
      events: [{ type: 'request.open', request: key, body, join: { thread: providerSessionId } }],
      presentation: {
        body,
        reply: (response) => {
          const chosen = z
            .looseObject({ kind: z.literal('option'), optionId: z.string() })
            .safeParse(response)
          if (!chosen.success) {
            return { decision: 'deny', reason: 'cancelled in Orca' }
          }
          const option = request.options.find((entry) => entry.optionId === chosen.data.optionId)
          if (!option) {
            throw new Error(
              `The answer does not match an option ZCode offered (${chosen.data.optionId})`
            )
          }
          return option.response
        }
      }
    }
  }
  if (method === 'interaction/requestUserInput') {
    return userInputRequest(providerSessionId, zcodeUserInputRequestSchema.parse(params))
  }
  if (method === 'session/requestRuntimePreferences') {
    return { events: [], settled: { reply: ZCODE_RUNTIME_PREFERENCES_REPLY } }
  }
  if (method === 'subagents/readRuntimeConfig') {
    return { events: [], settled: { reply: { kind: 'built-in-fallback' } } }
  }
  if (method === 'interaction/requestProviderRuntimeHeaders') {
    return {
      events: [],
      settled: {
        reply: resolveProviderRuntimeAuth?.(params) ?? {
          headersApplied: false,
          errorMessage: 'Orca does not provide provider runtime headers'
        }
      }
    }
  }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') {
    return { events: [], settled: { reply: ZCODE_OFFICIAL_MCP_AUTH_HEADERS_REPLY } }
  }
  return {
    events: [],
    settled: { error: { code: -32601, message: `Method not found: ${method}` } }
  }
}
