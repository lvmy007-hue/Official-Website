// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSignedUrl, safeHttpUrl, safeRedirectPath } from './safe-url'

describe('safeHttpUrl', () => {
  it('放行 http、https 与本站相对路径', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/')
    expect(safeHttpUrl('/api/v1/storage/local/abc')).toBe('/api/v1/storage/local/abc')
    expect(safeHttpUrl('  https://example.com/x  ')).toBe('https://example.com/x')
  })

  it('拒绝可执行或可嵌入的协议，包括大小写、空白与换行拆分', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'blob:https://example.com/x',
    ]) {
      expect(safeHttpUrl(bad), bad).toBeUndefined()
    }
  })

  it('拒绝协议相对地址、反斜杠写法、空值与非字符串', () => {
    for (const bad of ['//evil.example.com/x', '/\\evil.example.com', '\\\\evil.example.com', '', '   ', 'not a url', 'example.com/path']) expect(safeHttpUrl(bad), bad).toBeUndefined()
    expect(safeHttpUrl(null)).toBeUndefined()
    expect(safeHttpUrl(undefined)).toBeUndefined()
    expect(safeHttpUrl(42 as unknown as string)).toBeUndefined()
  })
})

describe('openSignedUrl', () => {
  afterEach(() => vi.restoreAllMocks())

  it('安全链接在新标签页打开，且带 noopener 与 noreferrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openSignedUrl('https://files.example.com/a.csv?sig=1')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://files.example.com/a.csv?sig=1', '_blank', 'noopener,noreferrer')
  })

  it('不安全链接不打开', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openSignedUrl('javascript:alert(1)')).toBe(false)
    expect(openSignedUrl(undefined)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('safeRedirectPath', () => {
  it('只接受工作台内部路径', () => {
    expect(safeRedirectPath('/app')).toBe('/app')
    expect(safeRedirectPath('/app/orders?page=2')).toBe('/app/orders?page=2')
    expect(safeRedirectPath('/app?x=1')).toBe('/app?x=1')
  })

  it('外部地址、协议相对、脚本协议、其他前缀与控制字符一律回到默认入口', () => {
    for (const bad of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)', '/platform/tenants', '/apple', '/app/..\\evil', '/app/\nx', '', 'app/orders']) {
      expect(safeRedirectPath(bad), bad).toBe('/app')
    }
    expect(safeRedirectPath(undefined)).toBe('/app')
    expect(safeRedirectPath('//x', '/app/overview')).toBe('/app/overview')
  })
})
