import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  readConfiguredZcodeEndpointOrigin
} from './zcode-endpoint-origin'

const originByAccount = new Map<string, string>()

export function zcodeResetOriginCandidates(
  family: 'zai' | 'bigmodel',
  env: NodeJS.ProcessEnv
): readonly string[] {
  const configured = readConfiguredZcodeEndpointOrigin(env)
  const planOrigin = family === 'zai' ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
  return [configured ?? planOrigin, DEFAULT_ZCODE_ENDPOINT_ORIGIN].filter(
    (origin, index, values) => values.indexOf(origin) === index
  )
}

export function requireZcodeResetOrigin(accountId: string): string {
  const origin = originByAccount.get(accountId)
  if (!origin) {
    throw new Error('zcode rate-limit reset endpoint is not verified')
  }
  return origin
}

export function rememberZcodeResetOrigin(accountId: string, origin: string): void {
  originByAccount.set(accountId, origin)
}

export function _resetZcodeResetOriginCacheForTests(): void {
  originByAccount.clear()
}
