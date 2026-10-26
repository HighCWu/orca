// The reset-credit client against a stubbed fetch: inventory mapping, credential gating, use.

import { createCipheriv, createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchZcodeResetCredits,
  readZcodeResetCredentialFacts,
  redeemZcodeResetCredit
} from './zcode-reset-credits'
import type { ZcodeCredentialHost } from './zcode-v2-plan-credentials'

const accountTokens = (overrides: Record<string, string> = {}): Record<string, string> => ({
  zcodejwttoken: 'jwt-1',
  'oauth:bigmodel:access_token': 'maas-1',
  'oauth:bigmodel:user_info': JSON.stringify({ id: 'account-1', username: 'user' }),
  'oauth:active_provider': 'bigmodel',
  ...overrides
})

const store = (tokens: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-reset-'))
  const path = join(dir, 'credentials.json')
  writeFileSync(path, JSON.stringify(tokens))
  return path
}

const okStatus = {
  code: 200,
  data: {
    available_five_hour_resets: [{ expire_at: 2000 }, { expire_at: 1500 }],
    available_week_resets: [{ expire_at: 9000 }],
    latest_five_hour_reset_history: null,
    latest_week_reset_history: null,
    has_unread_history: false
  }
}

let fetchImpl: typeof fetch = () => Promise.reject(new Error('no fetch'))
const install = (respond: () => Response): void => {
  fetchImpl = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(respond())
}

afterEach(() => {
  globalThis.fetch = fetchImpl
})

describe('zcode reset credits', () => {
  it('maps the five-hour inventory and reads JWTs from the store', async () => {
    const path = store(accountTokens())
    install(() => json(okStatus))
    const credits = await fetchZcodeResetCredits({ credentialStorePath: path })
    expect(credits).toEqual({
      availableCount: 2,
      nextExpiresAt: 1_500_000,
      credits: [
        { status: 'available', expiresAt: 1_500_000, grantedAt: null },
        { status: 'available', expiresAt: 2_000_000, grantedAt: null }
      ],
      weekAvailableCount: 1,
      weekNextExpiresAt: 9_000_000
    })
  })

  it('keeps the week pool visible when the five-hour pool is empty', async () => {
    const path = store(accountTokens())
    install(() =>
      json({
        code: 200,
        data: {
          available_five_hour_resets: [],
          available_week_resets: [{ expire_at: 9000 }],
          latest_five_hour_reset_history: null,
          latest_week_reset_history: null,
          has_unread_history: false
        }
      })
    )
    expect(await fetchZcodeResetCredits({ credentialStorePath: path })).toMatchObject({
      availableCount: 0,
      weekAvailableCount: 1,
      weekNextExpiresAt: 9_000_000
    })
  })

  it('answers null without credentials or on endpoint failure', async () => {
    expect(
      await fetchZcodeResetCredits({ credentialStorePath: join(tmpdir(), 'absent.json') })
    ).toBeNull()
    const path = store(accountTokens())
    install(() => json({ code: 500 }, 500))
    expect(await fetchZcodeResetCredits({ credentialStorePath: path })).toBeNull()
  })

  it('keeps the account identity stable across JWT refreshes', () => {
    const first = readZcodeResetCredentialFacts(store(accountTokens()))
    const refreshed = readZcodeResetCredentialFacts(
      store(accountTokens({ zcodejwttoken: 'jwt-2', 'oauth:bigmodel:access_token': 'maas-2' }))
    )
    const switched = readZcodeResetCredentialFacts(
      store(
        accountTokens({
          'oauth:bigmodel:user_info': JSON.stringify({ id: 'account-2', username: 'user' })
        })
      )
    )

    expect(first?.accountId).toBe(refreshed?.accountId)
    expect(switched?.accountId).not.toBe(first?.accountId)
  })

  it('does not fetch inventory for another expected CLI account', async () => {
    const path = store(accountTokens())
    let called = false
    globalThis.fetch = () => {
      called = true
      return Promise.resolve(json(okStatus))
    }

    await expect(
      fetchZcodeResetCredits({ credentialStorePath: path, accountId: 'another-account' })
    ).resolves.toBeNull()
    expect(called).toBe(false)
  })

  it('rejects an oversized credential store without reading the endpoint', async () => {
    const path = store(accountTokens())
    writeFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1))
    let called = false
    globalThis.fetch = () => {
      called = true
      return Promise.resolve(json(okStatus))
    }

    await expect(fetchZcodeResetCredits({ credentialStorePath: path })).resolves.toBeNull()
    expect(called).toBe(false)
  })

  it('refuses a redemption after its account changes', async () => {
    const path = store(accountTokens())
    let called = false
    globalThis.fetch = () => {
      called = true
      return Promise.resolve(json({ code: 200, data: { used: true } }))
    }

    await expect(
      redeemZcodeResetCredit({
        credentialStorePath: path,
        resetType: 'FIVE_HOUR',
        idempotencyKey: 'smoke-key-1',
        accountId: 'another-account'
      })
    ).rejects.toThrow('account changed before redemption')
    expect(called).toBe(false)
  })

  it('decrypts the v2 credential store before reading inventory and sending reset headers', async () => {
    const host: ZcodeCredentialHost = {
      home: '/test-home',
      platform: 'linux',
      username: 'test-user',
      env: { ZCODE_CREDENTIAL_SECRET: 'test-secret' }
    }
    const path = store(
      Object.fromEntries(
        Object.entries(accountTokens()).map(([key, value], index) => [
          key,
          encrypted(value, host, index + 1)
        ])
      )
    )
    let headers: HeadersInit | undefined
    install(() => json(okStatus))
    await expect(
      fetchZcodeResetCredits({ credentialStorePath: path, host })
    ).resolves.toMatchObject({
      availableCount: 2,
      weekAvailableCount: 1
    })
    globalThis.fetch = (_input, init) => {
      headers = init?.headers
      return Promise.resolve(json({ code: 200, data: { used: true } }))
    }

    const facts = readZcodeResetCredentialFacts(path, host)
    expect(facts?.accountId).toBeTruthy()
    await redeemZcodeResetCredit({
      credentialStorePath: path,
      resetType: 'WEEK',
      idempotencyKey: 'encrypted-key',
      credentialHost: host
    })

    expect(headers).toMatchObject({
      Authorization: 'Bearer jwt-1',
      'X-Bigmodel-Authorization': 'maas-1'
    })
  })

  it('spends a card with the idempotency key and body the server expects', async () => {
    const path = store(accountTokens())
    let seenBody: unknown
    const bodySpy = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input
      seenBody = init?.body ? JSON.parse(String(init.body)) : undefined
      return Promise.resolve(json({ code: 200, data: { used: true } }))
    }
    globalThis.fetch = bodySpy
    const used = await redeemZcodeResetCredit({
      credentialStorePath: path,
      resetType: 'FIVE_HOUR',
      idempotencyKey: 'smoke-key-1'
    })
    expect(used).toEqual({ used: true })
    expect(seenBody).toEqual({ idempotency_key: 'smoke-key-1', reset_type: 'FIVE_HOUR' })
  })
})

function encrypted(value: string, host: ZcodeCredentialHost, fill: number): string {
  const iv = Buffer.alloc(12, fill)
  const secret = host.env.ZCODE_CREDENTIAL_SECRET?.trim()
  if (!secret) {
    throw new Error('test credential secret is missing')
  }
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}
