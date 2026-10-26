import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))

import {
  _resetZCodeInteractiveCapabilityForTests,
  readZCodeInteractiveCapability
} from './interactive-capability'
import type { ZcodeCliInvocation } from './zcode-cli-invocation'

const desktopInvocation: ZcodeCliInvocation = {
  command: '/opt/ZCode/zcode',
  prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
  envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
  identity: 'desktop',
  source: 'desktop-bundle'
}

beforeEach(() => {
  mocks.runProcess.mockReset()
  _resetZCodeInteractiveCapabilityForTests()
})

describe('readZCodeInteractiveCapability', () => {
  it('probes the exact CLI invocation and explicit tui command', async () => {
    mocks.runProcess.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: "Cannot find package '@zcode/tui'",
      timedOut: false
    })

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('missing-tui')
    const spec = mocks.runProcess.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      program: '/opt/ZCode/zcode',
      args: ['/opt/ZCode/resources/glm/zcode.cjs', 'tui'],
      input: '',
      timeoutMs: 6_000
    })
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('caches definitive verdicts by invocation identity', async () => {
    mocks.runProcess.mockResolvedValue({ code: 1, stdout: '', stderr: 'not a tty', timedOut: false })
    const standalone = {
      ...desktopInvocation,
      command: '/usr/local/bin/zcode',
      prefixArgs: [],
      envOverlay: {},
      identity: 'standalone',
      source: 'standalone' as const
    }

    await readZCodeInteractiveCapability(desktopInvocation)
    await readZCodeInteractiveCapability(desktopInvocation)
    await readZCodeInteractiveCapability(standalone)

    expect(mocks.runProcess).toHaveBeenCalledTimes(2)
  })
})
