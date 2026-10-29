import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 商品表现宽表（P6-22）：每个指标显示本期、上期与涨跌；汇总行来自服务端；没有权限的列不出现并说明原因；没有来源的指标不显示成 0。

const pages: LivePages = { ProductPerformancePage: { load: () => import('./ProductPerformancePage') } }
afterEach(() => vi.unstubAllGlobals())

const ok = (data: unknown) => ({ body: { success: true, data } })
const cell = (value: number | null, previous: number | null, change: number | null) => ({ value, previous, change })
const freshness = { lastSuccessAt: '2026-10-22T01:00:00.000Z', sources: ['销售与流量'], qualityIssues: 0 }
const base = { freshness, note: null, compare: null, truncated: false, gaps: {} }
const ALL = ['units', 'orders', 'sales', 'netSales', 'avgPrice', 'sessions', 'pageViews', 'conversion', 'buyBox']
const row = {
  id: 'asin:B0ABC12345',
  dimension: 'asin',
  title: '无线鼠标',
  subtitle: null,
  imageUrl: null,
  asin: 'B0ABC12345',
  sku: null,
  storeName: '美国站',
  hasChildren: false,
  childCount: 0,
  metrics: { sales: cell(1200, 1000, 0.2), units: cell(30, 40, -0.25) },
  gaps: {},
}
const query = (over: Record<string, unknown> = {}) => ({ ...base, dimension: 'asin', allowed: ALL, restrictions: [], items: [row], total: 1, page: 1, pageSize: 50, ...over })
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['analytics.read']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/analytics/product-performance/query': () => ok(query()),
  '/analytics/product-performance/summary': () => ok({ ...base, totals: { sales: 1200, units: 30 }, currency: 'USD' }),
  '/analytics/product-performance/async-columns': () => ok({ rows: {}, gaps: {}, truncated: false }),
  '/analytics/product-performance/trend': () => ok({ metric: 'sales', days: [], rows: {}, truncated: false }),
  ...over,
})

describe('商品表现宽表', () => {
  it('显示商品行与服务端合计，并发出查询请求', async () => {
    const app = mountApp({ url: '/app/analytics/product-performance', pages, handlers: handlers() })
    expect(await screen.findByText('无线鼠标', {}, { timeout: 15000 })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('.ag-row-pinned').length).toBeGreaterThan(0))
    expect(app.calls.some(call => call.path === '/analytics/product-performance/query')).toBe(true)
    expect(app.calls.some(call => call.path === '/analytics/product-performance/summary')).toBe(true)
  }, 30000)

  it('权限降级：服务端说明哪些列因权限没有显示', async () => {
    const restrictions = [{ group: 'profit', metrics: ['grossProfit', 'margin'], reason: '没有利润读取权限' }]
    mountApp({ url: '/app/analytics/product-performance', pages, handlers: handlers({ '/analytics/product-performance/query': () => ok(query({ restrictions })) }) })
    const note = await screen.findByTestId('pp-restrictions', {}, { timeout: 15000 })
    expect(note).toHaveTextContent('没有利润读取权限')
    expect(screen.queryByText('毛利')).toBeNull()
  }, 30000)

  it('没有来源的指标如实说明“尚未接入”，不是 0', async () => {
    const gaps = { cpc: 'CPC 尚未接入' }
    mountApp({ url: '/app/analytics/product-performance', pages, handlers: handlers({ '/analytics/product-performance/query': () => ok(query({ gaps, allowed: [...ALL, 'cpc'] })) }) })
    expect(await screen.findByTestId('pp-gaps', {}, { timeout: 15000 })).toHaveTextContent('尚未接入')
  }, 30000)

  it('数据被截断时提示缩小范围', async () => {
    mountApp({ url: '/app/analytics/product-performance', pages, handlers: handlers({ '/analytics/product-performance/query': () => ok(query({ truncated: true })) }) })
    expect(await screen.findByText('范围内商品或利润记录过多，只统计了前面的部分', {}, { timeout: 15000 })).toBeInTheDocument()
  }, 30000)
})
