import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AwdSimulation, TrendSimulation } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { NO_VIEWS, rowText } from '../inventory/inventory-fixtures.test-helper'
import { stockoutText, trendOption } from './simulation-chart'
import { ok, recommendations, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 模拟抽屉（P2a-07）：90 天库存趋势、上游仓储（AWD）经济模拟的排队/完成/失败/无结果。

const pages: LivePages = { ReplenishmentPage: { load: () => import('./ReplenishmentPage') } }

const points: TrendSimulation['points'] = [
  { day: 0, date: '2026-10-22', none: 200, recommended: 200, custom: null },
  { day: 1, date: '2026-10-23', none: -20, recommended: 190, custom: null },
]
const trend = (over: Partial<TrendSimulation> = {}): TrendSimulation => ({
  kind: 'TREND',
  state: 'OK',
  note: null,
  points,
  stockouts: { none: [{ from: '2026-11-03', to: '2026-11-20', days: 18, shortage: 180 }], recommended: [], custom: [] },
  assumptions: ['在途数量按 14 天后一次性到仓'],
  dailyDemand: 10,
  ...over,
})
const awd = (over: Partial<AwdSimulation> = {}): AwdSimulation => ({
  kind: 'AWD',
  runId: 'run1',
  status: 'PENDING',
  note: null,
  input: { quantity: 440, startDate: '2026-10-22', endDate: '2026-11-21', sku: 'SKU-A' },
  result: null,
  ...over,
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }),
  '/grid-views': () => ok(NO_VIEWS),
  '/replenishment/batches': () => ok({ items: [summary()], page: 1, pageSize: 20, total: 1 }),
  '/replenishment/recommendations': () => ok(recommendations()),
  ...over,
})

const openDrawer = async () => {
  await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
  await userEvent.click(screen.getAllByRole('button', { name: '模拟' })[0])
  return screen.findByRole('dialog', { name: /模拟：SKU-A/ })
}

describe('simulation-chart', () => {
  it('没有补货与自定义数据时只画“不补货”一条', () => {
    const option = trendOption([{ day: 0, date: '2026-10-22', none: 5, recommended: null, custom: null }])
    expect((option.series as Array<{ name: string }>).map(item => item.name)).toEqual(['不补货'])
  })
  it('三条曲线都有数据时都画，数据按日期顺序', () => {
    const option = trendOption(points.map(point => ({ ...point, custom: 1 })))
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.map(item => item.name)).toEqual(['不补货', '按建议补货', '自定义补货'])
    expect(series[0].data).toEqual([200, -20])
  })
  it('断货区间一句话：起止、天数、缺口', () => {
    expect(stockoutText({ from: '2026-11-03', to: '2026-11-20', days: 18, shortage: 1800 })).toBe('2026-11-03 至 2026-11-20，断货 18 天，缺口约 1,800 件')
  })
})

describe('模拟抽屉', () => {
  it('打开即按默认假设模拟：画图、列出断货区间与假设', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/simulate': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: trend() } }
        },
      }),
    })
    const drawer = await openDrawer()
    const stockouts = await within(drawer).findByTestId('stockouts')
    expect(within(stockouts).getByText(/不补货：/)).toBeInTheDocument()
    expect(within(stockouts).getByText('2026-11-03 至 2026-11-20，断货 18 天，缺口约 180 件')).toBeInTheDocument()
    expect(within(stockouts).getByText('按建议补货：90 天内不断货')).toBeInTheDocument()
    expect(within(drawer).getByText('在途数量按 14 天后一次性到仓')).toBeInTheDocument()
    expect(within(drawer).getByRole('img', { name: /未来 90 天库存趋势/ })).toBeInTheDocument()
    expect(body).toMatchObject({ kind: 'TREND', sellerAccountId: 'st1', sku: 'SKU-A', inboundArrivalDays: 14 })
  })

  it('缺少销量或库存：写明无法模拟的原因，不画图', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({ '/replenishment/simulate': () => ({ status: 201, body: { success: true, data: trend({ state: 'NO_DATA', note: '该 SKU 没有销量记录', points: [] }) } }) }),
    })
    const drawer = await openDrawer()
    expect(await within(drawer).findByText('无法模拟')).toBeInTheDocument()
    expect(within(drawer).getByText('该 SKU 没有销量记录')).toBeInTheDocument()
    expect(within(drawer).queryByTestId('stockouts')).not.toBeInTheDocument()
  })

  it('上游仓储模拟：先排队，轮询到完成后展示官方估算', async () => {
    let polls = 0
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/simulate': (_url, init) => ({ status: 201, body: { success: true, data: JSON.parse(String(init?.body)).kind === 'AWD' ? awd() : trend() } }),
        '/replenishment/simulations/run1': () => {
          polls += 1
          return ok(awd({ status: 'DONE', result: { currency: 'USD', sales: 12000, fees: 1800, netProceeds: 7400, rows: 3 } }))
        },
      }),
    })
    const drawer = await openDrawer()
    await userEvent.click(within(drawer).getByRole('tab', { name: '上游仓储模拟' }))
    await userEvent.click(await within(drawer).findByRole('button', { name: '发起模拟' }))
    const result = await within(drawer).findByTestId('awd-result')
    expect(within(result).getByText('$12,000.00')).toBeInTheDocument()
    expect(within(result).getByText('$7,400.00')).toBeInTheDocument()
    expect(within(drawer).getByText(/模拟区间：2026-10-22 至 2026-11-21，发往上游仓储 440 件/)).toBeInTheDocument()
    expect(polls).toBeGreaterThanOrEqual(1)
  })

  it('上游仓储模拟失败：显示失败原因', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/simulate': (_url, init) => ({ status: 201, body: { success: true, data: JSON.parse(String(init?.body)).kind === 'AWD' ? awd() : trend() } }),
        '/replenishment/simulations/run1': () => ok(awd({ status: 'FAILED', note: '缺少“卖家洞察”角色，亚马逊拒绝了查询' })),
      }),
    })
    const drawer = await openDrawer()
    await userEvent.click(within(drawer).getByRole('tab', { name: '上游仓储模拟' }))
    await userEvent.click(await within(drawer).findByRole('button', { name: '发起模拟' }))
    expect(await within(drawer).findByText('模拟失败')).toBeInTheDocument()
    expect(within(drawer).getByText('缺少“卖家洞察”角色，亚马逊拒绝了查询')).toBeInTheDocument()
  })

  it('上游仓储模拟返回 0 行：说明没有结果，不显示数字卡片', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/simulate': (_url, init) => ({ status: 201, body: { success: true, data: JSON.parse(String(init?.body)).kind === 'AWD' ? awd() : trend() } }),
        '/replenishment/simulations/run1': () =>
          ok(awd({ status: 'DONE', note: '亚马逊没有返回数据：该 SKU 可能没有资格使用上游仓储', result: { currency: null, sales: null, fees: null, netProceeds: null, rows: 0 } })),
      }),
    })
    const drawer = await openDrawer()
    await userEvent.click(within(drawer).getByRole('tab', { name: '上游仓储模拟' }))
    await userEvent.click(await within(drawer).findByRole('button', { name: '发起模拟' }))
    expect(await within(drawer).findByText('没有结果')).toBeInTheDocument()
    await waitFor(() => expect(within(drawer).queryByTestId('awd-result')).not.toBeInTheDocument())
  })
})
