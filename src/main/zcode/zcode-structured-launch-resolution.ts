// How a durable session record becomes a `zcode app-server` launch.
//
// The official CLI bundle (resources/glm/zcode.cjs) cannot pick its own Node runtime, and the
// system's Node may be any version — so the launch reuses the official desktop executable as the
// runtime: `ELECTRON_RUN_AS_NODE=1` turns the official ZCode binary into exactly the Node the
// bundle was built for (the reuse zcode-go makes with its own executable). The runtime is found
// beside the `zcode` a PATH entry resolves to when that is a desktop install (the Linux deb links
// /usr/bin/zcode to it), else at the conventional install roots; a standalone CLI on PATH launches
// as itself. `ZCODE_AGENT_SERVER_COMMAND` (with `ZCODE_AGENT_SERVER_ARGS_JSON`, as the reference
// host reads them) overrides everything. A resume reattaches the provider session the record
// proved.

import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey
} from '../../shared/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import type { ZcodeOfficialRuntimeDeps } from './zcode-official-runtime'
import { resolveZcodeCliInvocation } from './zcode-cli-invocation'

export type ZcodeStructuredLaunch = {
  command: string
  args: string[]
  /** The child inherits its cwd from the spawn, which is the session's launch directory. */
  resume: {
    sessionId: string
    key: string
  } | null
}

export const ZCODE_INHERITED_ENV_TO_DELETE: readonly string[] = [
  ...STRUCTURED_CHILD_ENV_TO_DELETE,
  'ZCODE_AGENT_SERVER_COMMAND',
  'ZCODE_AGENT_SERVER_ARGS_JSON'
]

export type ZcodeLaunchInvocationDeps = {
  resolveEnvironment: () => Promise<Record<string, string>>
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveWorkingDirectory?: () => Promise<string> | string
  resolveCommand?: typeof resolveCliCommand
  homePath?: string
  officialRuntime?: ZcodeOfficialRuntimeDeps
}

function desktopSurfaceArgs(args: string[]): string[] {
  const normalized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--surface') {
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        index += 1
      }
      continue
    }
    if (arg?.startsWith('--surface=')) {
      continue
    }
    if (arg !== undefined) {
      normalized.push(arg)
    }
  }
  return [...normalized, '--surface', 'desktop']
}

function agentServerArgs(env: Record<string, string>): string[] {
  const raw = env.ZCODE_AGENT_SERVER_ARGS_JSON
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
        return desktopSurfaceArgs(parsed)
      }
    } catch {
      // Handled below: an unusable override falls back to the stock invocation.
    }
  }
  return ['app-server', '--stdio', '--surface', 'desktop']
}

/** What a launch with `env` runs: the env override when set; else the `zcode` on PATH (the
 *  Command setting applies), whose desktop runtime — when that entry is a desktop install, or a
 *  conventional one exists — runs the official bundle in plain Node mode. The env overlay in the
 *  answer must reach the child: without it the executable starts as a Chromium child and hangs in
 *  GPU init instead of serving the protocol. */
export function resolveZcodeLaunchCommand(
  env: Readonly<Record<string, string>>,
  options: {
    commandSettings?: StructuredAgentCommandSettings
    resolveCommand?: typeof resolveCliCommand
    homePath?: string
    officialRuntime?: ZcodeOfficialRuntimeDeps
  } = {}
): { command: string; args: string[]; envOverlay?: Record<string, string> } {
  const override = env.ZCODE_AGENT_SERVER_COMMAND?.trim()
  if (override) {
    return { command: override, args: agentServerArgs(env) }
  }
  const invocation = resolveZcodeCliInvocation({
    commandSettings: options.commandSettings,
    resolveCommand: options.resolveCommand,
    pathEnv: env.PATH ?? env.Path ?? '',
    homePath: env.HOME ?? env.USERPROFILE ?? options.homePath,
    officialRuntime: options.officialRuntime
  })
  const builtinProviderConfig = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim()
  const bundledProviderConfig = env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE?.trim()
  const envOverlay = {
    ...invocation.envOverlay,
    ...(builtinProviderConfig ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinProviderConfig } : {}),
    ...(bundledProviderConfig
      ? { ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundledProviderConfig }
      : {})
  }
  return {
    command: invocation.command,
    args: [...invocation.prefixArgs, 'app-server', '--stdio', '--surface', 'desktop'],
    ...(Object.keys(envOverlay).length > 0 ? { envOverlay } : {})
  }
}

/** The binary, args and environment any ZCode child runs under: a session's launch and a later
 *  probe both resolve here, so neither can reach another account. */
export function resolveZcodeLaunchInvocation(
  accountHomePath: string,
  deps: ZcodeLaunchInvocationDeps
): Promise<{
  command: string
  args: string[]
  env: Record<string, string>
  envToDelete: readonly string[]
}> {
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const base = await deps.resolveEnvironment()
      const env: Record<string, string> = {
        ...base,
        ...deps.resolveLaunchEnv?.('zcode'),
        // The pinned base wins over whatever the shell inherited, so a resume cannot
        // drift to another account's session store.
        ZCODE_DATA_BASE_DIR: accountHomePath
      }
      const command = resolveZcodeLaunchCommand(env, {
        ...(deps.resolveCommandSettings ? { commandSettings: deps.resolveCommandSettings() } : {}),
        ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
        ...(deps.homePath ? { homePath: deps.homePath } : {}),
        ...(deps.officialRuntime ? { officialRuntime: deps.officialRuntime } : {})
      })
      return {
        command: command.command,
        args: command.args,
        env: { ...env, ...command.envOverlay },
        envToDelete: ZCODE_INHERITED_ENV_TO_DELETE
      }
    },
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory }
  )
}

/** ZCode's part of a launch: its binary under the pinned account, and the provider session a
 *  resume reattaches. */
export function zcodeStructuredLaunchPart(): StructuredAgentLaunchPartResolver<ZcodeStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command, args, env } = await resolveZcodeLaunchInvocation(accountHome.path, {
      resolveEnvironment: basis.baseEnvironment,
      resolveLaunchEnv: () => basis.launchEnv(),
      ...(basis.commandSettings ? { resolveCommandSettings: basis.commandSettings } : {}),
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: basis.launchDirectory
    })
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      launch: {
        command,
        args,
        resume: head
          ? {
              sessionId: head.handle.nativeId,
              key: agentSessionProviderHandleKey(head.handle)
            }
          : null
      },
      env,
      // The shared strip keeps this process's own agent env out of the child.
      inheritedEnvToDelete: ZCODE_INHERITED_ENV_TO_DELETE
    }
  }
}
