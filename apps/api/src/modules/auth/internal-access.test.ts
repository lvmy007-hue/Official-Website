import { describe, expect, it } from 'vitest'
import { checkInternalSource, InternalAccessConfigError, ipAllowed, parseCidr, readInternalAccessConfig, type InternalAccessConfig } from './internal-access'

const headers =
  (values: Record<string, string> = {}) =>
  (name: string) =>
    values[name.toLowerCase()]
const config = (override: Partial<InternalAccessConfig> = {}): InternalAccessConfig => ({
  enabled: true,
  tenantId: 't1',
  roleId: 'preset-readonly',
  allowedCidrs: ['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8'],
  ...override,
})

describe('内部访问配置', () => {
  it('默认关闭，关闭时不校验其他配置项', () => {
    expect(readInternalAccessConfig({}).enabled).toBe(false)
    expect(readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'false', INTERNAL_ACCESS_ALLOWED_CIDRS: 'garbage' }).enabled).toBe(false)
    // 只有明确写 true 才开启
    expect(readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: '1' }).enabled).toBe(false)
    expect(readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'TRUE' }).enabled).toBe(false)
  })

  it('开启时读取各配置项，角色默认只读', () => {
    const value = readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_TENANT_ID: ' t1 ', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8, 192.168.1.5' })
    expect(value).toMatchObject({ enabled: true, tenantId: 't1', roleId: 'preset-readonly', allowedCidrs: ['10.0.0.0/8', '192.168.1.5'] })
    expect(
      readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_TENANT_ID: 't1', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8', INTERNAL_ACCESS_ROLE_ID: 'preset-ops' }).roleId,
    ).toBe('preset-ops')
  })

  it('开启但配置不完整或不合法：拒绝，并一次列出全部问题', () => {
    expect(() => readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'true' })).toThrow(InternalAccessConfigError)
    try {
      readInternalAccessConfig({ INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/33,example.com,0.0.0.0/0', INTERNAL_ACCESS_GATEWAY_HEADER: 'x-gateway' })
      throw new Error('应当抛出')
    } catch (error) {
      const problems = (error as InternalAccessConfigError).problems.join('\n')
      expect(problems).toContain('INTERNAL_ACCESS_TENANT_ID')
      expect(problems).toContain('10.0.0.0/33')
      expect(problems).toContain('example.com')
      expect(problems).toContain('0.0.0.0/0')
      expect(problems).toContain('INTERNAL_ACCESS_GATEWAY_SECRET')
    }
  })

  it('网关校验头：两项必须同时配置，密钥至少 16 个字符', () => {
    const base = { INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_TENANT_ID: 't1', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8' }
    expect(() => readInternalAccessConfig({ ...base, INTERNAL_ACCESS_GATEWAY_SECRET: 'x'.repeat(20) })).toThrow(/同时配置/)
    expect(() => readInternalAccessConfig({ ...base, INTERNAL_ACCESS_GATEWAY_HEADER: 'X-Gateway', INTERNAL_ACCESS_GATEWAY_SECRET: 'short' })).toThrow(/16/)
    const ok = readInternalAccessConfig({ ...base, INTERNAL_ACCESS_GATEWAY_HEADER: 'X-Gateway', INTERNAL_ACCESS_GATEWAY_SECRET: 'x'.repeat(20) })
    expect(ok.gatewayHeader).toBe('x-gateway')
  })
})

describe('地址段匹配', () => {
  it('解析地址段：单个地址按完整前缀；不合法返回空', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, family: 'ipv4' })
    expect(parseCidr('10.1.2.3')).toEqual({ address: '10.1.2.3', prefix: 32, family: 'ipv4' })
    expect(parseCidr('fd00::/8')).toEqual({ address: 'fd00::', prefix: 8, family: 'ipv6' })
    for (const bad of ['', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/8/8', 'example.com', '10.0.0/8', '300.1.1.1']) expect(parseCidr(bad), bad).toBeNull()
  })

  it('范围内通过，范围外与不合法地址拒绝；IPv4 映射地址按 IPv4 处理', () => {
    const cidrs = ['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8']
    expect(ipAllowed('10.20.30.40', cidrs)).toBe(true)
    expect(ipAllowed('::ffff:10.20.30.40', cidrs)).toBe(true)
    expect(ipAllowed('192.168.1.255', cidrs)).toBe(true)
    expect(ipAllowed('192.168.2.1', cidrs)).toBe(false)
    expect(ipAllowed('11.0.0.1', cidrs)).toBe(false)
    expect(ipAllowed('fd12::1', cidrs)).toBe(true)
    expect(ipAllowed('2001:db8::1', cidrs)).toBe(false)
    expect(ipAllowed(undefined, cidrs)).toBe(false)
    expect(ipAllowed('not-an-ip', cidrs)).toBe(false)
    expect(ipAllowed('10.0.0.1', [])).toBe(false)
  })
})

describe('内部访问的来源判断', () => {
  const input = (ip: string | undefined, values: Record<string, string> = {}, proxyTrusted = false) => ({ ip, header: headers(values), proxyTrusted })

  it('未开启：一律不按内部访问处理', () => {
    expect(checkInternalSource(config({ enabled: false }), input('10.0.0.1')).ok).toBe(false)
  })

  it('允许地址段内的请求通过，段外拒绝并给出原因', () => {
    expect(checkInternalSource(config(), input('10.1.1.1')).ok).toBe(true)
    const denied = checkInternalSource(config(), input('203.0.113.9'))
    expect(denied).toEqual({ ok: false, reason: expect.stringContaining('地址段') })
  })

  it('带有代理转发头但服务没有配置代理信任：拒绝（拿到的是代理地址，不能据此放行）', () => {
    const denied = checkInternalSource(config(), input('10.0.0.5', { 'x-forwarded-for': '203.0.113.9' }, false))
    expect(denied.ok).toBe(false)
    expect((denied as { reason: string }).reason).toContain('TRUST_PROXY')
    expect(checkInternalSource(config(), input('10.0.0.5', { forwarded: 'for=203.0.113.9' }, false)).ok).toBe(false)
    // 已配置代理信任时，ip 已是还原后的真实地址
    expect(checkInternalSource(config(), input('10.0.0.5', { 'x-forwarded-for': '10.0.0.5' }, true)).ok).toBe(true)
    expect(checkInternalSource(config(), input('203.0.113.9', { 'x-forwarded-for': '203.0.113.9' }, true)).ok).toBe(false)
  })

  it('配置了网关校验头：缺少或不匹配都拒绝，匹配才通过', () => {
    const gateway = config({ gatewayHeader: 'x-gateway', gatewaySecret: 'gateway-secret-0123456789' })
    expect(checkInternalSource(gateway, input('10.0.0.1')).ok).toBe(false)
    expect(checkInternalSource(gateway, input('10.0.0.1', { 'x-gateway': 'wrong-secret-0123456789' })).ok).toBe(false)
    expect(checkInternalSource(gateway, input('10.0.0.1', { 'x-gateway': 'gateway-secret-012345678' })).ok).toBe(false)
    expect(checkInternalSource(gateway, input('10.0.0.1', { 'x-gateway': 'gateway-secret-0123456789' })).ok).toBe(true)
    // 校验头正确但地址不在段内，仍然拒绝
    expect(checkInternalSource(gateway, input('203.0.113.9', { 'x-gateway': 'gateway-secret-0123456789' })).ok).toBe(false)
  })
})
