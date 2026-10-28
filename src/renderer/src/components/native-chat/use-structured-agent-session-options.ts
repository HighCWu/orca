import type { StructuredAgentSessionOptionsArgs } from './structured-agent-session-options-args'
import { toast } from 'sonner'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { useRememberSessionOptionPicks } from './use-structured-agent-session-option-picks'
import {
  beginStructuredOptionPick,
  isLatestStructuredOptionPick,
  settleStructuredOptionPick,
  structuredOptionPickCommit,
  structuredOptionPickBlockingId
} from '../../../../shared/structured-agent-session-option-pick-book'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption,
  type StructuredLaunchOptionOutcome
} from '@/lib/structured-agent-session-launch-options'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentSessionOptions(args: StructuredAgentSessionOptionsArgs) {
  const {
    agent,
    fence,
    launch,
    mutate,
    providerVisible,
    sessionId,
    target,
    transportEnabled,
    turnId
  } = args
  const providerStarting = args.providerStarting ?? false
  const newLaunch = launch?.kind === 'new'
  const launchSeedOptions = launch?.seedOptions
  const held = launch?.heldOptions ?? NO_HELD_OPTIONS
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  const {
    optionView,
    takesSendOptions,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    optionPicks,
    updateOptionState,
    receiveCatalog,
    beginOptionWrite,
    isCurrentContext,
    conversationSupport
  } = useStructuredAgentSessionOptionState({
    agent,
    optionCatalog,
    identity: `${agent}:${sessionId}`,
    fence,
    sessionId,
    target,
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    seedsModel: launchSeedOptions?.model !== undefined,
    providerVisible,
    providerStarting,
    hostOptionStamp: args.hostOptionStamp ?? '',
    readsBeforeStart: launch?.kind !== 'new',
    turnId,
    unloadedTurnRevisions: args.unloadedTurnRevisions
  })

  const awaitingOptions =
    conversationSupport?.sessionId === sessionId && conversationSupport.fence !== fence
  const acceptsPicks =
    (!transportEnabled || fence !== null) && launch?.seedPending !== true && !awaitingOptions

  const hostCatalog = useHostModelCatalogUpgrade({
    agent,
    sessionId,
    target,
    optionCatalog,
    enabled: args.isVisible,
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    fence,
    turnId,
    reportedUnpickedModel:
      newLaunch && launchSeedOptions?.model === undefined && optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    activeOptionRecordRef,
    updateOptionState,
    receiveCatalog
  })
  const pendingView = useCallback(
    (state: StructuredAgentSessionOptionState) =>
      optionView(
        { ...state, runtimePermissionRequired: args.providerRunning === true },
        launchSeedOptions,
        held,
        launch?.explicitOptions
      ),
    [args.providerRunning, held, launch?.explicitOptions, launchSeedOptions, optionView]
  )

  const rememberOptionPicks = useRememberSessionOptionPicks(target, agent)
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const finishWrite = beginOptionWrite(id)
      const shownAtOnce = providerStarting || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      const pick = beginStructuredOptionPick(optionPicks.current, id, encoded, shownAtOnce)
      const sameRecord = (): boolean =>
        isCurrentContext() && activeOptionRecordRef.current === targetRecord
      const isCurrent = (): boolean =>
        sameRecord() && isLatestStructuredOptionPick(optionPicks.current, pick)
      updateOptionState((current) =>
        shownAtOnce
          ? commitStructuredAgentSessionOptionValues(current, { [id]: encoded })
          : { ...current, pendingId: id }
      )
      let result: AgentSessionOptionResult | null = null
      try {
        result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        const committed =
          result && sameRecord()
            ? structuredOptionPickCommit(optionPicks.current, pick, result.options)
            : null
        if (committed) {
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          rememberOptionPicks(
            optionView(currentState, launchSeedOptions, NO_HELD_OPTIONS),
            committed
          )
        }
        return Boolean(result)
      } finally {
        if (sameRecord()) {
          settleStructuredOptionPick(optionPicks.current, pick)
        }
        if (isCurrent()) {
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
        finishWrite(isCurrent() && Boolean(result || shownAtOnce))
      }
    },
    [
      activeOptionRecordRef,
      beginOptionWrite,
      isCurrentContext,
      launchSeedOptions,
      mutate,
      optionPicks,
      optionStateRef,
      optionView,
      providerStarting,
      rememberOptionPicks,
      updateOptionState
    ]
  )
  const settleLaunchOptionPick = useCallback(
    (outcome: StructuredLaunchOptionOutcome) => {
      if (outcome.kind === 'refused') {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      } else if (outcome.kind === 'accepted') {
        rememberOptionPicks(
          optionView(optionStateRef.current, launchSeedOptions, NO_HELD_OPTIONS),
          outcome.options
        )
      }
    },
    [launchSeedOptions, optionStateRef, optionView, rememberOptionPicks]
  )
  const lockSnapshotRef = useRef(
    (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) => snapshot
  )
  const lockSnapshot = (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) =>
    !acceptsPicks ? lockedStructuredAgentSessionOptionSnapshot(snapshot) : snapshot
  useLayoutEffect(() => {
    lockSnapshotRef.current = lockSnapshot
  })
  const optionSnapshot = lockSnapshot(
    structuredAgentSessionOptionSnapshot(pendingView(optionState))
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const view = pendingView(optionStateRef.current)
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
          value === 'own' &&
          !view.permissionOwnSupported) ||
        !isCurrentContext() ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          {
            ...view,
            pendingId: structuredOptionPickBlockingId(optionPicks.current, id, providerStarting)
          },
          id,
          value,
          lockSnapshotRef.current(structuredAgentSessionOptionSnapshot(view))
        )
      ) {
        return false
      }
      if (!transportEnabled || fence === null) {
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, view)
        void applied?.then(settleLaunchOptionPick)
        return applied !== null
      }
      return sendStructuredOption(id, encoded)
    },
    [
      fence,
      optionCatalog,
      isCurrentContext,
      optionStateRef,
      optionPicks,
      pendingView,
      providerStarting,
      sendStructuredOption,
      sessionId,
      settleLaunchOptionPick,
      transportEnabled
    ]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      const currentHeld = getStructuredAgentSessionLaunchSelection(sessionId)?.held
      return {
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionOptionSnapshot(
            optionView(optionStateRef.current, launchSeedOptions, currentHeld ?? NO_HELD_OPTIONS)
          )
        )
      }
    },
    [launchSeedOptions, optionStateRef, optionView, sessionId, setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      demandModelCatalog: hostCatalog.demandModelCatalog,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [setOption, optionSnapshot, hostCatalog.demandModelCatalog]
  )

  const support =
    transportEnabled && conversationSupport?.sessionId === sessionId ? conversationSupport : null
  return {
    conversationCommands: support?.commands ?? [],
    threadGoal: support?.threadGoal,
    reportedThreadGoal: support?.reportedThreadGoal,
    contextUsage: support?.contextUsage,
    acceptsImages: support?.acceptsImages,
    rewind: support?.fence === fence ? support.rewind : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    sendSource: { optionStateRef, optionPicks, optionView, takesSendOptions },
    unavailable: hostCatalog.unavailable
  }
}
