import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import { ZcodeSubagentEvidence } from './zcode-subagent-evidence'

export function pollZcodeSubagents(input: {
  child: ZcodeStructuredChild
  trackers: Map<string, ZcodeSubagentEvidence>
  now: () => number
  publish?: (sessionId: string, evidence: AgentChildWorkEvidence[]) => void
}): void {
  const { child, trackers, now, publish } = input
  const providerSessionId = child.providerSessionId
  if (!providerSessionId || child.journalClosed !== null) {
    return
  }
  let tracker = trackers.get(child.sessionId)
  if (!tracker) {
    tracker = new ZcodeSubagentEvidence()
    trackers.set(child.sessionId, tracker)
  }
  void child.connection
    .request('session/subagents', { sessionId: providerSessionId })
    .then((result) => {
      const evidence = tracker.observe(result, now())
      if (evidence && evidence.length > 0) {
        publish?.(child.sessionId, evidence)
      }
    })
    .catch(() => undefined)
}

export function zcodeSlashCommands(
  child: ZcodeStructuredChild | undefined
): AgentSessionSlashCommand[] | undefined {
  if (!child || child.ended || !child.slashCommands) {
    return undefined
  }
  return child.slashCommands.map((command) => ({
    name: command.name,
    kind: 'command',
    kindUnspecified: true,
    ...(command.description ? { description: command.description } : {}),
    ...(command.inputHint ? { argumentHint: command.inputHint } : {})
  }))
}
