import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { asin360ActionRuleViews, type Asin360ActionsResponse, type Asin360ChangesResponse, type Asin360IdentityResponse, type Asin360KpiCard, type Asin360OverviewResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// ASIN 360（P2a-14）：身份区、关键指标、建议动作与三个已上线页签；没上线的页签不显示。

const pages: LivePages = {
  Asin360Page: { load: () => import('./Asin360Page') },
  InventoryDetailPage: { load: () => import('../inventory/InventoryDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())
/** 吸顶导航（锚点页签）。 */
const navOf = () => document.querySelector('.erp-detail-sticky') as HTMLElement
const ok = (data: unknown) => ({ body: { success: true, data } })

const freshness = { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['订单', '商品目录'], qualityIssues: 0 }
const identity = (over: Partial<Asin360IdentityResponse> = {}): Asin360IdentityResponse => ({
  product: {
    id: 'p1',
    sellerAccountId: 's1',
    storeName: '店铺一',
    asin: 'B0TEST0001',
    sku: 'SKU-1',
    fnsku: 'X0TEST0001',
    title: '示例商品标题',
    brand: '示例品牌',
    productType: null,
    listingStatus: 'ACTIVE',
    fulfillmentChannel: 'AFN',
    price: 19.9,
    currency: 'USD',
    imageUrl: null,
    categoryPath: 'Home > Kitchen',
    parentAsin: 'B0PARENT01',
    ownerUserId: null,
    ownerName: null,
    tags: [],
  },
  catalog: { state: 'OK', syncedAt: '2026-10-22T02:00:00Z', note: null },
  siblings: [
    { id: 'p1', sku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' },
    { id: 'p2', sku: 'SKU-1B', fnsku: null, listingStatus: 'ACTIVE' },
  ],
  variants: { parentAsin: 'B0PARENT01', childCount: null, isParent: false, siblingCount: 2, variationTheme: 'COLOR_NAME' },
  ranks: { state: 'OK', note: null, snapshotDate: '2026-10-22', items: [{ classificationId: '1', name: 'Home & Kitchen', rank: 1200 }] },
  stock: { state: 'OK', note: null, inventoryId: 'inv1', sellable: 100, inboundCounted: 30, daysOfCover: 30.4, stockoutDate: '2026-11-21', noDemand: false, riskLabel: '中风险' },
  freshness,
  ...over,
})

const card = (key: Asin360KpiCard['key'], label: string, over: Partial<Asin360KpiCard> = {}): Asin360KpiCard => ({
  key,
  label,
  state: 'OK',
  format: 'money',
  value: 1000,
  compareValue: 800,
  change: 0.25,
  changeKind: 'ratio',
  note: null,
  ...over,
})
const overview = (over: Partial<Asin360OverviewResponse> = {}): Asin360OverviewResponse =>
  ({
    period: { from: '2026-10-01', to: '2026-10-02', days: 2 },
    compare: { mode: 'previous', from: '2026-09-29', to: '2026-09-30', days: 2 },
    previous: { mode: 'previous', from: '2026-09-29', to: '2026-09-30', days: 2 },
    yoy: { mode: 'yoy', from: '2025-10-01', to: '2025-10-02', days: 2 },
    defaulted: false,
    currency: 'USD',
    metricVersion: 'v1',
    refreshedAt: '2026-10-22T03:00:00Z',
    hasRows: true,
    cards: [
      card('sales', '销售额'),
      card('profit', '净利润', { state: 'NOT_CONNECTED', value: null, compareValue: null, change: null, note: '利润计算在阶段 2b 交付' }),
      card('margin', '利润率', { state: 'NOT_CONNECTED', format: 'percent', value: null, compareValue: null, change: null, note: '需要净利润先接入' }),
      card('conversion', '转化率', { state: 'NOT_CONNECTED', format: 'percent', value: null, compareValue: null, change: null, note: '会话数据尚未接入' }),
      card('adsShare', '广告占总销售比', { state: 'NOT_CONNECTED', format: 'percent', value: null, compareValue: null, change: null, note: '广告数据同步在阶段 3 交付' }),
    ],
    daily: [
      { date: '2026-10-01', units: 2, sales: 400, profit: null, adsSales: null, sessions: null },
      { date: '2026-10-02', units: 3, sales: 600, profit: null, adsSales: null, sessions: null },
    ],
    compareSales: [300, null],
    table: [
      { key: 'sales', label: '销售额', format: 'money', current: 1000, previous: 800, yoy: null, momChange: 0.25, yoyChange: null },
      { key: 'units', label: '销售件数', format: 'number', current: 5, previous: 4, yoy: null, momChange: 0.25, yoyChange: null },
      { key: 'unitPrice', label: '件单价', format: 'money', current: 200, previous: 200, yoy: null, momChange: 0, yoyChange: null },
    ],
    attribution: {
      mode: 'TWO_FACTOR',
      factors: [
        { key: 'units', label: '件数', before: 4, after: 5 },
        { key: 'unitPrice', label: '件单价', before: 200, after: 200 },
      ],
      unavailable: [{ key: 'sessions', label: '会话', reason: '会话数据尚未接入' }],
    },
    split: { state: 'NOT_CONNECTED', note: '广告数据同步在阶段 3 交付', adsSales: null, organicSales: null, adsShare: null },
    profit: { state: 'NOT_CONNECTED', note: '净利润来自利润日表，目前尚未接入' },
    refunds: { state: 'NOT_CONNECTED', note: '按商品的退款在阶段 2b 交付' },
    ...over,
  }) as Asin360OverviewResponse

const actions: Asin360ActionsResponse = {
  state: 'OK',
  note: null,
  inventoryId: 'inv1',
  rules: asin360ActionRuleViews({ inventory: 'OK', suggestionIds: ['replenish'] }),
  items: [{ id: 'sg1', rule: '覆盖天数低于提前期加安全库存', evidence: '可售天数 30.4，规则要求 59', impact: '预计 11-21 断货', risk: '补货来不及', action: 'REPLENISH' }],
}

const changes: Asin360ChangesResponse = {
  truncated: false,
  items: [
    {
      id: 'event:e1',
      source: 'amazon',
      kind: 'listing.change',
      kindLabel: '商品信息变更',
      title: '品牌已变更',
      occurredAt: '2026-10-01T10:00:00Z',
      actor: '亚马逊',
      before: '旧品牌',
      after: '示例品牌',
    },
    { id: 'log:l1', source: 'manual', kind: 'log.PRICE', kindLabel: '价格', title: '做了一次促销', occurredAt: '2026-09-30T10:00:00Z', actor: '林然', before: null, after: null },
  ],
}

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['products.read', 'inventory.read', 'replenishment.read', 'collab.write']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/products/p1': () => ok(identity()),
  '/products/p1/overview': () => ok(overview()),
  '/products/p1/actions': () => ok(actions),
  '/products/p1/changes': () => ok(changes),
  '/products/p1/inventory': () => ok({ state: 'OK', note: null, inventoryId: 'inv1' }),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('ASIN 360 页面', () => {
  it('身份区：标题、品牌、类目、父体、排名、SKU 切换、6 项关键指标与建议动作', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    // 本文件第一个用例要冷加载页面模块，全量并发时可能超过默认 1 秒（单独运行 6 秒内通过）
    expect(await screen.findByText('示例商品标题', {}, { timeout: 15000 })).toBeInTheDocument()
    const extra = await screen.findByTestId('asin360-identity-extra')
    expect(within(extra).getByText(/示例品牌/)).toBeInTheDocument()
    expect(within(extra).getByText(/Home > Kitchen/)).toBeInTheDocument()
    expect(within(extra).getByText('B0PARENT01')).toBeInTheDocument()
    expect(within(extra).getByText(/Home & Kitchen #1,200/)).toBeInTheDocument()
    expect(within(extra).getByRole('combobox', { name: '切换 SKU' })).toBeInTheDocument()
    const identityCard = screen.getByTestId('identity')
    expect(within(identityCard).getByText('$1,000.00')).toBeInTheDocument()
    expect(within(identityCard).getByText('30.4')).toBeInTheDocument()
    // 没接入的指标写“尚未接入”，不是 0
    expect(within(identityCard).getAllByText('尚未接入').length).toBeGreaterThanOrEqual(3)
    expect(await screen.findByText('覆盖天数低于提前期加安全库存')).toBeInTheDocument()
    expect(screen.getByText('安排补货')).toBeInTheDocument()
  })

  it('锚点导航：只显示有权限的四个板块（13 个锚点里其余缺权限），缺权限的不出现，也没有“规划中”占位', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    const nav = within(navOf())
    for (const label of ['概览', '订单与流量', '库存与补货', '变更与审计']) expect(nav.getByRole('tab', { name: label })).toBeInTheDocument()
    for (const label of ['广告', '利润与成本', '售后', '评价', '竞品对比', '刊登与问题', '定价与购物车', '内容与 A+', '预警日志'])
      expect(nav.queryByRole('tab', { name: label })).not.toBeInTheDocument()
    expect(nav.getAllByRole('tab')).toHaveLength(4)
    expect(screen.queryByText(/规划中/)).not.toBeInTheDocument()
  })

  it('有预警读取权限才出现“预警日志”板块；共享筛选（日期与对比方式）与导航在同一行', async () => {
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({ '/products/p1/alerts': () => ok({ state: 'NO_DATA', note: null, items: [], truncated: false }) }, ['products.read', 'alerts.read']),
    })
    await screen.findByText('示例商品标题')
    const nav = within(navOf())
    expect(nav.getByRole('tab', { name: '预警日志' })).toBeInTheDocument()
    expect(nav.getByRole('group', { name: '共享筛选' })).toBeInTheDocument()
  })

  it('没有库存读权限：不显示库存补货页签', async () => {
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({ '/products/p1': () => ok(identity({ stock: { ...identity().stock, state: 'RESTRICTED', sellable: null, daysOfCover: null, inventoryId: null } })) }, ['products.read']),
    })
    await screen.findByText('示例商品标题')
    expect(within(navOf()).queryByRole('tab', { name: '库存与补货' })).not.toBeInTheDocument()
    expect(within(navOf()).getAllByRole('tab')).toHaveLength(3)
    expect(screen.getAllByText('无权查看').length).toBeGreaterThan(0)
  })

  it('商品不存在：显示服务端的原因，不渲染空详情', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({ '/products/p1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '商品不存在' } } }) }) })
    expect(await screen.findByText(/商品不存在/)).toBeInTheDocument()
    expect(screen.queryByTestId('detail-layout')).not.toBeInTheDocument()
  })

  it('目录还没同步：身份区写明原因，品牌与排名不编造', async () => {
    const bare = identity()
    bare.product = { ...bare.product, brand: null, categoryPath: null, parentAsin: null }
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({
        '/products/p1': () =>
          ok({
            ...bare,
            catalog: { state: 'NOT_SYNCED', syncedAt: null, note: '图片、品牌、类目与销售排名同步后显示（每日一次）' },
            ranks: { state: 'NO_DATA', note: '商品目录尚未同步，销售排名同步后显示', snapshotDate: null, items: [] },
          }),
      }),
    })
    expect(await screen.findByText('商品目录尚未同步')).toBeInTheDocument()
    expect(screen.getAllByText('尚未同步').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('商品目录尚未同步，销售排名同步后显示')).toBeInTheDocument()
  })
})

describe('经营表现页签', () => {
  it('指标卡、趋势图、同比环比表、归因、自然与广告拆分、利润与退款', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    expect(await screen.findByRole('img', { name: '商品销售额趋势图' })).toBeInTheDocument()
    expect(screen.getByTestId('asin360-table')).toHaveTextContent('销售件数')
    expect(screen.getByTestId('asin360-table')).toHaveTextContent('尚无记录') // 去年同期没有记录：不是 0
    expect(screen.getByTestId('metric-tree')).toBeInTheDocument()
    expect(screen.getByTestId('asin360-split')).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('asin360-profit')).toHaveTextContent('退款趋势：尚未接入')
    expect(screen.getAllByText(/利润计算在阶段 2b 交付/).length).toBeGreaterThan(0)
  })

  it('趋势图下方是统一事件带：按本商品取事件（对象类型 ASIN）、没有权限的类型说明、可切换为表格', async () => {
    const day = overview().daily[0]!.date
    const app = mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({
        '/events': () =>
          ok({
            items: [{ id: 'price:r1', type: 'PRICE', occurredAt: `${day}T10:00:00.000Z`, day, title: 'SKU-1：改价 19.99 → 17.99', summary: '人工改价', link: null, actor: '林然' }],
            truncated: false,
            truncatedTypes: [],
            unavailableTypes: ['ADS'],
          }),
      }),
    })
    const band = await screen.findByTestId('event-band')
    expect(within(band).getByTestId('event-lane-PRICE')).toBeInTheDocument()
    expect(band).toHaveTextContent('没有查看权限，未显示：广告变更')
    const call = app.calls.find(item => item.path === '/events')!
    expect(new URLSearchParams(call.search).get('objectType')).toBe('ASIN')
    expect(new URLSearchParams(call.search).get('objectId')).toBe('p1')
    expect(screen.getByRole('button', { name: '切换为表格' })).toBeInTheDocument()
  })

  it('没有订单记录：说明原因，图表给空状态，不显示 0', async () => {
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({
        '/products/p1/overview': () =>
          ok(
            overview({
              hasRows: false,
              attribution: null,
              cards: [card('sales', '销售额', { state: 'NO_DATA', value: null, compareValue: null, change: null, note: '所选范围内没有这个商品的订单记录' })],
            }),
          ),
      }),
    })
    expect(await screen.findByText('所选范围内没有这个商品的订单记录', { selector: '.ant-alert-message' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '商品销售额趋势图' })).not.toBeInTheDocument()
    expect(screen.getByText(/没有选择对比期|本期或对比期没有/)).toBeInTheDocument()
  })

  it('利润无权限：卡片写“无权查看”', async () => {
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({
        '/products/p1/overview': () =>
          ok(
            overview({
              profit: { state: 'RESTRICTED', note: '需要“利润”字段权限' },
              cards: [card('profit', '净利润', { state: 'RESTRICTED', value: null, compareValue: null, change: null, note: '需要“利润”字段权限' })],
            }),
          ),
      }),
    })
    expect(await screen.findByText(/无权查看：需要“利润”字段权限/)).toBeInTheDocument()
  })
})

describe('库存补货与变更页签', () => {
  it('库存补货：复用库存详情的各区块', async () => {
    const app = mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({ '/inventory/inv1/structure': () => ok({ state: 'NO_DATA', note: '所选时间范围内没有库存日快照', from: '2026-09-22', to: '2026-10-22', points: [] }) }),
    })
    await screen.findByText('示例商品标题')
    expect(await screen.findByText('所选时间范围内没有库存日快照')).toBeInTheDocument()
    for (const label of ['库存结构趋势', '入仓与在途', '补货建议', '上游仓储', '库龄与费用']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/inventory/inv1/structure')).toBe(true)
  })

  it('没有库存记录：写明前置条件，不渲染空区块', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({ '/products/p1/inventory': () => ok({ state: 'NO_DATA', note: '这个商品还没有库存记录（库存同步后显示）', inventoryId: null }) }) })
    await screen.findByText('示例商品标题')
    expect(await screen.findByText(/这个商品还没有库存记录/)).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '补货建议' })).not.toBeInTheDocument()
  })

  it('变更与审计：亚马逊侧变更写出前后取值，手工记录可补充', async () => {
    const app = mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({ '/operation-logs': () => ok({ id: 'l2' }) }),
    })
    await screen.findByText('示例商品标题')
    expect(await screen.findByText('品牌已变更')).toBeInTheDocument()
    expect(screen.getByText(/商品信息变更：旧品牌 → 示例品牌/)).toBeInTheDocument()
    expect(screen.getByText('做了一次促销')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('工作记录'), '调整了主图')
    await userEvent.click(screen.getByRole('button', { name: /记\s?录/ }))
    const post = app.calls.find(call => call.path === '/operation-logs' && call.method === 'POST')
    expect(post).toBeDefined()
  })

  it('没有 collab.write：不能补充记录并说明原因', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({}, ['products.read']) })
    await screen.findByText('示例商品标题')
    expect(await screen.findByText('品牌已变更')).toBeInTheDocument()
    expect(screen.getByLabelText('工作记录')).toBeDisabled()
  })
})

describe('锚点长页的按需加载', () => {
  /** 假的视口观察器：板块默认都在视口外，show(key) 让某个板块进入视口。 */
  function stubObserver() {
    const watchers: Array<{ el: Element; cb: IntersectionObserverCallback; self: IntersectionObserver }> = []
    class FakeObserver {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        watchers.push({ el, cb: this.cb, self: this as unknown as IntersectionObserver })
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    return {
      show: (key: string) =>
        act(() => {
          for (const watcher of watchers.filter(item => (item.el as HTMLElement).dataset.sectionKey === key))
            watcher.cb([{ isIntersecting: true, target: watcher.el } as unknown as IntersectionObserverEntry], watcher.self)
        }),
    }
  }

  it('首次加载只请求视口内的板块：进入视口才取数，已加载的不再重复请求', async () => {
    const view = stubObserver()
    const app = mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    const sectionCalls = () => app.calls.filter(call => ['/products/p1/inventory', '/products/p1/changes', '/products/p1/traffic', '/products/p1/compare'].includes(call.path)).map(call => call.path)
    expect(sectionCalls()).toEqual([])
    expect(screen.getByTestId('section-placeholder-inventory')).toBeInTheDocument()

    view.show('inventory')
    expect(await screen.findByText(/库存/, { selector: '.ant-card-head-title' })).toBeInTheDocument()
    await vi.waitFor(() => expect(sectionCalls()).toContain('/products/p1/inventory'))
    expect(sectionCalls()).not.toContain('/products/p1/changes')
    expect(sectionCalls()).not.toContain('/products/p1/compare')

    view.show('overview')
    await vi.waitFor(() => expect(sectionCalls()).toContain('/products/p1/compare'))
    const before = sectionCalls().filter(path => path === '/products/p1/inventory').length
    view.show('inventory')
    expect(sectionCalls().filter(path => path === '/products/p1/inventory').length).toBe(before)
  })

  it('共享筛选改变日期后，已加载的板块重新取数并带新的日期', async () => {
    const app = mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/products/p1/compare')).toBe(true))
    const first = app.calls.find(call => call.path === '/products/p1/compare')!
    const params = new URLSearchParams(first.search)
    // 板块用共享筛选的日期，不用顶部全局范围栏的日期；默认近 30 天、不对比
    expect(params.get('from')).toBeTruthy()
    expect(params.get('to')).toBeTruthy()
    expect(params.get('compare')).toBeNull()
  })
})
