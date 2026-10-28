// The session-snapshot facts a chat's options read: the model table, the current selection and
// the current thought level. One mapper serves the at-open store, the live options read and the
// at-rest catalog probe, so all three see the same rows.

import { z } from 'zod'
import type {
  AgentSessionModelOption,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'

const thoughtLevelSchema = z.looseObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional()
})

const zcodeSessionModeSchema = z.enum(['plan', 'build', 'edit', 'yolo', 'guarded', 'auto'])

const optionRefSchema = z.looseObject({
  ref: z.looseObject({
    providerId: z.string(),
    modelId: z.string(),
    options: z.looseObject({ reasoningLevel: z.string() }).optional()
  }),
  label: z.string(),
  description: z.string().optional(),
  reasoning: z
    .looseObject({
      levels: z.array(thoughtLevelSchema),
      defaultLevel: z.string().optional()
    })
    .optional(),
  disabledReason: z.string().optional()
})

export const zcodeCatalogSnapshotSchema = z.looseObject({
  session: z.looseObject({ sessionId: z.string() }),
  projection: z
    .looseObject({ contextWindow: z.number().int().nonnegative().optional() })
    .optional(),
  settings: z
    .looseObject({
      model: z
        .looseObject({
          current: z.unknown().nullable().optional(),
          available: z.array(optionRefSchema).optional()
        })
        .optional(),
      thoughtLevel: z.unknown().optional(),
      mode: z.looseObject({ current: zcodeSessionModeSchema }).optional(),
      permission: z.looseObject({ mode: zcodeSessionModeSchema.optional() }).optional()
    })
    .optional(),
  slashCommands: z
    .array(
      z.looseObject({
        name: z.string(),
        description: z.string().optional(),
        inputHint: z.string().optional()
      })
    )
    .optional()
})

export type ZcodeCatalogSnapshot = z.infer<typeof zcodeCatalogSnapshotSchema>

/** The stable option id an Orca pick stores; `session/setModel` parses it back into a selection. */
export function zcodeModelOptionId(option: {
  ref: { providerId: string; modelId: string }
}): string {
  return JSON.stringify([option.ref.providerId, option.ref.modelId])
}

export function zcodeModelSelectionOf(
  optionId: string
): { providerId: string; modelId: string } | null {
  let value: unknown
  try {
    value = JSON.parse(optionId)
  } catch {
    return null
  }
  const parsed = z.tuple([z.string(), z.string()]).safeParse(value)
  return parsed.success ? { providerId: parsed.data[0], modelId: parsed.data[1] } : null
}

function configuredRef(snapshot: ZcodeCatalogSnapshot): unknown {
  return snapshot.settings?.model?.current
}

function sameRef(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameModel(left: unknown, right: unknown): boolean {
  const refShape = z.looseObject({ providerId: z.string(), modelId: z.string() })
  const leftRef = refShape.safeParse(left)
  const rightRef = refShape.safeParse(right)
  return (
    leftRef.success &&
    rightRef.success &&
    leftRef.data.providerId === rightRef.data.providerId &&
    leftRef.data.modelId === rightRef.data.modelId
  )
}

/** The chat-model rows a session snapshot's model table maps to. */
export function zcodeModelOptionsOf(snapshot: ZcodeCatalogSnapshot): AgentSessionModelOption[] {
  const configured = configuredRef(snapshot)
  const options = snapshot.settings?.model?.available ?? []
  const exactConfiguredOption = options.find((option) => sameRef(configured, option.ref))
  const fallbackConfiguredOption = exactConfiguredOption
    ? undefined
    : options.find((option) => !option.disabledReason && sameModel(configured, option.ref))
  const mapped: AgentSessionModelOption[] = []
  for (const option of options) {
    if (option.disabledReason) {
      continue
    }
    mapped.push({
      id: zcodeModelOptionId(option),
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      isDefault: option === (exactConfiguredOption ?? fallbackConfiguredOption),
      efforts:
        option.reasoning?.levels.map((level) => ({
          value: level.value,
          label: level.label,
          ...(level.description ? { description: level.description } : {})
        })) ?? [],
      ...(option.reasoning?.defaultLevel ? { defaultEffort: option.reasoning.defaultLevel } : {}),
      ...(option.ref.options?.reasoningLevel
        ? { defaultEffort: option.ref.options.reasoningLevel }
        : {})
    })
  }
  return mapped
}

export function configuredModelSelectionOf(
  snapshot: ZcodeCatalogSnapshot
): { providerId: string; modelId: string } | null {
  const parsed = z
    .looseObject({ providerId: z.string().min(1), modelId: z.string().min(1) })
    .safeParse(configuredRef(snapshot))
  return parsed.success ? parsed.data : null
}

export function configuredModelIdOf(snapshot: ZcodeCatalogSnapshot): string | undefined {
  const current = configuredRef(snapshot)
  if (typeof current === 'string' && current) {
    return current
  }
  return configuredModelSelectionOf(snapshot)?.modelId
}

export type ZcodeSessionMode = z.infer<typeof zcodeSessionModeSchema>

export function currentZcodeSessionMode(snapshot: ZcodeCatalogSnapshot): ZcodeSessionMode | null {
  return snapshot.settings?.permission?.mode ?? snapshot.settings?.mode?.current ?? null
}

export function zcodeReportedPermissionMode(
  mode: ZcodeSessionMode | null
): 'ask' | 'full-access' | null {
  return mode === null ? null : mode === 'yolo' ? 'full-access' : 'ask'
}

/** The window the session's current model runs in, as the snapshot reported. */
export function contextWindowOf(snapshot: ZcodeCatalogSnapshot): number | null {
  const window = snapshot.projection?.contextWindow
  return typeof window === 'number' && window > 0 ? window : null
}

/** The `/` surface a snapshot reports, as the host renders it. */
export function zcodeSlashCommandsOf(
  commands: { name: string; description?: string; inputHint?: string }[] | null | undefined
): AgentSessionSlashCommand[] {
  return (commands ?? []).map((command) => ({
    name: command.name,
    kind: 'command',
    kindUnspecified: true,
    ...(command.description ? { description: command.description } : {}),
    ...(command.inputHint ? { argumentHint: command.inputHint } : {})
  }))
}

export function currentEffortOf(snapshot: ZcodeCatalogSnapshot): string | null {
  const level = snapshot.settings?.thoughtLevel
  if (typeof level === 'string' && level) {
    return level
  }
  const parsed = z.looseObject({ current: z.string() }).safeParse(level)
  return parsed.success ? parsed.data.current : null
}
