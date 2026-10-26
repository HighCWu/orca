import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ZcodeCredentialHost } from './zcode-v2-plan-credentials'
import { resolveZcodeProviderRuntimeAuth } from './zcode-provider-runtime-auth'

let dir: string | null = null

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = null
})

function host(): ZcodeCredentialHost {
  dir = mkdtempSync(join(tmpdir(), 'zcode-provider-runtime-auth-'))
  const v2 = join(dir, '.zcode', 'v2')
  mkdirSync(v2, { recursive: true })
  writeFileSync(join(v2, 'provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {} }))
  writeFileSync(
    join(v2, 'credentials.json'),
    JSON.stringify({
      'oauth:active_provider': 'bigmodel',
      'oauth:bigmodel:user_info': JSON.stringify({ id: 'account-1' }),
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:account-1:api-key':
        'plan-key'
    })
  )
  return { home: dir, platform: 'linux', username: 'tester', env: {} }
}

const request = {
  providerId: 'account:bigmodel-individual-coding-plan',
  modelSelection: {
    providerId: 'account:bigmodel-individual-coding-plan',
    modelId: 'GLM-5.3'
  }
}

describe('ZCode provider runtime auth', () => {
  it('returns the current OAuth Coding Plan key for its exact account provider', () => {
    expect(resolveZcodeProviderRuntimeAuth(request, host())).toEqual({
      headersApplied: true,
      requestAuth: { apiKey: 'plan-key' }
    })
  })

  it('does not reuse the current credential for another provider', () => {
    expect(
      resolveZcodeProviderRuntimeAuth(
        {
          providerId: 'account:zai-individual-coding-plan',
          modelSelection: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' }
        },
        host()
      )
    ).toMatchObject({ headersApplied: false })
  })

  it('does not resend a project token the runtime says was rejected', () => {
    expect(
      resolveZcodeProviderRuntimeAuth(
        { ...request, rejectedProjectTokenFingerprint: 'a'.repeat(64) },
        host()
      )
    ).toMatchObject({ headersApplied: false })
  })
})
