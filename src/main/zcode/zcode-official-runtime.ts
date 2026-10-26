// Finding the official ZCode desktop runtime, and reusing it as the CLI's Node runtime.
//
// The official CLI bundle (resources/glm/zcode.cjs) needs a Node 22+ runtime it cannot pick
// itself; the system's Node may be any version. The official desktop binary solves that: it is an
// Electron, and `ELECTRON_RUN_AS_NODE=1` turns it into exactly the Node the bundle was built for
// — the reuse zcode-go makes with its own executable, mirrored here onto the official ZCode.exe.
// Discovery: the sibling of the `zcode` a PATH entry resolves to (the Linux deb links
// /usr/bin/zcode to it), else the conventional install roots. A standalone CLI has no such
// sibling and launches as itself.

import { existsSync as defaultExistsSync, realpathSync as defaultRealpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UNIX_WINDOWS_BUNDLE_SEGMENTS = ['resources', 'glm', 'zcode.cjs']
const MACOS_BUNDLE_SEGMENTS = ['Resources', 'glm', 'zcode.cjs']

export type ZcodeOfficialRuntime = {
  /** The official desktop executable, reused as the Node runtime via ELECTRON_RUN_AS_NODE. */
  electron: string
  bundle: string
}

export type ZcodeOfficialRuntimeDeps = {
  existsSync?: (path: string) => boolean
  realpathSync?: (path: string) => string
  platform?: NodeJS.Platform
  home?: string
  localAppData?: string
}

/** The desktop executable's name inside an install root, per platform. */
function electronName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return join('Contents', 'MacOS', 'ZCode')
    case 'win32':
      return 'ZCode.exe'
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      return 'zcode'
  }
}

function runtimeBeside(
  existsSync: (path: string) => boolean,
  binary: string,
  platform: NodeJS.Platform
): ZcodeOfficialRuntime | null {
  const bundle =
    platform === 'darwin'
      ? join(dirname(dirname(binary)), ...MACOS_BUNDLE_SEGMENTS)
      : join(dirname(binary), ...UNIX_WINDOWS_BUNDLE_SEGMENTS)
  return existsSync(bundle) ? { electron: binary, bundle } : null
}

/** The official runtime a `command` names, when that command is a desktop install's executable;
 *  null for a standalone CLI, which launches as itself. */
export function resolveZcodeOfficialRuntime(
  command: string,
  deps: ZcodeOfficialRuntimeDeps = {}
): ZcodeOfficialRuntime | null {
  const existsSync = deps.existsSync ?? defaultExistsSync
  const realpathSync = deps.realpathSync ?? defaultRealpathSync
  try {
    return runtimeBeside(existsSync, realpathSync(command), deps.platform ?? process.platform)
  } catch {
    return null
  }
}

/** Where a desktop install's executable lives, by platform convention. */
function conventionalElectrons(deps: ZcodeOfficialRuntimeDeps): string[] {
  const home = deps.home ?? ''
  const localAppData = deps.localAppData ?? (home ? join(home, 'AppData', 'Local') : '')
  const root = (segments: string[]): string => {
    const segmentsWithBinary = [...segments, electronName(deps.platform ?? process.platform)]
    return join(...segmentsWithBinary)
  }
  switch (deps.platform ?? process.platform) {
    case 'darwin':
      return [
        root([home, 'Applications', 'ZCode.app']),
        root(['/Applications', 'ZCode.app'])
      ]
    case 'win32':
      return [root([localAppData, 'Programs', 'ZCode'])]
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      // The deb/rpm target covers the Unix-likes.
      return [root(['/opt/ZCode'])]
  }
}

/** The first official runtime among `candidates` (paths that may be a desktop executable or its
 *  install root) and the conventional install roots; null when none is installed. */
export function probeZcodeOfficialRuntimes(
  candidates: readonly string[],
  deps: ZcodeOfficialRuntimeDeps = {}
): ZcodeOfficialRuntime | null {
  const existsSync = deps.existsSync ?? defaultExistsSync
  const platform = deps.platform ?? process.platform
  const lookBeside = (command: string): ZcodeOfficialRuntime | null => {
    if (existsSync(command)) {
      const beside = resolveZcodeOfficialRuntime(command, deps)
      if (beside) {
        return beside
      }
      // A candidate may name the install root rather than its executable.
      const rootBinary = join(command, electronName(platform))
      return existsSync(rootBinary) ? runtimeBeside(existsSync, rootBinary, platform) : null
    }
    return null
  }
  for (const command of [...candidates, ...conventionalElectrons(deps)]) {
    if (!command) {
      continue
    }
    const runtime = lookBeside(command)
    if (runtime) {
      return runtime
    }
  }
  return null
}
