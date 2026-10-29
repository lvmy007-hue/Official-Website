import { createHash } from 'node:crypto'

// 会话的展示与来源信息（P1-17）：设备描述、脱敏地址、设备指纹、刷新请求的来源校验。

/** 把地址脱敏后用于“会话列表”展示：IPv4 隐藏最后一段，IPv6 只保留前三组；原始地址不落库。 */
export function maskIp(ip: string | undefined | null): string | null {
  if (!ip) return null
  const value = ip.replace(/^::ffff:/i, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `${value.split('.').slice(0, 3).join('.')}.*`
  if (value.includes(':')) {
    const groups = value.split(':').filter(Boolean).slice(0, 3)
    return groups.length ? `${groups.join(':')}::*` : null
  }
  return null
}

/** 设备描述：浏览器与操作系统（够用户认出“这是我的哪台设备”，不暴露完整的浏览器标识）。 */
export function describeDevice(userAgent: string | undefined | null): string {
  if (!userAgent) return '未知设备'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null
  if (!browser && !system) return '未知设备'
  return [browser ?? '未知浏览器', system ?? '未知系统'].join(' · ')
}

/** 设备指纹：只取浏览器与系统的大类做哈希，浏览器小版本升级不会改变它。仅用于识别“是不是同一类设备”，不用于拒绝请求。 */
export function deviceFingerprint(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null
  return createHash('sha256').update(describeDevice(userAgent)).digest('hex').slice(0, 32)
}

export interface OriginCheckInput {
  origin: string | undefined
  referer: string | undefined
  host: string | undefined
  allowedOrigins: readonly string[]
}

/**
 * 刷新接口的来源校验（防跨站请求伪造）。
 * - 有 Origin：必须在白名单内；白名单为空时，只允许与本服务同主机（同源部署）。
 * - 没有 Origin 时看 Referer（个别浏览器的同源 POST 不带 Origin）。
 * - 两者都没有：拒绝。浏览器发起的刷新请求一定带其中之一；没有说明不是浏览器页面发出的。
 */
export function isRefreshOriginAllowed({ origin, referer, host, allowedOrigins }: OriginCheckInput): boolean {
  const source = origin ?? (referer ? safeOrigin(referer) : undefined)
  if (!source || source === 'null') return false
  const normalized = safeOrigin(source)
  if (!normalized) return false
  if (allowedOrigins.length > 0) return allowedOrigins.some(allowed => safeOrigin(allowed) === normalized)
  return Boolean(host) && new URL(normalized).host === host
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

export const allowedOriginsFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  (env.CORS_ORIGINS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
