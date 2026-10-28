// orca skills loads detection outside Electron; exclude integration-client dependencies.
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { readZcodeTerminalLaunchAdmission } from '../zcode/terminal-launch-admission'
import { detectAgentCommandsOnHost } from './agent-command-detection'

export async function detectInstalledAgents(context?: PreflightRuntimeContext): Promise<string[]> {
  const wslTarget = getPreflightWslTarget(context)
  const runtime = wslTarget ? 'wsl' : process.platform
  const commands = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  const detected = resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    await detectAgentCommandsOnHost(commands, { context }),
    runtime
  )
  if (wslTarget || !detected.includes('zcode')) {
    return detected
  }
  const admission = await readZcodeTerminalLaunchAdmission({
    pathEnv: process.env.PATH ?? process.env.Path
  })
  return admission.status === 'available' ? detected : detected.filter((agent) => agent !== 'zcode')
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context)
}
