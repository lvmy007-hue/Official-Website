import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './testing/harness'

// 安全核查（P5-13）里不依赖数据库的部分：响应头、跨域、跨站请求伪造防护、查询参数形状、请求体上限、错误不泄露内部信息。
// 越权、跨租户、注入的全路由扫描在 testing/security-sweep.db.test.ts（真实数据库）。

type Harness = Awaited<ReturnType<typeof createTestApp>>
let h: Harness
let base = ''
const previousCors = process.env.CORS_ORIGINS

beforeAll(async () => {
  process.env.CORS_ORIGINS = 'https://app.example.test'
  h = await createTestApp({})
  base = (await h.app.getUrl()).replace('[::1]', '127.0.0.1')
})
afterAll(async () => {
  await h.close()
  if (previousCors === undefined) delete process.env.CORS_ORIGINS
  else process.env.CORS_ORIGINS = previousCors
})

const STACK_LIKE = /\n\s+at\s|node_modules|\.ts:\d+|PrismaClient|Invalid `|ECONN|SELECT\s|stack/i

describe('响应头', () => {
  it('接口响应：禁止被嵌入、禁止嗅探、不泄露技术栈、内容安全策略为全拒绝', async () => {
    const res = await h.call('GET', '/health', { auth: false })
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('认证接口的响应不得被缓存', async () => {
    const res = await h.call('POST', '/auth/refresh', { auth: false, headers: { origin: 'https://app.example.test' } })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('跨域与跨站请求伪造', () => {
  it('未登记的来源：预检与普通请求都拿不到跨域许可', async () => {
    const simple = await h.call('GET', '/health', { auth: false, headers: { origin: 'https://evil.example' } })
    expect(simple.headers.get('access-control-allow-origin')).toBeNull()
    const preflight = await fetch(`${base}/api/v1/orders`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('登记的来源：只回显该来源并允许携带凭据，不使用通配', async () => {
    const res = await h.call('GET', '/health', { auth: false, headers: { origin: 'https://app.example.test' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('刷新令牌接口：来源缺失或是外站时拒绝，同源且没有登录凭据时是未登录', async () => {
    const variants: Array<Record<string, string>> = [{}, { origin: 'https://evil.example' }, { origin: 'null' }, { referer: 'https://evil.example/page' }]
    for (const headers of variants) {
      const res = await h.call('POST', '/auth/refresh', { auth: false, headers: { cookie: 'nova_refresh=anything', ...headers } })
      expect(res.json?.error?.code, JSON.stringify(headers)).toBe('ORIGIN_NOT_ALLOWED')
    }
    const same = await h.call('POST', '/auth/refresh', { auth: false, headers: { origin: 'https://app.example.test' } })
    expect(same.status).toBe(401)
    expect(same.json?.error?.code).toBe('AUTH_REQUIRED')
  })

  it('只带 Cookie、不带访问令牌的请求，不能访问业务接口（凭据不会被浏览器自动附带）', async () => {
    const res = await h.call('GET', '/orders', { auth: false, headers: { cookie: 'nova_refresh=abc; session=abc' } })
    expect(res.status).toBe(401)
  })
})

describe('查询参数形状', () => {
  it.each(['/orders?q[$ne]=1', '/orders?status[]=a&status[]=b', '/orders?a=1&a=2', '/orders?a[b][c]=1', '/orders?q[__proto__][x]=1'])('%s：一律 400，不进入业务代码', async path => {
    const res = await h.call('GET', path, { auth: false })
    expect(res.status).toBe(400)
    expect(res.json?.error?.code).toBe('BAD_REQUEST')
    expect(JSON.stringify(res.json)).not.toMatch(STACK_LIKE)
  })

  it('普通字符串参数不受影响（落到鉴权，而不是形状检查）', async () => {
    const res = await h.call('GET', '/orders?q=abc&page=2', { auth: false })
    expect(res.status).toBe(401)
  })
})

describe('请求体与错误响应', () => {
  it('超过 1 MB 的请求体：413，错误码稳定', async () => {
    const res = await h.call('POST', '/auth/login', { auth: false, body: { email: 'a@b.cc', password: 'x'.repeat(1_200_000) } })
    expect(res.status).toBe(413)
    expect(res.json?.error?.code).toBe('REQUEST_BODY_TOO_LARGE')
  })

  it('损坏的 JSON：400，不回显解析器的内部信息', async () => {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email": ',
    })
    const text = await response.text()
    expect(response.status).toBe(400)
    expect(text).not.toMatch(STACK_LIKE)
    expect(text).not.toContain('Unexpected')
  })

  it('不存在的路径：404 且不泄露路由或堆栈', async () => {
    const res = await h.call('GET', '/definitely/not/here', { auth: false })
    expect([401, 404]).toContain(res.status)
    expect(JSON.stringify(res.json)).not.toMatch(STACK_LIKE)
  })

  it('请求编号：合法的沿用，带换行或过长的丢弃重新生成（防日志与响应头注入）', async () => {
    const good = await h.call('GET', '/orders', { auth: false, headers: { 'x-request-id': 'client-req-12345' } })
    expect(good.json?.error?.requestId).toBe('client-req-12345')
    for (const bad of ['short', 'x'.repeat(101), 'has space in it 12345', 'a<script>alert(1)</script>']) {
      const res = await h.call('GET', '/orders', { auth: false, headers: { 'x-request-id': bad } })
      expect(res.json?.error?.requestId, bad).toMatch(/^req_[0-9a-f-]{36}$/)
    }
  })

  it('伪造的访问令牌：401，不区分“格式错误”“签名错误”“已过期”', async () => {
    const codes = new Set<string>()
    for (const token of ['garbage', 'a.b.c', 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ1c2VyLTEifQ.', `${'x'.repeat(40)}.${'y'.repeat(40)}.${'z'.repeat(40)}`]) {
      const res = await h.call('GET', '/orders', { auth: false, headers: { authorization: `Bearer ${token}` } })
      expect(res.status, token).toBe(401)
      codes.add(String(res.json?.error?.code))
    }
    expect(codes.size).toBe(1)
  })
})
