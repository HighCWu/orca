import { z } from 'zod'
import type { ZcodeCredentialHost } from './zcode-v2-plan-credentials'
import { readZcodeV2PlanCredential } from './zcode-v2-plan-credentials'

const requestSchema = z.looseObject({
  providerId: z.string().min(1),
  modelSelection: z.looseObject({ providerId: z.string().min(1), modelId: z.string().min(1) }),
  rejectedProjectTokenFingerprint: z.string().optional()
})

const providerOrigins = new Map([
  ['account:bigmodel-individual-coding-plan', 'https://open.bigmodel.cn'],
  ['account:zai-individual-coding-plan', 'https://api.z.ai']
])

export function resolveZcodeProviderRuntimeAuth(
  params: unknown,
  credentialHost: ZcodeCredentialHost
):
  | { headersApplied: true; requestAuth: { apiKey: string } }
  | { headersApplied: false; errorMessage: string } {
  const request = requestSchema.safeParse(params)
  if (!request.success || request.data.providerId !== request.data.modelSelection.providerId) {
    return { headersApplied: false, errorMessage: 'The ZCode provider request is invalid' }
  }
  if (request.data.rejectedProjectTokenFingerprint) {
    return { headersApplied: false, errorMessage: 'The current ZCode project token was rejected' }
  }
  const expectedOrigin = providerOrigins.get(request.data.providerId)
  if (!expectedOrigin) {
    return { headersApplied: false, errorMessage: 'The selected ZCode provider is unsupported' }
  }
  const credential = readZcodeV2PlanCredential(credentialHost)
  if (credential.status !== 'ok' || credential.baseUrl !== expectedOrigin) {
    return { headersApplied: false, errorMessage: 'ZCode Coding Plan credentials are unavailable' }
  }
  return { headersApplied: true, requestAuth: { apiKey: credential.apiKey } }
}
