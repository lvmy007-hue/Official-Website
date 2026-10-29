import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './testing/harness'
import { AUTHENTICATED_ONLY, PUBLIC_ROUTES } from './testing/route-registry'
import { collectRoutes, routeKey } from './testing/route-table'

// 渗透测试材料的接口清单（P5-13）：从已注册的全部接口自动生成，清单与代码不一致时测试失败，
// 保证交给第三方的范围始终完整。更新方法：UPDATE_ROUTE_INVENTORY=1 运行本测试，并把变更一起评审。

const FILE = join(__dirname, '..', '..', '..', 'docs', 'security', 'pentest', 'route-inventory.md')

function classify(method: string, path: string): string {
  const key = `${method} ${path}`
  if (key in PUBLIC_ROUTES) return '公开'
  if (path.startsWith('/api/v1/platform/')) return '平台账号'
  if (key in AUTHENTICATED_ONLY) return '仅需登录'
  return '企业成员（按权限点）'
}

function render(routes: Array<{ method: string; path: string }>): string {
  const counts = new Map<string, number>()
  const rows = routes.map(route => {
    const kind = classify(route.method, route.path)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    const note = PUBLIC_ROUTES[routeKey(route)] ?? AUTHENTICATED_ONLY[routeKey(route)] ?? ''
    return `| ${route.method} | \`${route.path}\` | ${kind} | ${note.replace(/\|/g, '/')} |`
  })
  const summary = [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join('，')
  return [
    '# 接口清单（渗透测试范围）',
    '',
    '本文件由 `apps/api/src/route-inventory.test.ts` 自动生成，请勿手工编辑；更新方法见该测试文件顶部说明。',
    '',
    `共 ${routes.length} 个接口：${summary}。`,
    '',
    '“企业成员（按权限点）”表示需要有效的访问令牌，并在服务内按权限点、范围（企业主体与店铺）校验；越权应返回 403，对象不属于当前企业应返回 404。',
    '',
    '| 方法 | 路径 | 鉴权类别 | 说明 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

describe('渗透测试接口清单', () => {
  let harness: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    harness = await createTestApp({})
  })
  afterAll(async () => {
    await harness.close()
  })

  it('docs/security/pentest/route-inventory.md 与已注册的接口一致', () => {
    const expected = render(collectRoutes(harness.app))
    if (process.env.UPDATE_ROUTE_INVENTORY === '1') writeFileSync(FILE, expected, 'utf8')
    const actual = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
    expect(actual, '接口清单已过期：UPDATE_ROUTE_INVENTORY=1 重新生成并评审').toBe(expected)
  })

  it('登记表里的每一条都对应真实存在的接口（不留过期登记）', () => {
    const real = new Set(collectRoutes(harness.app).map(routeKey))
    const stale = [...Object.keys(PUBLIC_ROUTES), ...Object.keys(AUTHENTICATED_ONLY)].filter(key => !real.has(key))
    expect(stale).toEqual([])
  })
})
