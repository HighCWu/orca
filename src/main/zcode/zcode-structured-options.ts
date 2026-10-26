import type { z } from 'zod'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import type { ZcodeStructuredChild } from './zcode-structured-child'
import {
  configuredModelIdOf,
  configuredModelSelectionOf,
  currentEffortOf,
  zcodeCatalogSnapshotSchema,
  zcodeModelOptionsOf,
  zcodeModelSelectionOf
} from './zcode-session-snapshot-facts'

export type ZcodeCatalogSnapshot = z.infer<typeof zcodeCatalogSnapshotSchema>

export function currentZcodeOptions(child: ZcodeStructuredChild): {
  model?: string
  effort?: string
} {
  return {
    ...(child.currentModel ? { model: child.currentModel } : {}),
    ...(child.currentEffort ? { effort: child.currentEffort } : {})
  }
}

export async function setZcodeOption(
  child: ZcodeStructuredChild,
  input: { key: string; value: string }
): Promise<Readonly<Record<string, string>>> {
  if (input.key !== 'model' && input.key !== 'effort') {
    throw new AgentSessionOptionRejectedError(`zcode offers no session option named ${input.key}`)
  }
  const model = input.key === 'model' ? zcodeModelSelectionOf(input.value) : undefined
  if (
    input.key === 'model' &&
    (!model ||
      (child.modelOptions !== null && !child.modelOptions.some((item) => item.id === input.value)))
  ) {
    child.optionRestoreFailures.add('model')
    throw new AgentSessionOptionRejectedError(
      `${input.value} is not a model this chat's listing offered`
    )
  }
  child.optionRestoreFailures.delete(input.key)
  return switchZcodeSelection(child, {
    ...(model ? { model } : {}),
    ...(input.key === 'effort' ? { effort: input.value } : {})
  })
}

export async function applyZcodeExecutionOptions(
  child: ZcodeStructuredChild,
  choices: AgentSessionExecutionOptions | undefined
): Promise<void> {
  if (!choices || (choices.model === undefined && choices.effort === undefined)) {
    return
  }
  const model = choices.model === undefined ? undefined : zcodeModelSelectionOf(choices.model)
  if (choices.model !== undefined && !model) {
    throw new AgentSessionOptionRejectedError(
      `${choices.model} is not a model this chat's listing offered`
    )
  }
  await switchZcodeSelection(child, {
    ...(model ? { model } : {}),
    ...(choices.effort !== undefined ? { effort: choices.effort } : {})
  })
}

export function readZcodeLiveSnapshot(
  child: ZcodeStructuredChild
): Promise<ZcodeCatalogSnapshot | null> {
  if (!child.providerSessionId) {
    return Promise.resolve(null)
  }
  return child.connection
    .request('session/read', { sessionId: child.providerSessionId })
    .then((raw) => zcodeCatalogSnapshotSchema.parse(raw))
    .catch(() => null)
}

export function composeZcodeLiveOptions(
  child: ZcodeStructuredChild,
  snapshot: ZcodeCatalogSnapshot | null
): StructuredAgentSessionLiveOptions {
  if (!snapshot) {
    return { models: child.modelOptions ?? [], current: currentZcodeOptions(child) }
  }
  const models = zcodeModelOptionsOf(snapshot)
  const selection = configuredModelSelectionOf(snapshot)
  child.currentModel = configuredModelIdOf(snapshot) ?? child.currentModel
  child.currentSelection = selection ?? child.currentSelection
  child.currentEffort = currentEffortOf(snapshot) ?? child.currentEffort
  child.modelOptions = models
  const currentModelOption = child.currentSelection
    ? JSON.stringify([child.currentSelection.providerId, child.currentSelection.modelId])
    : null
  if (currentModelOption && !models.some((model) => model.id === currentModelOption)) {
    child.optionRestoreFailures.add('model')
  } else {
    child.optionRestoreFailures.delete('model')
  }
  return { models, current: currentZcodeOptions(child) }
}

async function switchZcodeSelection(
  child: ZcodeStructuredChild,
  target: { model?: { providerId: string; modelId: string }; effort?: string }
): Promise<Readonly<Record<string, string>>> {
  const modelChanged =
    target.model !== undefined &&
    (child.currentSelection === null ||
      child.currentSelection.providerId !== target.model.providerId ||
      child.currentSelection.modelId !== target.model.modelId)
  const targetOption = target.model
    ? child.modelOptions?.find(
        (option) => option.id === JSON.stringify([target.model!.providerId, target.model!.modelId])
      )
    : undefined
  const effort =
    target.effort ??
    (modelChanged ? (targetOption?.defaultEffort ?? 'high') : (child.currentEffort ?? 'high'))
  const effortChanged = effort !== child.currentEffort
  if (!modelChanged && !effortChanged) {
    return currentZcodeOptions(child)
  }
  if (child.v4Channel) {
    const model = target.model ?? child.currentSelection
    if (!model) {
      throw new AgentSessionOptionRejectedError(
        'the session has no known model selection to switch from'
      )
    }
    try {
      await child.v4Channel.command(
        'switchModelConfig',
        { provider: model.providerId, model: model.modelId, thought: effort },
        { cas: true }
      )
    } catch (error) {
      throw new AgentSessionOptionRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    child.currentSelection = model
    if (modelChanged) {
      child.currentModel = model.modelId
    }
    child.currentEffort = effort
    return currentZcodeOptions(child)
  }
  if (modelChanged && target.model) {
    try {
      await child.connection.request('session/setModel', {
        sessionId: child.providerSessionId,
        model: target.model
      })
    } catch (error) {
      throw new AgentSessionOptionRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    child.currentSelection = target.model
    child.currentModel = target.model.modelId
  }
  if (effortChanged) {
    try {
      await child.connection.request('session/setThoughtLevel', {
        sessionId: child.providerSessionId,
        thoughtLevel: effort,
        persistAsWorkspaceLastUsed: false
      })
    } catch (error) {
      throw new AgentSessionOptionRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    child.currentEffort = effort
  }
  return currentZcodeOptions(child)
}
