import { readFile } from 'node:fs/promises'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { textOfMessageBody } from './zcode-message-text'
import { zcodeAttachmentsOf, zcodeImageMimeOf } from './zcode-message-attachments'
import { zcodeSessionSendResultSchema } from './zcode-protocol-messages'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import { ZcodeV4CommandRejectedError } from './v4/zcode-v4-conversation-channel'

export function rejectedZcodeDispatch(): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('emptyMessage'), {
      surface: 'rejection',
      agentName: 'ZCode'
    })
  }
}

type DispatchInput = Parameters<StructuredAgentSessionAdapter['dispatch']>[0]

export async function dispatchZcodeMessage(input: {
  child: ZcodeStructuredChild
  dispatch: DispatchInput
  now: () => number
  applyExecutionOptions: (
    child: ZcodeStructuredChild,
    options: AgentSessionExecutionOptions | undefined
  ) => Promise<void>
}): Promise<AgentSessionDispatchOutcome> {
  const { child, dispatch, now, applyExecutionOptions } = input
  if (child.journalClosed !== null) {
    return rejectedZcodeDispatch()
  }
  const text = textOfMessageBody(dispatch.body)
  const attachments = zcodeAttachmentsOf(dispatch.body)
  if (text === null && attachments.length === 0) {
    return rejectedZcodeDispatch()
  }
  dispatch.onInputPreparation?.()
  dispatch.signal?.throwIfAborted()
  await applyExecutionOptions(child, dispatch.executionOptions)
  dispatch.signal?.throwIfAborted()
  const v4 = child.v4Channel
  if (!v4) {
    return sendLegacyZcodeMessage(child, dispatch, text, attachments, now)
  }
  const attachmentRefs: { ref: string; fileName: string; mime: string; bytes: number }[] = []
  try {
    for (const attachment of attachments) {
      dispatch.signal?.throwIfAborted()
      const bytes = await readFile(attachment.localPath)
      dispatch.signal?.throwIfAborted()
      const mime = attachment.mimeType ?? zcodeImageMimeOf(attachment.filename)
      const uploaded = await v4.uploadAttachment({
        fileName: attachment.filename,
        mime,
        bytes,
        ...(dispatch.signal ? { signal: dispatch.signal } : {})
      })
      attachmentRefs.push({
        ref: uploaded.ref,
        fileName: attachment.filename,
        mime,
        bytes: bytes.byteLength
      })
    }
  } catch {
    dispatch.signal?.throwIfAborted()
    return sendLegacyZcodeMessage(child, dispatch, text, attachments, now)
  }
  dispatch.signal?.throwIfAborted()
  await dispatch.beforeDispatch?.()
  dispatch.signal?.throwIfAborted()
  v4.translator.openPrompt(dispatch.clientMessageId, dispatch.requestedAt ?? now())
  try {
    await v4.command(
      'sendText',
      {
        text: text ?? '',
        requestedDelivery: 'startNow',
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {})
      },
      { commandId: dispatch.clientMessageId }
    )
  } catch (error) {
    if (error instanceof ZcodeV4CommandRejectedError) {
      v4.translator.dropPrompt()
      return rejectedZcodeDispatch()
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
  return { state: 'admitted' }
}

async function sendLegacyZcodeMessage(
  child: ZcodeStructuredChild,
  input: DispatchInput,
  text: string | null,
  attachments: ReturnType<typeof zcodeAttachmentsOf>,
  now: () => number
): Promise<AgentSessionDispatchOutcome> {
  input.signal?.throwIfAborted()
  await input.beforeDispatch?.()
  input.signal?.throwIfAborted()
  const lane = child.lane
  lane?.translator.openPrompt(input.clientMessageId, input.requestedAt ?? now())
  try {
    const sent = zcodeSessionSendResultSchema.parse(
      await child.connection.request('session/send', {
        sessionId: child.providerSessionId,
        content: text ?? '',
        inputId: input.clientMessageId,
        ...(attachments.length > 0 ? { attachments } : {})
      })
    )
    if (!sent.accepted) {
      lane?.translator.dropPrompt()
      return rejectedZcodeDispatch()
    }
    return { state: 'admitted' }
  } catch (error) {
    lane?.translator.dropPrompt()
    throw error
  }
}
