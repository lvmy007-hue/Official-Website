import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { Asin360AlertsResponse, Asin360CompareResponse, Asin360CompetitorCompareResponse, ReturnCycleResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// P6-21 新增的四个区块（同环比明细、竞品对比、预警日志、退货周期）：每块都测有数据、没数据、读取失败三种状态。
// jsdom 没有 IntersectionObserver，所有板块直接加载。

const pages: LivePages = { Asin360Page: { load: () => import('./Asin360Page') }, InventoryDetailPage: { load: () => import('../inventory/InventoryDetailPage') } }

const ok = (data: unknown) => ({ body: { success: true, data } })
const fail = () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂不可用' } } })
const PERMISSIONS = ['products.read', 'alerts.read', 'competitors.read', 'returns.read']

const identity = {
  product: {
    id: 'p1',
    sellerAccountId: 's1',
    storeName: '店铺一',
    asin: 'B0TESTASIN',
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
    parentAsin: null,
    ownerUserId: null,
    ownerName: null,
    tags: [],
  },
  catalog: { state: 'OK', syncedAt: '2026-10-22T02:00:00Z', note: null },
  siblings: [{ id: 'p1', sku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' }],
  variants: { parentAsin: null, childCount: null, isParent: false, siblingCount: 1, variationTheme: null },
  ranks: { state: 'NO_DATA', note: null, snapshotDate: null, items: [] },
  stock: { state: 'RESTRICTED', note: null, inventoryId: null, sellable: null, inboundCounted: null, daysOfCover: null, stockoutDate: null, noDemand: false, riskLabel: null },
  freshness: { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['订单'], qualityIssues: 0 },
}
const compare: Asin360CompareResponse = {
  state: 'OK',
  note: null,
  period: { from: '2026-09-29', to: '2026-09-30' },
  compare: { from: '2026-09-27', to: '2026-09-28' },
  currency: 'USD',
  rows: [{ metric: 'sales', label: '销售额', format: 'money', value: 1000, prevValue: 800, changeRate: 0.25, changeValue: 200, state: 'OK', note: null }],
} as unknown as Asin360CompareResponse

const rival = {
  asin: 'B0RIVAL001',
  title: '竞品标题',
  isOwn: false,
  currency: 'USD',
  rankName: null,
  ratingNote: '竞品没有官方评分来源',
  latest: { price: 18.5, rank: 300, rating: null, ratingCount: null, observedAt: null },
  points: [],
}
const competitorCompare = (parties: unknown[]): Asin360CompetitorCompareResponse =>
  ({
    state: parties.length > 0 ? 'OK' : 'NO_DATA',
    note: null,
    range: { from: '2026-09-29', to: '2026-09-30' },
    truncated: false,
    basis: '对比口径说明',
    parties,
  }) as unknown as Asin360CompetitorCompareResponse

const alert = {
  id: 'a1',
  severity: 'WARNING',
  title: '库存覆盖天数偏低',
  ruleName: '库存预警',
  statusLabel: '待处理',
  owner: null,
  triggerCount: 2,
  lastTriggeredAt: '2026-10-20T01:00:00Z',
}
const alerts = (items: unknown[]): Asin360AlertsResponse => ({ state: items.length > 0 ? 'OK' : 'NO_DATA', note: null, items, truncated: false }) as unknown as Asin360AlertsResponse

const cycle = (units: number): ReturnCycleResponse =>
  ({
    range: { from: '2026-09-29', to: '2026-09-30' },
    note: units > 0 ? null : '所选范围内这个商品没有退货记录',
    basis: '周期口径',
    totals: { units, median: units > 0 ? 6 : null },
    unknownOrderRows: 0,
    unknownOrderUnits: 0,
    buckets: units > 0 ? [{ key: 'b1', label: '0-7 天', units, share: 1 }] : [],
  }) as unknown as ReturnCycleResponse

const base = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: PERMISSIONS }),
  '/products/p1': () => ok(identity),
  '/products/p1/compare': () => ok(compare),
  '/products/p1/competitor-compare': () => ok(competitorCompare([{ ...rival, asin: 'B0TESTASIN', isOwn: true, title: '本品' }, rival])),
  '/products/p1/alerts': () => ok(alerts([alert])),
  '/returns/analysis/cycle': () => ok(cycle(5)),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

const mount = (over: Record<string, Handler> = {}) => mountApp({ url: '/app/products/p1', pages, handlers: base(over) })

afterEach(() => document.body.replaceChildren())

describe('同环比明细', () => {
  it('有数据：显示本期、对比期与变化量', async () => {
    mount()
    const block = await screen.findByTestId('asin360-compare')
    expect(block).toHaveTextContent('2026-09-27')
    expect(await within(block).findByText('销售额')).toBeInTheDocument()
  })

  it('读取失败：显示错误，不显示表格', async () => {
    mount({ '/products/p1/compare': fail })
    expect(await screen.findAllByText(/服务暂不可用/, undefined, { timeout: 20_000 })).not.toHaveLength(0)
    expect(screen.queryByTestId('asin360-compare')).not.toBeInTheDocument()
  })

  it('没有行：写明需要订单记录', async () => {
    mount({ '/products/p1/compare': () => ok({ ...compare, state: 'NO_DATA', rows: [] }) })
    const block = await screen.findByTestId('asin360-compare')
    expect(await within(block).findByText(/需要这个商品有订单记录/)).toBeInTheDocument()
  })
})

describe('竞品对比', () => {
  it('有竞品：并列表格列出本品与竞品，竞品评分写原因', async () => {
    mount()
    const block = await screen.findByTestId('asin360-competitor-compare')
    expect(await within(block).findByText('B0RIVAL001')).toBeInTheDocument()
    expect(within(block).getAllByText('竞品没有官方评分来源').length).toBeGreaterThan(0)
  })

  it('没有关注竞品：引导去竞品监控', async () => {
    mount({ '/products/p1/competitor-compare': () => ok({ ...competitorCompare([]), note: '还没有关注竞品' }) })
    const block = await screen.findByTestId('asin360-competitor-compare')
    expect(block).toHaveTextContent('还没有关注竞品')
    expect(within(block).getByText(/去竞品监控添加/)).toBeInTheDocument()
  })

  it('读取失败：显示错误', async () => {
    mount({ '/products/p1/competitor-compare': fail })
    expect(await screen.findAllByText(/服务暂不可用/, undefined, { timeout: 20_000 })).not.toHaveLength(0)
    expect(screen.queryByTestId('asin360-competitor-compare')).not.toBeInTheDocument()
  })
})

describe('预警日志', () => {
  it('有预警：列出本商品相关预警', async () => {
    mount()
    const block = await screen.findByTestId('asin360-alerts')
    expect(await within(block).findByText('库存覆盖天数偏低')).toBeInTheDocument()
  })

  it('没有预警：写明评估节奏', async () => {
    mount({ '/products/p1/alerts': () => ok(alerts([])) })
    const block = await screen.findByTestId('asin360-alerts')
    expect(await within(block).findByText(/每 15 分钟/)).toBeInTheDocument()
  })

  it('读取失败：显示错误', async () => {
    mount({ '/products/p1/alerts': fail })
    expect(await screen.findAllByText(/服务暂不可用/, undefined, { timeout: 20_000 })).not.toHaveLength(0)
    expect(screen.queryByTestId('asin360-alerts')).not.toBeInTheDocument()
  })
})

describe('退货周期', () => {
  it('有退货：带 ASIN 与店铺请求退货分析接口，显示周期分布', async () => {
    const app = mount()
    const block = await screen.findByTestId('asin360-returns-cycle')
    expect(await within(block).findByText('0-7 天')).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/returns/analysis/cycle')!
    const params = new URLSearchParams(call.search)
    expect(params.get('asin')).toBe('B0TESTASIN')
    expect(params.get('storeIds')).toBe('s1')
  })

  it('没有退货：写明原因，不显示 0 天分布', async () => {
    mount({ '/returns/analysis/cycle': () => ok(cycle(0)) })
    const block = await screen.findByTestId('asin360-returns-cycle')
    expect(await within(block).findByText(/没有退货记录/)).toBeInTheDocument()
  })

  it('读取失败：显示错误', async () => {
    mount({ '/returns/analysis/cycle': fail })
    expect(await screen.findAllByText(/服务暂不可用/, undefined, { timeout: 20_000 })).not.toHaveLength(0)
    expect(screen.queryByTestId('asin360-returns-cycle')).not.toBeInTheDocument()
  })
})
