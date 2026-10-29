import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOG } from '@nova/authz'
import { LIVE_PAGES } from './live-pages'
import { APP_ROUTES, NAV_GROUP_ORDER, REDIRECTS, REMOVED_PATHS, ROUTE_MANIFEST, buildNav, canAccess, matchManifest, specByComponent } from './manifest'

const routesDoc = readFileSync(fileURLToPath(new URL('../../../docs/erp-plan/freeze/routes.md', import.meta.url)), 'utf8')
const permissionsDoc = readFileSync(fileURLToPath(new URL('../../../docs/erp-plan/freeze/permissions.md', import.meta.url)), 'utf8')

// 平台运营后台的权限点属于平台账号体系，不在租户权限目录里
const PLATFORM_PERMISSIONS = new Set(['platform.tenant.read', 'platform.tenant.manage', 'platform.support.access'])

/** permissions.md 第十节登记的阶段 6 新增权限点：在对应工作包交付前还不在权限目录里（目录由第二节生成，要等交付时并入）。 */
function pendingStage6Permissions(): Set<string> {
  const section = permissionsDoc.split(/\r?\n/)
  const start = section.findIndex(line => line.startsWith('## 十、阶段 6 新增权限点'))
  if (start < 0) return new Set()
  const keys = section
    .slice(start + 1)
    .filter(line => /^\| `[a-z][a-z0-9.]*` \|/.test(line))
    .map(line => /^\| `([^`]+)`/.exec(line)![1])
  return new Set(keys)
}

describe('路由清单与 routes.md（P0-01）一致', () => {
  it('共 138 个路由：107 个原导航路由 + 24 个阶段 6 新增 + 7 个补充路由，路径与组件名都唯一', () => {
    expect(ROUTE_MANIFEST).toHaveLength(138)
    expect(new Set(ROUTE_MANIFEST.map(item => item.path)).size).toBe(138)
    expect(new Set(ROUTE_MANIFEST.map(item => item.component)).size).toBe(138)
    expect(ROUTE_MANIFEST.filter(item => item.group === '平台与公共')).toHaveLength(7)
    expect(ROUTE_MANIFEST.filter(item => item.stage === '6')).toHaveLength(24)
    expect(APP_ROUTES).toHaveLength(131)
  })

  it('16 章第 0 节的 12 个新分组：名称与顺序固定，每个分组至少有一个路由', () => {
    expect([...NAV_GROUP_ORDER]).toEqual(['首页', '统计分析', '商品与 Listing', '库存与补货', 'FBA 发货', '订单与售后', '财务与利润', '广告', '预警', '工具', '数据与报表', '设置'])
    const counts = Object.fromEntries(NAV_GROUP_ORDER.map(name => [name, APP_ROUTES.filter(item => item.group === name).length]))
    expect(counts).toEqual({ 首页: 5, 统计分析: 14, '商品与 Listing': 12, 库存与补货: 12, 'FBA 发货': 14, 订单与售后: 8, 财务与利润: 15, 广告: 20, 预警: 5, 工具: 4, 数据与报表: 4, 设置: 18 })
  })

  it('阶段 6 新增的 24 个路由：都有工作包编号，页面不在登记表里，不进导航，原有路由的阶段不被改动', () => {
    const fresh = ROUTE_MANIFEST.filter(item => item.stage === '6')
    expect(fresh.filter(item => !/^P6-\d+$/.test(item.workPackage))).toEqual([])
    // 工作包都在 14 章的阶段 6 范围内（P6-08 到 P6-33）
    expect(fresh.every(item => Number(item.workPackage.slice(3)) >= 8 && Number(item.workPackage.slice(3)) <= 33)).toBe(true)
    const nav = buildNav(component => component in LIVE_PAGES, { permissions: ['*'] })
    const navPaths = new Set(nav.flatMap(group => group.items.map(item => item.path)))
    // 还没交付（没登记页面）的阶段 6 路由不出现在导航里；交付后登记页面即可出现
    expect(fresh.filter(item => !(item.component in LIVE_PAGES) && navPaths.has(item.path))).toEqual([])
    expect(ROUTE_MANIFEST.filter(item => item.stage !== '6' && item.workPackage.startsWith('P6-'))).toEqual([])
  })

  it('阶段 6 新增路由的权限点：要么已在权限目录里，要么已在 permissions.md 第十节登记；第十节的点位不得与目录重复', () => {
    const known = new Set(PERMISSION_CATALOG.map(entry => entry.key))
    const pending = pendingStage6Permissions()
    expect(pending.size).toBe(0)
    expect([...pending].filter(key => known.has(key))).toEqual([])
    const missing = ROUTE_MANIFEST.filter(item => item.stage === '6' && item.access.kind === 'permission' && !known.has(item.access.permission) && !pending.has(item.access.permission)).map(
      item => item.path,
    )
    expect(missing).toEqual([])
  })

  it('“自定义报表永久不做”已改掉：/app/bi 仍然移除，但文档里不再有永久不做的说法', () => {
    expect(routesDoc).not.toContain('永久不做')
    expect(REMOVED_PATHS).toEqual(['/app/bi'])
    expect(matchManifest('/app/dashboards/d1')?.spec.component).toBe('DashboardDetailPage')
    expect(matchManifest('/app/reports/custom')?.spec.component).toBe('CustomReportsPage')
    expect(matchManifest('/app/reports/r1')?.spec.component).toBe('ReportJobDetailPage')
  })

  it('文档里出现的每个路由都在清单里，清单里的每个路由也都在文档里', () => {
    const tableRows = routesDoc.split(/\r?\n/).filter(line => line.startsWith('| `/'))
    const inDoc = tableRows.map(line => /^\| `([^`]+)`/.exec(line)![1])
    // 第三节的特殊规则行（contact-requests、bi）不是页面路由
    const pageRoutes = inDoc.filter(path => path !== '/app/contact-requests' && path !== '/app/bi' && path !== '/app')
    expect(new Set(pageRoutes)).toEqual(new Set(ROUTE_MANIFEST.map(item => item.path)))
  })

  it('每个路由的权限点都在权限目录里（平台后台权限除外；阶段 6 的路由见下一组测试）', () => {
    const known = new Set(PERMISSION_CATALOG.map(entry => entry.key))
    const unknown = ROUTE_MANIFEST.flatMap(item =>
      item.stage !== '6' && item.access.kind === 'permission' && !known.has(item.access.permission) && !PLATFORM_PERMISSIONS.has(item.access.permission)
        ? [`${item.path} → ${item.access.permission}`]
        : [],
    )
    expect(unknown).toEqual([])
  })

  it('所有原有 /app 路径都保留（除已移除的 /app/bi），分组顺序与文档一致', () => {
    const legacy = [
      '/app/overview',
      '/app/profit',
      '/app/reports',
      '/app/products',
      '/app/listings',
      '/app/purchase-orders',
      '/app/replenishment',
      '/app/supply-chain',
      '/app/inventory',
      '/app/warehouse',
      '/app/orders',
      '/app/returns',
      '/app/finance',
      '/app/settlements',
      '/app/advertising',
      '/app/advertising/reports',
      '/app/advertising/metrics',
      '/app/ad-terms',
      '/app/alerts',
      '/app/connections',
      '/app/sync',
      '/app/entities',
      '/app/members',
      '/app/audit',
      '/app/settings',
      '/app/profile',
    ]
    const paths = new Set(ROUTE_MANIFEST.map(item => item.path))
    expect(legacy.filter(path => !paths.has(path))).toEqual([])
    expect(paths.has('/app/bi')).toBe(false)
    expect(REMOVED_PATHS).toContain('/app/bi')
    const groupsInManifest = [...new Set(APP_ROUTES.map(item => item.group))]
    expect(groupsInManifest).toEqual([...NAV_GROUP_ORDER])
  })

  it('特殊规则：/app 与 /app/contact-requests 跳转到经营控制台', () => {
    expect(REDIRECTS).toEqual([
      { from: '/app', to: '/app/overview' },
      { from: '/app/contact-requests', to: '/app/overview' },
    ])
  })
})

describe('已上线页面登记表', () => {
  it('登记的组件都在路由清单里', () => {
    expect(Object.keys(LIVE_PAGES).filter(name => !specByComponent.has(name))).toEqual([])
  })

  it('利润分析已由 P2b-10 重做并上线；旧词级页已删除，词级中心与词级分析由 P3-10 重做并上线', () => {
    expect('ProfitPage' in LIVE_PAGES).toBe(true)
    expect(specByComponent.get('ProfitPage')?.workPackage).toBe('P2b-10')
    expect('AdTermsPage' in LIVE_PAGES).toBe(true)
    expect('AdTermDetailPage' in LIVE_PAGES).toBe(true)
    expect(specByComponent.get('AdTermsPage')?.workPackage).toBe('P3-10')
    // 详情页的 term 参数要放行
    expect(LIVE_PAGES.AdTermDetailPage?.search).toBeDefined()
  })

  it('14.11：/app 的落地页（经营控制台路由）必须有页面承载，不能落到“页面不存在”', () => {
    expect(REDIRECTS.every(item => item.to === '/app/overview')).toBe(true)
    expect('OverviewPage' in LIVE_PAGES).toBe(true)
    expect('TodayPage' in LIVE_PAGES).toBe(true)
  })

  it('任何已上线页面的标题都不含“规划中”', () => {
    const titles = Object.keys(LIVE_PAGES).map(name => specByComponent.get(name)!.title)
    expect(titles.filter(title => title.includes('规划中'))).toEqual([])
  })
})

describe('地址匹配', () => {
  it('静态路径优先于动态路径', () => {
    expect(matchManifest('/app/inventory/ledger')?.spec.component).toBe('InventoryLedgerPage')
    expect(matchManifest('/app/inventory/abc123')?.spec.component).toBe('InventoryDetailPage')
    expect(matchManifest('/app/inventory/abc123')?.params).toEqual({ id: 'abc123' })
  })

  it('支持末尾斜杠与编码参数；不在清单内的地址返回 null', () => {
    expect(matchManifest('/app/orders/')?.spec.component).toBe('OrdersPage')
    expect(matchManifest('/app/analytics/parents/B0%2FX')?.params).toEqual({ parentAsin: 'B0/X' })
    expect(matchManifest('/app/bi')).toBeNull()
    expect(matchManifest('/app/not-exists')).toBeNull()
  })
})

describe('权限判断', () => {
  const owner = { permissions: ['*'] }
  const reader = { permissions: ['orders.read'] }
  const admin = { permissions: ['member.manage'] }

  it('权限点、基础、公开、所有者与管理员四类规则', () => {
    expect(canAccess({ kind: 'permission', permission: 'orders.read' }, reader)).toBe(true)
    expect(canAccess({ kind: 'permission', permission: 'finance.read' }, reader)).toBe(false)
    expect(canAccess({ kind: 'permission', permission: 'finance.read' }, owner)).toBe(true)
    expect(canAccess({ kind: 'base' }, reader)).toBe(true)
    expect(canAccess({ kind: 'base' }, null)).toBe(false)
    expect(canAccess({ kind: 'public' }, null)).toBe(true)
    expect(canAccess({ kind: 'owner-admin' }, reader)).toBe(false)
    expect(canAccess({ kind: 'owner-admin' }, admin)).toBe(true)
    expect(canAccess({ kind: 'owner-admin' }, owner)).toBe(true)
  })
})

describe('导航生成', () => {
  // AdTermsPage 故意不登记：模拟未上线页面
  const live = new Set(['OrdersPage', 'FeeEventsPage', 'ProfilePage', 'InventoryDetailPage'])
  const isLive = (component: string) => live.has(component)

  it('只含已上线且有权限的页面，详情页与功能页不进导航', () => {
    const groups = buildNav(isLive, { permissions: ['orders.read', 'finance.read'] })
    const paths = groups.flatMap(group => group.items.map(item => item.path))
    expect(paths).toEqual(['/app/orders', '/app/finance', '/app/profile'])
    expect(paths).not.toContain('/app/inventory/:id')
  })

  it('没有权限的页面导航项隐藏', () => {
    const groups = buildNav(isLive, { permissions: ['orders.read'] })
    expect(groups.flatMap(group => group.items.map(item => item.path))).toEqual(['/app/orders', '/app/profile'])
  })

  it('未上线页面不出现，空分组不显示，分组顺序固定', () => {
    const groups = buildNav(isLive, { permissions: ['*'] })
    expect(groups.map(group => group.label)).toEqual(['订单与售后', '财务与利润', '设置'])
    expect(groups.flatMap(group => group.items.map(item => item.title))).not.toContain('词级中心')
  })

  it('旧导航里的“自定义 BI”“官网线索”不再出现', () => {
    const groups = buildNav(() => true, { permissions: ['*'] })
    const titles = groups.flatMap(group => group.items.map(item => item.title))
    expect(titles).not.toContain('自定义 BI')
    expect(titles).not.toContain('官网线索')
  })
})
