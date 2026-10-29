import { BlockList, isIP } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

// 内部访问模式（P1-18，11 章 11.3）：企业内网直连、不走个人登录的访问方式。
// 默认关闭。开启后，来自允许地址段的无登录请求按“固定内部租户 + 最小权限角色”处理；其余请求仍走普通登录。
// 配置项：
//   INTERNAL_DIRECT_ACCESS          true 开启，默认关闭
//   INTERNAL_ACCESS_TENANT_ID       绑定的内部租户（开启时必填）
//   INTERNAL_ACCESS_ROLE_ID         绑定的角色，默认 preset-readonly（只读）
//   INTERNAL_ACCESS_ALLOWED_CIDRS   允许访问的内网地址段，逗号分隔（开启时必填），例如 10.0.0.0/8,192.168.1.0/24
//   INTERNAL_ACCESS_GATEWAY_HEADER / INTERNAL_ACCESS_GATEWAY_SECRET  可选：内网网关注入的校验头与值，两项必须同时配置
// 地址校验依赖代理信任配置正确（TRUST_PROXY）。

export const INTERNAL_ACCESS_SESSION_ID = 'internal-access'
export const INTERNAL_ACCESS_DEFAULT_ROLE_ID = 'preset-readonly'

export interface InternalAccessConfig {
  enabled: boolean
  tenantId: string
  roleId: string
  allowedCidrs: string[]
  gatewayHeader?: string
  gatewaySecret?: string
}

export class InternalAccessConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`内部访问模式配置不正确：${problems.join('；')}`)
    this.name = 'InternalAccessConfigError'
  }
}

type Cidr = { address: string; prefix: number; family: 'ipv4' | 'ipv6' }

/** 解析地址段；单个地址按完整前缀处理。不合法返回 null。 */
export function parseCidr(text: string): Cidr | null {
  const [address, prefixText, ...rest] = text.trim().split('/')
  if (rest.length > 0 || !address) return null
  const version = isIP(address)
  if (version === 0) return null
  const max = version === 4 ? 32 : 128
  if (prefixText === undefined) return { address, prefix: max, family: version === 4 ? 'ipv4' : 'ipv6' }
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) return null
  return { address, prefix: Number(prefixText), family: version === 4 ? 'ipv4' : 'ipv6' }
}

/** 读取并校验配置。关闭时不做校验；开启时配置不完整或不合法会抛出，列出全部问题。 */
export function readInternalAccessConfig(env: NodeJS.ProcessEnv = process.env): InternalAccessConfig {
  const enabled = env.INTERNAL_DIRECT_ACCESS === 'true'
  const config: InternalAccessConfig = {
    enabled,
    tenantId: (env.INTERNAL_ACCESS_TENANT_ID ?? '').trim(),
    roleId: (env.INTERNAL_ACCESS_ROLE_ID ?? '').trim() || INTERNAL_ACCESS_DEFAULT_ROLE_ID,
    allowedCidrs: (env.INTERNAL_ACCESS_ALLOWED_CIDRS ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    gatewayHeader: (env.INTERNAL_ACCESS_GATEWAY_HEADER ?? '').trim().toLowerCase() || undefined,
    gatewaySecret: env.INTERNAL_ACCESS_GATEWAY_SECRET || undefined,
  }
  if (!enabled) return config

  const problems: string[] = []
  if (!config.tenantId) problems.push('必须配置 INTERNAL_ACCESS_TENANT_ID')
  if (config.allowedCidrs.length === 0) problems.push('必须配置 INTERNAL_ACCESS_ALLOWED_CIDRS')
  for (const item of config.allowedCidrs) if (!parseCidr(item)) problems.push(`INTERNAL_ACCESS_ALLOWED_CIDRS 里的 "${item}" 不是合法的地址或地址段`)
  // 0.0.0.0/0 与 ::/0 等于对所有人开放，与“只允许内网”的意图相反
  for (const item of config.allowedCidrs) {
    const cidr = parseCidr(item)
    if (cidr && cidr.prefix === 0) problems.push(`INTERNAL_ACCESS_ALLOWED_CIDRS 里的 "${item}" 会放开所有来源`)
  }
  if (Boolean(config.gatewayHeader) !== Boolean(config.gatewaySecret)) problems.push('INTERNAL_ACCESS_GATEWAY_HEADER 与 INTERNAL_ACCESS_GATEWAY_SECRET 必须同时配置')
  if (config.gatewaySecret && config.gatewaySecret.length < 16) problems.push('INTERNAL_ACCESS_GATEWAY_SECRET 至少 16 个字符')
  if (problems.length > 0) throw new InternalAccessConfigError(problems)
  return config
}

/** 地址是否落在允许的地址段内。IPv4 映射的 IPv6 地址（::ffff:10.0.0.1）按 IPv4 处理。 */
export function ipAllowed(ip: string | undefined, cidrs: readonly string[]): boolean {
  if (!ip) return false
  const address = ip.replace(/^::ffff:/i, '')
  const version = isIP(address)
  if (version === 0) return false
  const list = new BlockList()
  for (const item of cidrs) {
    const cidr = parseCidr(item)
    if (cidr) list.addSubnet(cidr.address, cidr.prefix, cidr.family)
  }
  return list.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export interface InternalSourceInput {
  ip: string | undefined
  /** 请求头读取函数（名称大小写不敏感） */
  header: (name: string) => string | undefined
  /** 服务是否已配置代理信任 */
  proxyTrusted: boolean
}

export type InternalSourceCheck = { ok: true } | { ok: false; reason: string }

/** 判断一个无登录请求是否可以按内部访问处理。拒绝时给出原因（只写日志，不返回给调用方）。 */
export function checkInternalSource(config: InternalAccessConfig, input: InternalSourceInput): InternalSourceCheck {
  if (!config.enabled) return { ok: false, reason: '内部访问模式未开启' }
  // 请求带着代理转发头，但服务没有配置代理信任：拿到的是代理自己的地址，不能据此判断访客来源
  if (!input.proxyTrusted && (input.header('x-forwarded-for') || input.header('forwarded'))) {
    return { ok: false, reason: '请求带有代理转发头，但服务未配置 TRUST_PROXY，无法确认真实来源地址' }
  }
  if (!ipAllowed(input.ip, config.allowedCidrs)) return { ok: false, reason: '来源地址不在允许的地址段内' }
  if (config.gatewayHeader && config.gatewaySecret) {
    const provided = input.header(config.gatewayHeader)
    if (!provided || !safeEqual(provided, config.gatewaySecret)) return { ok: false, reason: '缺少或不匹配网关校验头' }
  }
  return { ok: true }
}
