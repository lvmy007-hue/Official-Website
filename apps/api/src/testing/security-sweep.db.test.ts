import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'
import { collectRoutes, fillParams, hasParams, routeKey, sensitiveKeys, withoutPrefix, type RouteEntry } from './route-table'
import { listTenantTables, seedTenantRows } from './tenant-seed'

// 安全扫描（P5-13，12.9 第 13 条）：真实数据库 + 完整应用，对“已注册的全部接口”逐条做四类检查，新增接口自动纳入。
// 1. 敏感信息：任何响应都不得出现口令哈希、令牌、密文等键名，也不得出现植入的秘密值；
// 2. 跨企业：两个企业各有全权限成员，彼此的读接口都看不到对方的标记；
// 3. 注入与畸形输入：查询参数带 SQL 片段、对象形式、超长文本、路径参数带穿越字符，一律不得 5xx；
// 4. 写接口带畸形请求体：不得 5xx，对方企业的数据在整轮攻击前后逐表一致。
// 参数校验之外是否还有深层漏洞这里无法证明，所以另有静态检查（scripts/check-security.mjs）把原始 SQL 与危险调用挡在源码层。

const SKIP_PREFIX = ['/api/v1/platform/', '/api/v1/storage/', '/api/v1/commerce/', '/api/v1/payments/']
// 登出与注销会话会让后面的请求失效；授权回调需要上游参数
const SKIP_WRITE = ['POST /api/v1/auth/logout', 'DELETE /api/v1/auth/sessions/:id']
const SECRETS = { password: 'SECRET-PWHASH', mfa: 'SECRET-MFA', session: 'SECRET-RTHASH', cipher: 'SECRET-CIPHER', invite: 'SECRET-INVITE' }

const QUERY_PARAMS = ['q', 'sort', 'cursor', 'status', 'storeId', 'from', 'sku', 'asin', 'type', 'supplierId', 'marketplaceId', 'currency']
const INJECTION_VALUES = [`' OR 1=1--`, `"; DROP TABLE "Order"; --`, '%00', '<script>alert(1)</script>', '{{7*7}}', 'a'.repeat(3000)]
// qs 会把 q[$ne]=1 解析成对象，服务里按字符串处理的地方容易在这里崩溃
const OBJECT_FORMS = (param: string) => [`${param}[$ne]=1`, `${param}[]=a&${param}[]=b`, `${param}[a][b]=c`]
const PATH_VALUES = ['nope', `' OR '1'='1`, '..%2F..%2Fetc%2Fpasswd', '%00', 'a'.repeat(500)]
const BAD_BODIES: unknown[] = [{}, { invalid: true, items: 'bad', amount: 'bad' }, { __proto__: { admin: true }, constructor: { prototype: { x: 1 } } }, [], { id: { $ne: 1 }, name: ['x'] }]

// 5xx 里只有“部署配置缺失”（503，错误码以 _MISSING 或 NOT_CONFIGURED 结尾）是预期的：测试环境没有配置亚马逊回调地址等外部参数
const isFault = (status: number, text: string) => status >= 500 && !(status === 503 && /_MISSING|NOT_CONFIGURED/.test(text))

type Side = { marker: string; token: string; tenantId: string; leakMarks: string[] }

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) await Promise.all(items.slice(index, index + size).map(run))
}

describe('安全扫描（真实数据库，全部已注册接口）', () => {
  let h: DbTestApp
  let a: Side
  let b: Side
  let routes: RouteEntry[]
  let tenantTables: string[]
  const visibleOwn = new Set<string>()

  async function raw(token: string | null, method: string, path: string, body?: unknown) {
    const response = await fetch(`${h.baseUrl}/api/v1${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method !== 'GET' ? { 'idempotency-key': `sweep-${Math.random().toString(36).slice(2)}-${Date.now()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, text: await response.text(), headers: response.headers }
  }

  async function snapshot(tenantId: string) {
    const out: Record<string, string> = {}
    for (const table of tenantTables) {
      const { rows } = await h.client.query(`SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) AS digest, count(*)::int AS n FROM "${table}" t WHERE t."tenantId" = $1`, [tenantId])
      out[table] = `${rows[0].n}:${rows[0].digest}`
    }
    return out
  }

  /** 响应里不得出现的内容：敏感键名、植入的秘密值、对方企业的标记。 */
  function problems(label: string, text: string, other: Side): string[] {
    const found: string[] = []
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    const keys = sensitiveKeys(parsed)
    if (keys.length) found.push(`${label} 含敏感键名 ${keys.join(',')}`)
    for (const secret of Object.values(SECRETS)) if (text.includes(secret)) found.push(`${label} 含秘密值 ${secret}`)
    for (const mark of other.leakMarks) if (text.includes(mark)) found.push(`${label} 含对方企业标记 ${mark}`)
    return found
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'securitysweep' })
    const sides: Side[] = []
    for (const [name, suffix] of [
      ['A', 'sa'],
      ['B', 'sb'],
    ] as const) {
      const tenant = await h.createTenant(suffix)
      const member = await h.createMember(tenant.tenantId, suffix, ['*'])
      sides.push({ marker: `MKS${name}`, token: member.token, tenantId: tenant.tenantId, leakMarks: [`MKS${name}`, `-s${suffix.slice(1)}@`] })
    }
    ;[a, b] = sides
    tenantTables = await listTenantTables(h.client)
    await h.client.query(`SET session_replication_role = replica`)
    for (const side of sides) await seedTenantRows(h.client, tenantTables, side.tenantId, side.marker)
    for (const [side, suffix] of [
      [a, 'sa'],
      [b, 'sb'],
    ] as const) {
      await h.client.query(`UPDATE "PlatformConnection" SET provider = 'AMAZON_SP_API', state = 'AUTHORIZED', "encryptedRefreshToken" = $2 WHERE id = $1`, [
        `PlatformConnection-${side.marker}`,
        SECRETS.cipher,
      ])
      await h.client.query(`UPDATE "User" SET "passwordHash" = $2 WHERE id = $1`, [`member-${suffix}`, SECRETS.password])
      await insertRow(h.client, 'MfaFactor', { id: `mfa-${suffix}`, userId: `member-${suffix}`, kind: 'TOTP', secretCiphertext: `${SECRETS.mfa}-${suffix}` })
      await h.client.query(`UPDATE "Session" SET "refreshTokenHash" = $2 WHERE id = $1`, [`session-${suffix}`, SECRETS.session])
      await insertRow(h.client, 'TenantInvitation', { id: `inv-${suffix}`, tenantId: side.tenantId, tokenHash: `${SECRETS.invite}-${suffix}`, email: `invitee-${suffix}@example.com` })
    }
    await h.client.query(`SET session_replication_role = DEFAULT`)
    routes = collectRoutes(h.app).filter(route => !SKIP_PREFIX.some(prefix => route.path.startsWith(prefix)))
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('路由表不为空，且包含读写两类接口（防止扫描空转）', () => {
    expect(routes.filter(route => route.method === 'GET' && !hasParams(route.path)).length).toBeGreaterThan(100)
    expect(routes.filter(route => route.method !== 'GET').length).toBeGreaterThan(100)
  })

  it('读接口：不 5xx、响应不含敏感键名与秘密值、看不到对方企业的数据', async () => {
    const failures: string[] = []
    const reads = routes.filter(route => route.method === 'GET' && !hasParams(route.path))
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      await inBatches(reads, 8, async route => {
        const res = await raw(self.token, 'GET', withoutPrefix(route.path))
        const label = `${self === a ? 'A' : 'B'} ${routeKey(route)} -> ${res.status}`
        if (isFault(res.status, res.text)) failures.push(`${label} ${res.text.slice(0, 160)}`)
        for (const issue of problems(label, res.text, other)) failures.push(issue)
        if (res.text.includes(self.marker)) visibleOwn.add(route.path)
        const type = res.headers.get('content-type') ?? ''
        if (res.status < 500 && res.text && !/json|csv|text\/plain|octet-stream|zip|spreadsheet/.test(type)) failures.push(`${label} 内容类型异常 ${type}`)
        if (res.headers.get('x-content-type-options') !== 'nosniff') failures.push(`${label} 缺少 nosniff`)
      })
    }
    expect(failures).toEqual([])
    // 对照：真有一批接口读到了本企业数据，说明上面的“看不到对方”不是因为什么都查不到
    expect(visibleOwn.size, `能看见本企业数据的接口：${[...visibleOwn].join(', ')}`).toBeGreaterThan(40)
  })

  it('带路径参数的读接口：陌生编号、注入片段、路径穿越都不得 5xx，也不得泄露', async () => {
    const failures: string[] = []
    const reads = routes.filter(route => route.method === 'GET' && hasParams(route.path))
    expect(reads.length).toBeGreaterThan(50)
    await inBatches(reads, 8, async route => {
      for (const value of PATH_VALUES) {
        const res = await raw(a.token, 'GET', fillParams(route.path, value))
        const label = `A ${routeKey(route)} [${value.slice(0, 20)}] -> ${res.status}`
        if (isFault(res.status, res.text)) failures.push(`${label} ${res.text.slice(0, 160)}`)
        for (const issue of problems(label, res.text, b)) failures.push(issue)
      }
    })
    expect(failures).toEqual([])
  })

  it('查询参数注入与畸形形式：不得 5xx，数据表与两个企业的数据都完好', async () => {
    const before = [await snapshot(a.tenantId), await snapshot(b.tenantId)]
    const failures: string[] = []
    const reads = routes.filter(route => route.method === 'GET' && !hasParams(route.path))
    const queries = [
      ...QUERY_PARAMS.flatMap(param => INJECTION_VALUES.slice(0, 3).map(value => `${param}=${encodeURIComponent(value)}`)),
      ...QUERY_PARAMS.flatMap(OBJECT_FORMS),
      `pageSize=${encodeURIComponent(INJECTION_VALUES[5])}`,
      `q=${encodeURIComponent(INJECTION_VALUES[3])}&search=${encodeURIComponent(INJECTION_VALUES[4])}`,
    ]
    await inBatches(reads, 8, async route => {
      for (const query of queries) {
        const res = await raw(a.token, 'GET', `${withoutPrefix(route.path)}?${query}`)
        if (isFault(res.status, res.text)) failures.push(`GET ${route.path}?${query.slice(0, 60)} -> ${res.status} ${res.text.slice(0, 120)}`)
        if (/prisma|syntax error at|SELECT .* FROM|\bstack\b|at .*\.ts:\d+/i.test(res.text)) failures.push(`GET ${route.path}?${query.slice(0, 40)} 响应暴露内部细节`)
      }
    })
    expect(failures).toEqual([])
    expect((await h.client.query(`SELECT count(*)::int AS n FROM "Order"`)).rows[0].n).toBeGreaterThanOrEqual(2)
    expect([await snapshot(a.tenantId), await snapshot(b.tenantId)]).toEqual(before)
  })

  it('写接口带畸形请求体与陌生编号：不得 5xx，对方企业的数据逐表不变', async () => {
    const beforeB = await snapshot(b.tenantId)
    const failures: string[] = []
    const writes = routes.filter(route => route.method !== 'GET' && !SKIP_WRITE.includes(routeKey(route)) && !route.path.startsWith('/api/v1/auth/'))
    await inBatches(writes, 6, async route => {
      for (const body of BAD_BODIES) {
        const res = await raw(a.token, route.method, fillParams(route.path, 'nope'), body)
        if (isFault(res.status, res.text)) failures.push(`${routeKey(route)} ${JSON.stringify(body).slice(0, 40)} -> ${res.status} ${res.text.slice(0, 120)}`)
        for (const issue of problems(routeKey(route), res.text, b)) failures.push(issue)
      }
    })
    expect(failures).toEqual([])
    expect(await snapshot(b.tenantId), '对方企业的数据在攻击后发生了变化').toEqual(beforeB)
  })

  it('未登录与伪造令牌：全部读接口一律 401，不泄露任何业务数据', async () => {
    const failures: string[] = []
    const reads = routes.filter(route => route.method === 'GET' && !hasParams(route.path))
    await inBatches(reads, 8, async route => {
      for (const token of [null, 'not-a-jwt', `${a.token.slice(0, -4)}AAAA`]) {
        const res = await raw(token, 'GET', withoutPrefix(route.path))
        const publicRead = ['/api/v1/health', '/api/v1/sp-api/oauth/callback', '/api/v1/ads/oauth/callback'].includes(route.path)
        if (!publicRead && res.status !== 401) failures.push(`${routeKey(route)} (${token?.slice(0, 8) ?? '无令牌'}) -> ${res.status}`)
        for (const mark of [a.marker, b.marker]) if (res.status === 401 && res.text.includes(mark)) failures.push(`${routeKey(route)} 401 响应含业务数据`)
      }
    })
    expect(failures).toEqual([])
  })
})
