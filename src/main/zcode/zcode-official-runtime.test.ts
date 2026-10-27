// Official-runtime discovery: a PATH entry that resolves into a desktop install yields its
// executable as the Node runtime; a standalone CLI stays itself; conventional roots cover a
// missing PATH entry.

import { describe, expect, it } from 'vitest'
import { probeZcodeOfficialRuntimes, resolveZcodeOfficialRuntime } from './zcode-official-runtime'

const LINUX_INSTALL = new Set(['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs'])
const MACOS_INSTALL = new Set([
  '/Applications/ZCode.app/Contents/MacOS/ZCode',
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
])

describe('zcode official runtime discovery', () => {
  it('resolves a desktop executable to itself plus its bundled CLI', () => {
    expect(
      resolveZcodeOfficialRuntime('/opt/ZCode/zcode', {
        existsSync: (path) => LINUX_INSTALL.has(path),
        realpathSync: (path) => path
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs'
    })
  })

  it('resolves a per-user macOS app when no PATH candidate exists', () => {
    const install = new Set([
      '/Users/test/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Users/test/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
    ])
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => install.has(path),
        realpathSync: (path) => path,
        platform: 'darwin',
        home: '/Users/test'
      })
    ).toEqual({
      electron: '/Users/test/Applications/ZCode.app/Contents/MacOS/ZCode',
      bundle: '/Users/test/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
    })
  })

  it('resolves a per-user Windows app from LOCALAPPDATA', () => {
    const install = new Set([
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
    ])
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => install.has(path),
        realpathSync: (path) => path,
        platform: 'win32',
        home: 'C:\\Users\\test',
        localAppData: 'C:\\Users\\test\\AppData\\Local'
      })
    ).toEqual({
      electron: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      bundle: 'C:\\Users\\test\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
    })
  })

  it('resolves the macOS app executable to Contents/Resources', () => {
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => MACOS_INSTALL.has(path),
        realpathSync: (path) => path,
        platform: 'darwin'
      })
    ).toEqual({
      electron: '/Applications/ZCode.app/Contents/MacOS/ZCode',
      bundle: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
    })
  })

  it('leaves a standalone CLI alone: no resources sibling, no runtime reuse', () => {
    const existsSync = (path: string): boolean => path === '/usr/local/bin/zcode'
    expect(
      resolveZcodeOfficialRuntime('/usr/local/bin/zcode', {
        existsSync,
        realpathSync: (path) => path
      })
    ).toBeNull()
    expect(
      resolveZcodeOfficialRuntime('/gone/zcode', {
        existsSync: () => false,
        realpathSync: (path) => path
      })
    ).toBeNull()
  })

  it('probes the conventional root when the PATH entry misses, binary or root form', () => {
    const existsSync = (path: string): boolean =>
      LINUX_INSTALL.has(path) || path === '/opt/Other/zcode'
    expect(
      probeZcodeOfficialRuntimes(['/opt/Other/zcode', '/opt/ZCode'], {
        existsSync,
        platform: 'linux'
      })
    ).toEqual({
      electron: '/opt/ZCode/zcode',
      bundle: '/opt/ZCode/resources/glm/zcode.cjs'
    })
  })

  it('never takes a conventional root whose sibling bundle is absent', () => {
    expect(
      probeZcodeOfficialRuntimes([], {
        existsSync: (path) => path === '/opt/ZCode/zcode',
        platform: 'linux'
      })
    ).toBeNull()
  })
})
