import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { zcodeSessionCompactResultSchema } from './zcode-protocol-messages'
import type { ZcodeStructuredChild } from './zcode-structured-child'

const STOP_GRACE_MS = 5_000

export function zcodeGoalActionOf(
  change:
    | { kind: 'set'; objective: string }
    | { kind: 'status'; status: 'active' | 'paused' }
    | { kind: 'clear' },
  replacesGoal: boolean
): { action: string; objective?: string } {
  switch (change.kind) {
    case 'set':
      return { action: replacesGoal ? 'replace' : 'set', objective: change.objective }
    case 'status':
      return { action: change.status === 'paused' ? 'pause' : 'resume' }
    case 'clear':
      return { action: 'clear' }
  }
}

export async function compactZcodeSession(input: {
  child: ZcodeStructuredChild
  command: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0]['command']
  now: () => number
}): Promise<Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['compact']>>>> {
  const { child, command, now } = input
  const lane = child.lane
  if (!lane || !child.providerSessionId) {
    return { state: 'unknown', reason: 'the zcode child has no journal lane yet' }
  }
  lane.beginCommand(command)
  try {
    if (child.v4Channel) {
      await child.v4Channel.command('compact', {})
      return { state: 'accepted', providerIdentity: null }
    }
    const result = zcodeSessionCompactResultSchema.parse(
      await child.connection.request('session/compact', {
        sessionId: child.providerSessionId
      })
    )
    lane.apply([
      ...(result.response
        ? [
            {
              type: 'item.update' as const,
              item: 'compact:summary',
              body: {
                kind: 'status' as const,
                presentation: 'plan-document' as const,
                text: result.response
              },
              join: { thread: child.providerSessionId }
            }
          ]
        : []),
      { type: 'turn.end', at: now(), state: 'completed', outcome: 'success' }
    ])
    return { state: 'accepted', providerIdentity: null }
  } catch (error) {
    lane.forgetCommand(command.turnId)
    throw error
  }
}

export async function changeZcodeGoal(
  child: ZcodeStructuredChild,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>[0]
): Promise<Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>>> {
  if (!child.providerSessionId) {
    return { ok: false, rejected: 'the zcode child has no session yet' }
  }
  const { action, ...rest } = zcodeGoalActionOf(input.change, input.replacesGoal)
  try {
    await child.connection.request('session/goal', {
      sessionId: child.providerSessionId,
      action,
      ...rest
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, rejected: error instanceof Error ? error.message : String(error) }
  }
}

export async function awaitZcodeStoppedRequestEnd(
  child: ZcodeStructuredChild | undefined
): Promise<void> {
  const lane = child?.lane
  const turnId = lane?.openTurnId
  if (!lane || !turnId) {
    return
  }
  await Promise.race([
    lane.whenTurnLeaves(turnId),
    new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))
  ])
}

export async function cancelZcodeTurn(input: {
  child: ZcodeStructuredChild | undefined
  turnId?: string
}): Promise<Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['cancelTurn']>>>> {
  const { child, turnId } = input
  if (!child || child.ended) {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  const openTurnId = child.lane?.openTurnId ?? null
  if (turnId !== undefined && openTurnId !== null && turnId !== openTurnId) {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  const pendingDispatch =
    (child.lane?.translator.hasPendingPrompt() ?? false) ||
    (child.v4Channel?.translator.hasPendingPrompt() ?? false)
  if (openTurnId === null && child.prompts.size === 0 && !pendingDispatch) {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  child.prompts.withdrawAll()
  await (child.v4Channel
    ? child.v4Channel.command('stop', {})
    : child.connection.request('session/stop', { sessionId: child.providerSessionId }))
  return { cancelled: true }
}
