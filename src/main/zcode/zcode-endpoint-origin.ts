export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = 'https://zcode.z.ai'

export function readConfiguredZcodeEndpointOrigin(env: NodeJS.ProcessEnv): string | null {
  const configured =
    env.ZCODE_BASE_URL?.trim() ||
    env.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    env.ZCODE_PRODUCTION_BASE_URL?.trim()
  if (!configured) {
    return null
  }
  const parsed = new URL(configured)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('ZCode endpoint origin must use http or https')
  }
  return parsed.origin
}

export function resolveZcodeEndpointOrigin(env: NodeJS.ProcessEnv): string {
  return readConfiguredZcodeEndpointOrigin(env) ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN
}
