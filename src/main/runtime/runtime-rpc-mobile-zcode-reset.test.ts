import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

it('admits a mobile ZCode reset-credit request through the RPC surface', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
  const { runtime, mocks } = createMobileRpcSurfaceRuntime()
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: 'req_consume_zcode_reset', method: 'accounts.consumeZcodeResetCredit', deviceToken: mobile.token, params: { resetType: 'FIVE_HOUR' } }),
    () => {},
    () => {}
  )
  expect(mocks.consumeZcodeResetCredit).toHaveBeenCalledWith('FIVE_HOUR')
})
