import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 工作台页面的安全头（P1-17，12.9 第 7 条）：登录页与 ERP 页面带内容安全策略并禁止被嵌入；
// 官网页面的位置块不改动（官网零改动约束）。这里按网关配置文本核对，真实响应头由部署验收时用浏览器复查。
const nginx = readFileSync('infrastructure/aliyun/nginx.conf', 'utf8')

function block(header: string): string {
  const start = nginx.indexOf(header)
  expect(start, `缺少 ${header}`).toBeGreaterThanOrEqual(0)
  const open = nginx.indexOf('{', start)
  let depth = 0
  for (let i = open; i < nginx.length; i += 1) {
    if (nginx[i] === '{') depth += 1
    if (nginx[i] === '}') {
      depth -= 1
      if (depth === 0) return nginx.slice(start, i + 1)
    }
  }
  throw new Error(`${header} 没有闭合`)
}

describe('工作台页面的安全头', () => {
  const workspace = ['location = /login', 'location = /app', 'location ^~ /app/', 'location ^~ /platform/', 'location ^~ /invite/']

  for (const header of workspace) {
    it(`${header}：带内容安全策略、禁止被嵌入，并保留其他安全头`, () => {
      const text = block(header)
      expect(text).toMatch(/add_header X-Frame-Options DENY always;/)
      expect(text).toMatch(/add_header Content-Security-Policy "[^"]+" always;/)
      expect(text).toContain('add_header X-Content-Type-Options nosniff always;')
      expect(text).toContain('add_header Referrer-Policy')
      expect(text).toContain('add_header Permissions-Policy')
    })
  }

  it('内容安全策略：脚本只允许同源，不允许内联与动态执行；不允许被任何页面嵌入；对象与基础地址收紧', () => {
    const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(block('location = /app'))?.[1] ?? ''
    const directive = (name: string) =>
      csp
        .split(';')
        .map(item => item.trim())
        .find(item => item.startsWith(`${name} `)) ?? ''
    expect(directive('script-src')).toBe("script-src 'self'")
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('base-uri')).toBe("base-uri 'self'")
    expect(directive('connect-src')).toBe("connect-src 'self'")
  })

  it('图片来源：本站、内嵌与亚马逊图片域名（商品主图来自亚马逊），不放开任意 https 与 http 图片（P5-13）', () => {
    const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(block('location = /app'))?.[1] ?? ''
    const sources = (
      csp
        .split(';')
        .map(item => item.trim())
        .find(item => item.startsWith('img-src ')) ?? ''
    )
      .split(/\s+/)
      .slice(1)
    expect(sources).toEqual(["'self'", 'data:', 'blob:', 'https://*.media-amazon.com', 'https://*.ssl-images-amazon.com', 'https://*.images-amazon.com'])
    expect(sources).not.toContain('https:')
    expect(sources).not.toContain('*')
  })

  it('三个工作台位置的策略完全一致', () => {
    const policies = workspace.map(header => /add_header Content-Security-Policy "([^"]+)" always;/.exec(block(header))?.[1])
    expect(new Set(policies).size).toBe(1)
  })

  it('官网页面的位置块不带内容安全策略，也不改变其嵌入策略（沿用全站默认）', () => {
    for (const header of ['location = / ', 'location = /site', 'location ^~ /assets/']) {
      const text = block(header)
      expect(text, header).not.toContain('Content-Security-Policy')
      expect(text, header).not.toContain('X-Frame-Options')
    }
    expect(nginx).toContain('add_header X-Frame-Options SAMEORIGIN always;')
  })
})
