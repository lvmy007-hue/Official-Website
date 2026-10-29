import { describe, expect, it } from 'vitest'
import { readRefreshToken } from './auth.validation'

describe('刷新令牌 Cookie 解析', () => {
  it('从多个 Cookie 中取出刷新令牌并解码', () => {
    expect(readRefreshToken('a=1; nova_refresh_token=abc%2Fdef; b=2')).toBe('abc/def')
    expect(readRefreshToken('nova_refresh_token=xyz')).toBe('xyz')
  })
  it('没有该 Cookie 时返回空', () => {
    expect(readRefreshToken(undefined)).toBeUndefined()
    expect(readRefreshToken('other=1')).toBeUndefined()
    expect(readRefreshToken('x_nova_refresh_token=1')).toBeUndefined()
  })
})
