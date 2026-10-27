import { z } from 'zod'

const forbiddenPersistedKeys = new Set(['__proto__', 'constructor', 'prototype'])

function hasForbiddenPersistedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenPersistedKey)
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return Object.entries(value).some(
    ([key, child]) => forbiddenPersistedKeys.has(key) || hasForbiddenPersistedKey(child)
  )
}

// Preserve raw own keys: Zod records erase __proto__ before emptiness checks.
const rawConfigSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !hasForbiddenPersistedKey(value)
)

const modelRuleSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    config: rawConfigSchema
  })
  .strict()
const providerRuleSchema = z
  .object({
    providerId: z.string().min(1),
    templateId: z.string().min(1).nullable().optional(),
    providerName: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    config: rawConfigSchema
  })
  .strict()
const oauthOnlyShellSchema = z
  .object({ schemaVersion: z.literal(1), config: z.object({}).strict() })
  .strict()
const oauthCompatibleProviderConfigSchema = z
  .object({ access: z.object({ type: z.literal('api-key') }).strict() })
  .strict()
const oauthCompatibleModelConfigSchema = z
  .object({ properties: z.object({ reasoningLevel: z.string().min(1) }).strict() })
  .strict()

const selectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.object({ providerRules: z.array(providerRuleSchema) }).strict(),
        modelConfigRules: z
          .object({
            providerModelRules: z.array(modelRuleSchema),
            manualProviderModelRules: z.array(modelRuleSchema)
          })
          .strict(),
        defaultModelSelection: z
          .object({
            providerId: z.string().trim().min(1),
            modelId: z.string().trim().min(1),
            options: z
              .object({ reasoningLevel: z.string().trim().min(1).optional() })
              .strict()
              .optional()
          })
          .strict()
          .optional()
      })
      .strict()
  })
  .strict()

// ZCode 29628c9 validates the whole overlay before accepting its selected account.
export function readSupportedZcodeV2Selection(input: unknown) {
  if (hasForbiddenPersistedKey(input)) {
    return { status: 'unsupported' as const }
  }
  const selection = selectionSchema.safeParse(input)
  if (!selection.success) {
    if (oauthOnlyShellSchema.safeParse(input).success) {
      return { status: 'supported' as const, selection: undefined }
    }
    throw selection.error
  }
  const { config } = selection.data
  const providerRules = config.providerConfigRules.providerRules
  const providerIds = new Set(providerRules.map((rule) => rule.providerId))
  if (providerIds.size !== providerRules.length) {
    throw new Error('Invalid personal provider rules')
  }

  const selectedProviderSupported = providerRules.every(
    (rule) => Object.keys(rule.config).length === 0
  )
  const oauthProviderCompatible = providerRules.every(
    (rule) =>
      Object.keys(rule.config).length === 0 ||
      oauthCompatibleProviderConfigSchema.safeParse(rule.config).success
  )
  const selectedModelsSupported = config.modelConfigRules.providerModelRules.every(
    (rule) => Object.keys(rule.config).length === 0
  )
  const oauthModelsCompatible = config.modelConfigRules.providerModelRules.every(
    (rule) =>
      Object.keys(rule.config).length === 0 ||
      oauthCompatibleModelConfigSchema.safeParse(rule.config).success
  )
  if (
    !oauthProviderCompatible ||
    !oauthModelsCompatible ||
    config.modelConfigRules.manualProviderModelRules.length > 0
  ) {
    return { status: 'unsupported' as const }
  }
  return {
    status: 'supported' as const,
    selection:
      selectedProviderSupported && selectedModelsSupported
        ? config.defaultModelSelection
        : undefined
  }
}
