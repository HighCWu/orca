import { z } from 'zod'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const resetEnvelopeSchema = z.object({
  code: z.number(),
  data: z.unknown().optional()
})

export async function readZcodeResetEnvelope(
  response: Response
): Promise<{ code: number; data: unknown } | null> {
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const envelope = resetEnvelopeSchema.safeParse(payload)
  if (!envelope.success || (envelope.data.code !== 200 && envelope.data.code !== 0)) {
    return null
  }
  return { code: envelope.data.code, data: envelope.data.data }
}
