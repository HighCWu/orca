import { ipcMain } from 'electron'
import {
  detectRemoteWindowsTerminalCapabilities,
  runPreflightCheck
} from '../preflight/agent-detection'
import { detectAgentsOnHost, refreshAgentsOnHost } from '../preflight/workspace-agent-detection'
import type {
  PreflightRuntimeContext,
  PreflightStatus,
  RemoteWindowsTerminalCapabilities
} from '../preflight/agent-detection'

import { readZCodeInteractiveCapability } from '../zcode/interactive-capability'
import { resolveZcodeCliInvocation } from '../zcode/zcode-cli-invocation'

export function registerPreflightHandlers(): void {
  ipcMain.handle(
    'preflight:check',
    async (
      _event,
      args?: PreflightRuntimeContext & { force?: boolean }
    ): Promise<PreflightStatus> => {
      return runPreflightCheck(args?.force, args)
    }
  )

  ipcMain.handle('preflight:detectAgents', async (_event, args?: PreflightRuntimeContext) =>
    detectAgentsOnHost({ kind: 'local', context: args })
  )

  ipcMain.handle(
    'preflight:zcodeInteractiveCapability',
    async (_event, args?: { commandOverride?: string }) =>
      readZCodeInteractiveCapability(
        resolveZcodeCliInvocation({
          pathEnv: process.env.PATH ?? process.env.Path,
          ...(args?.commandOverride
            ? { commandSettings: { agentCmdOverrides: { zcode: args.commandOverride } } }
            : {})
        })
      )
  )

  ipcMain.handle(
    'preflight:zcodeSetupInvocation',
    async (_event, args: { commandOverride?: string; cliArgs: string[] }) => {
      const invocation = resolveZcodeCliInvocation({
        pathEnv: process.env.PATH ?? process.env.Path,
        ...(args.commandOverride
          ? { commandSettings: { agentCmdOverrides: { zcode: args.commandOverride } } }
          : {})
      })
      return {
        command: invocation.command,
        args: [...invocation.prefixArgs, ...args.cliArgs],
        env: invocation.envOverlay
      }
    }
  )

  ipcMain.handle('preflight:refreshAgents', async (_event, args?: PreflightRuntimeContext) => {
    return refreshAgentsOnHost({ kind: 'local', context: args })
  })

  ipcMain.handle(
    'preflight:detectRemoteAgents',
    async (_event, args: { connectionId: string }): Promise<string[]> =>
      detectAgentsOnHost({ kind: 'ssh', connectionId: args.connectionId })
  )

  ipcMain.handle(
    'preflight:detectRemoteWindowsTerminalCapabilities',
    async (_event, args: { connectionId: string }): Promise<RemoteWindowsTerminalCapabilities> => {
      return detectRemoteWindowsTerminalCapabilities(args)
    }
  )
}
