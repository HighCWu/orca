import { describe, expect, it } from 'vitest'
import { resolveZcodeLaunchCommand } from './zcode-structured-launch-resolution'

const desktopFiles = new Set(['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs'])
const officialRuntime = {
  platform: 'linux' as const,
  existsSync: (path: string): boolean => desktopFiles.has(path),
  realpathSync: (path: string): string => path
}

describe('resolveZcodeLaunchCommand', () => {
  it('launches a desktop bundle in Node mode with the desktop surface', () => {
    expect(
      resolveZcodeLaunchCommand({}, { resolveCommand: () => 'zcode', officialRuntime })
    ).toEqual({
      command: '/opt/ZCode/zcode',
      args: [
        '/opt/ZCode/resources/glm/zcode.cjs',
        'app-server',
        '--stdio',
        '--surface',
        'desktop'
      ],
      envOverlay: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('uses a standalone CLI even when a conventional desktop install exists', () => {
    expect(
      resolveZcodeLaunchCommand(
        {},
        { resolveCommand: () => '/home/test/.local/bin/zcode', officialRuntime }
      )
    ).toEqual({
      command: '/home/test/.local/bin/zcode',
      args: ['app-server', '--stdio', '--surface', 'desktop']
    })
  })

  it.each([
    [['app-server', '--stdio', '--surface', 'terminal'], ['app-server', '--stdio']],
    [['app-server', '--surface=terminal', '--stdio'], ['app-server', '--stdio']],
    [['app-server', '--surface', '--stdio'], ['app-server', '--stdio']]
  ])('normalizes an override surface to desktop', (input, retained) => {
    expect(
      resolveZcodeLaunchCommand({
        ZCODE_AGENT_SERVER_COMMAND: '/custom/zcode-server',
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(input)
      })
    ).toEqual({
      command: '/custom/zcode-server',
      args: [...retained, '--surface', 'desktop']
    })
  })
})
