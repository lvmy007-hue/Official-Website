import { describe, expect, it } from 'vitest'
import { parseTrustProxy } from './trust-proxy'

describe('代理信任配置', () => {
  it('未设置、空、false：不信任任何代理', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
    expect(parseTrustProxy('')).toBe(false)
    expect(parseTrustProxy('  ')).toBe(false)
    expect(parseTrustProxy('false')).toBe(false)
  })

  it('正整数：信任前面几跳', () => {
    expect(parseTrustProxy('1')).toBe(1)
    expect(parseTrustProxy('2')).toBe(2)
  })

  it('地址、网段与关键字列表', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.5 ,loopback')).toEqual(['10.0.0.0/8', '172.16.0.5', 'loopback'])
    expect(parseTrustProxy('::1,fd00::/8')).toEqual(['::1', 'fd00::/8'])
  })

  it('true 被拒绝：等于信任一切来源', () => {
    expect(() => parseTrustProxy('true')).toThrow(/不能设为 true/)
    expect(() => parseTrustProxy('TRUE')).toThrow()
  })

  it('层数越界、写法不合法：拒绝并指出哪一项', () => {
    expect(() => parseTrustProxy('0')).toThrow(/1 到 5/)
    expect(() => parseTrustProxy('9')).toThrow(/1 到 5/)
    expect(() => parseTrustProxy('10.0.0.0/8,evil.example.com')).toThrow(/evil\.example\.com/)
  })
})
