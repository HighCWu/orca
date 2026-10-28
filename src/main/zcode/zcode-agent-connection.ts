import { z } from 'zod'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import {
  ZcodeConnectionClosedError,
  ZcodeProtocolRuntime,
  type ZcodeProtocolRuntimeOptions
} from './zcode-protocol-connection'

const capabilitiesSchema = z.looseObject({ independentPlanState: z.boolean().optional() })
const PROTOCOL_END_EXIT_GRACE_MS = 100

function providerExitReason(
  managed: ManagedProviderProcess,
  exit: ProviderProcessExit
): ZcodeConnectionClosedError {
  const status = exit.processless
    ? 'processless spawn failure'
    : `code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`
  const detail = sanitizeCrashReportString(managed.stderrTail().trim(), 2_000)
  return new ZcodeConnectionClosedError(
    detail ? `${detail} (${status})` : `The ZCode agent exited (${status})`
  )
}

export type ZcodeAgentConnectionOptions = {
  onRequest?: ZcodeProtocolRuntimeOptions['onRequest']
  onNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
  onExit?: (error: Error, context: { expected: boolean; exit: ProviderProcessExit }) => void
}

export type ZcodeAgentConnection = {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  respond: (id: string, result: unknown) => void
  respondError: (id: string, code: number, message: string) => void
  subscribe: (listener: (method: string, params: unknown) => void) => () => void
  probe: () => Promise<void>
  readonly spawned: Promise<void>
  readonly pid: number | undefined
  readonly exited: boolean
  stderrTail: () => string
  onExit: (listener: (exit: ProviderProcessExit) => void) => void
  close: (error?: Error) => Promise<boolean>
}

export function createZcodeAgentConnection(
  launch: ProviderProcessLaunch,
  options: ZcodeAgentConnectionOptions = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): ZcodeAgentConnection {
  const managed: ManagedProviderProcess = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'zcode-agent-teardown'
  })
  let closing = false
  let lifecycleError: Error | undefined
  let protocolEndTimer: ReturnType<typeof setTimeout> | null = null
  const runtime = new ZcodeProtocolRuntime(managed.child.stdout, managed.child.stdin, {
    onRequest: options.onRequest,
    onDiagnostic: options.onDiagnostic,
    onInputEnd: () => {
      if (runtime.closed) {
        return
      }
      if (managed.exitStatus) {
        runtime.close(providerExitReason(managed, managed.exitStatus))
        return
      }
      protocolEndTimer ??= setTimeout(() => {
        protocolEndTimer = null
        runtime.close(new ZcodeConnectionClosedError('The ZCode agent closed its protocol stream'))
      }, PROTOCOL_END_EXIT_GRACE_MS)
    },
    onClose: (error) => {
      if (protocolEndTimer) {
        clearTimeout(protocolEndTimer)
        protocolEndTimer = null
      }
      lifecycleError ??= error
      if (closing || managed.rootVerdict === 'exited') {
        return
      }
      void managed.close().then(
        (result) => {
          if (result.root !== 'exited') {
            options.onDiagnostic?.('ZCode agent exit was not proven after transport failure')
          }
        },
        (failure: unknown) =>
          options.onDiagnostic?.(`ZCode agent cleanup failed: ${String(failure)}`)
      )
      options.onClose?.(error)
    }
  })
  if (options.onNotification) {
    const notificationHandler = options.onNotification
    runtime.subscribe((method, params) => {
      if (method !== '') {
        notificationHandler(method, params)
      }
    })
  }
  const spawned = new Promise<void>((resolve) => {
    const { child } = managed
    if (child.pid !== undefined) {
      resolve()
      return
    }
    const done = (): void => {
      child.removeListener('spawn', done)
      child.removeListener('error', done)
      resolve()
    }
    child.once('spawn', done)
    child.once('error', done)
  })
  managed.child.on('error', (error) => runtime.close(error))
  managed.child.stderr.on('error', (error) => runtime.close(error))
  managed.onExit((exit) => {
    const reason = providerExitReason(managed, exit)
    runtime.close(reason)
    try {
      options.onExit?.(reason, { expected: closing, exit })
    } catch (failure) {
      options.onDiagnostic?.(`ZCode exit listener failed: ${String(failure)}`)
    }
  })
  return {
    request: (method, params, timeoutMs) => runtime.request(method, params, timeoutMs),
    respond: (id, result) => runtime.respond(id, result),
    respondError: (id, code, message) => runtime.respondError(id, code, message),
    subscribe: (listener) => runtime.subscribe(listener),
    probe: async () => {
      const result = await runtime.request('runtime/capabilities', {})
      if (!capabilitiesSchema.safeParse(result).success) {
        throw new ZcodeConnectionClosedError(
          'The ZCode agent answered with an unknown protocol shape'
        )
      }
    },
    get spawned() {
      return spawned
    },
    get pid() {
      return managed.child.pid
    },
    get exited() {
      return managed.rootVerdict === 'exited'
    },
    stderrTail: () => managed.stderrTail().trim(),
    onExit: (listener) => {
      managed.onExit((exit) => {
        try {
          listener(exit)
        } catch (failure) {
          options.onDiagnostic?.(`ZCode exit listener failed: ${String(failure)}`)
        }
      })
    },
    close: (error) => {
      closing ||= managed.rootVerdict !== 'exited'
      runtime.close(error)
      runtime.endInput()
      return managed.close().then((result) => result.root === 'exited')
    }
  }
}
