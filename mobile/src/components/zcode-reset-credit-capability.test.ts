import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const probe = vi.hoisted(() => ({
  start: vi.fn()
}))

vi.mock('../transport/runtime-capability-probe', () => ({
  startRuntimeCapabilityProbe: probe.start
}))

import {
  MOBILE_ZCODE_RESET_CREDIT_CAPABILITY,
  readZcodeResetCreditCapability,
  useZcodeResetCreditCapability
} from './zcode-reset-credit-capability'

afterEach(() => {
  vi.restoreAllMocks()
  probe.start.mockReset()
})

describe('readZcodeResetCreditCapability', () => {
  it('enables the action only when the host explicitly advertises the contract', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { capabilities: ['mobile.tasks.v1', MOBILE_ZCODE_RESET_CREDIT_CAPABILITY] }
    })

    await expect(readZcodeResetCreditCapability({ sendRequest })).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it.each([
    { ok: true, result: { capabilities: ['mobile.tasks.v1'] } },
    { ok: true, result: { capabilities: 'accounts.zcode-reset-credit.v1' } },
    { ok: false, error: { code: 'old-host', message: 'unsupported' } }
  ])('fails closed for an unsupported or malformed host response', async (response) => {
    const sendRequest = vi.fn().mockResolvedValue(response)
    await expect(readZcodeResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })

  it('fails closed when the capability probe cannot complete', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(readZcodeResetCreditCapability({ sendRequest })).resolves.toBe(false)
  })
})

describe('useZcodeResetCreditCapability', () => {
  it('uses the reconnect-safe probe and cancels it on unmount', () => {
    const cancel = vi.fn()
    let publish: ((capabilities: readonly string[]) => void) | null = null
    probe.start.mockImplementation(
      (_client: RpcClient, onCapabilities: (capabilities: readonly string[]) => void) => {
        publish = onCapabilities
        return cancel
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe only reads the client's identity across reconnects; the mocked sendRequest is the one member the probe can reach.
    const client = { sendRequest: vi.fn() } as unknown as RpcClient
    let renderer: ReactTestRenderer

    function CapabilityResult(_props: { supported: boolean }) {
      return null
    }

    function Harness() {
      const supported = useZcodeResetCreditCapability(client, true)
      return createElement(CapabilityResult, { supported })
    }

    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(renderer!.root.findByType(CapabilityResult).props.supported).toBe(false)

    act(() => publish?.([MOBILE_ZCODE_RESET_CREDIT_CAPABILITY]))
    expect(renderer!.root.findByType(CapabilityResult).props.supported).toBe(true)

    act(() => renderer!.unmount())
    expect(cancel).toHaveBeenCalledOnce()
  })
})
