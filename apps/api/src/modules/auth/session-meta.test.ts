import { describe, expect, it } from 'vitest'
import { deviceFingerprint, describeDevice, isRefreshOriginAllowed, maskIp } from './session-meta'

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME_WIN_NEWER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const EDGE_WIN = `${CHROME_WIN} Edg/126.0.0.0`
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

describe('会话展示信息', () => {
  it('地址脱敏：IPv4 隐藏最后一段，IPv6 只留前三组，映射地址按 IPv4 处理，空值返回 null', () => {
    expect(maskIp('203.0.113.45')).toBe('203.0.113.*')
    expect(maskIp('::ffff:198.51.100.7')).toBe('198.51.100.*')
    expect(maskIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3::*')
    expect(maskIp(undefined)).toBeNull()
    expect(maskIp('')).toBeNull()
    expect(maskIp('not-an-ip')).toBeNull()
  })

  it('设备描述：浏览器与系统', () => {
    expect(describeDevice(CHROME_WIN)).toBe('Chrome · Windows')
    expect(describeDevice(EDGE_WIN)).toBe('Edge · Windows')
    expect(describeDevice(SAFARI_MAC)).toBe('Safari · macOS')
    expect(describeDevice(IPHONE)).toBe('Safari · iOS')
    expect(describeDevice(undefined)).toBe('未知设备')
    expect(describeDevice('curl/8.4')).toBe('未知设备')
  })

  it('设备指纹：同一类设备的浏览器小版本升级后不变；换设备类型会变', () => {
    expect(deviceFingerprint(CHROME_WIN)).toBe(deviceFingerprint(CHROME_WIN_NEWER))
    expect(deviceFingerprint(CHROME_WIN)).not.toBe(deviceFingerprint(SAFARI_MAC))
    expect(deviceFingerprint(undefined)).toBeNull()
    expect(deviceFingerprint(CHROME_WIN)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('刷新接口的来源校验', () => {
  const allowed = ['https://erp.example.com', 'http://localhost:5173']

  it('来源在白名单内：通过（忽略路径与末尾斜杠）', () => {
    expect(isRefreshOriginAllowed({ origin: 'https://erp.example.com', referer: undefined, host: 'erp.example.com', allowedOrigins: allowed })).toBe(true)
    expect(isRefreshOriginAllowed({ origin: 'http://localhost:5173', referer: undefined, host: undefined, allowedOrigins: allowed })).toBe(true)
    expect(isRefreshOriginAllowed({ origin: undefined, referer: 'https://erp.example.com/app/orders?x=1', host: undefined, allowedOrigins: allowed })).toBe(true)
  })

  it('来源不在白名单、协议或端口不同、伪装成子域：拒绝', () => {
    for (const origin of ['https://evil.example.org', 'http://erp.example.com', 'https://erp.example.com:8443', 'https://erp.example.com.evil.org', 'null']) {
      expect(isRefreshOriginAllowed({ origin, referer: undefined, host: 'erp.example.com', allowedOrigins: allowed }), origin).toBe(false)
    }
  })

  it('Origin 与 Referer 都没有：拒绝', () => {
    expect(isRefreshOriginAllowed({ origin: undefined, referer: undefined, host: 'erp.example.com', allowedOrigins: allowed })).toBe(false)
  })

  it('Origin 优先于 Referer：Origin 不对时，即使 Referer 对也拒绝', () => {
    expect(isRefreshOriginAllowed({ origin: 'https://evil.example.org', referer: 'https://erp.example.com/', host: 'erp.example.com', allowedOrigins: allowed })).toBe(false)
  })

  it('白名单为空：只允许与本服务同主机的来源（同源部署）', () => {
    expect(isRefreshOriginAllowed({ origin: 'https://erp.example.com', referer: undefined, host: 'erp.example.com', allowedOrigins: [] })).toBe(true)
    expect(isRefreshOriginAllowed({ origin: 'https://evil.example.org', referer: undefined, host: 'erp.example.com', allowedOrigins: [] })).toBe(false)
    expect(isRefreshOriginAllowed({ origin: 'https://erp.example.com', referer: undefined, host: undefined, allowedOrigins: [] })).toBe(false)
  })

  it('格式损坏的来源：拒绝而不是抛错', () => {
    expect(isRefreshOriginAllowed({ origin: '::::', referer: undefined, host: 'x', allowedOrigins: allowed })).toBe(false)
  })
})
