import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { rowTextById, rowTextOf } from '../../test/grid-rows'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './fee-fixtures.test-helper'
import { buildSalesTaxTrendOption } from './sales-tax-options'
import { emptySalesTax, salesTax } from './sales-tax-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 销售税页（P2b-12）：各店铺取得情况（待生成、未授权、失败各有说法）、按州汇总与辖区展开、数据来源（发货报告尚未接入）、
// 与订单对账（一致、有差异、一边没有）、没有数据的写法（不出现拿 0 冒充的金额）、加载失败可重试。

const pages: LivePages = { SalesTaxPage: { load: () => import('./SalesTaxPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/sales-tax': () => ok(salesTax()),
  ...over,
})
const PAGE = '/app/finance/sales-tax'

describe('展示', () => {
  it('按州从高到低，带占比与应税销售额；报告没给应税销售额的州写“尚无记录”；展开看辖区', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const states = await screen.findByTestId('sales-tax-states', {}, { timeout: 15000 })
    const waText = rowTextOf(within(states).getByText('WA'))
    expect(waText).toContain('$150.00')
    expect(waText).toContain('71.4%')
    expect(waText).toContain('$1,000.00')
    const caText = rowTextOf(within(states).getByText('CA'))
    expect(caText).toContain('28.6%')
    expect(caText).toContain('尚无记录')
    await userEvent.click(within(states).getAllByRole('button', { name: /展开/ })[0]!)
    expect(await within(states).findByText('KING COUNTY')).toBeInTheDocument()
    expect(within(states).getByText('州一级（报告没写辖区）')).toBeInTheDocument()
    expect(screen.getByTestId('sales-tax-totals')).toHaveTextContent('$210.00')
    expect(screen.getByTestId('sales-tax-totals')).toHaveTextContent('$205.02')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /每月销售税合计/ })).toBeInTheDocument()
  })

  it('店铺取得情况：未授权写“需申请受限角色”，已取得的店铺列出最近成功时间', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const stores = await screen.findByTestId('sales-tax-stores', {}, { timeout: 15000 })
    expect(stores).toHaveTextContent('美国二店')
    expect(stores).toHaveTextContent('未授权：需申请')
    expect(stores).toHaveTextContent('已取得报告的店铺：美国主店')
    expect(within(stores).queryByText(/美国主店：/)).not.toBeInTheDocument()
  })

  it('数据来源：发货报告写“尚未接入”，没有金额；订单接口只用于对账', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const sources = await screen.findByTestId('sales-tax-sources', {}, { timeout: 15000 })
    const shipment = rowTextOf(within(sources).getByText('发货报告'))
    expect(shipment).toContain('尚未接入')
    expect(shipment).toContain('尚无记录')
    expect(rowTextOf(within(sources).getByText('订单接口'))).toContain('$205.02')
  })

  it('对账：一致、有差异、一边没有记录各自标明；没有记录的一边不显示 0，差额写“无法比较”', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const recon = await screen.findByTestId('sales-tax-recon', {}, { timeout: 15000 })
    const rows = Array.from(new Set(Array.from(recon.querySelectorAll('[row-id]')).map(element => element.getAttribute('row-id') ?? ''))).map(rowTextById)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('一致')
    expect(rows[0]).toContain('-0.02')
    expect(rows[1]).toContain('订单里没有税额记录')
    expect(rows[1]).toContain('无法比较')
    expect(rows[1]).not.toContain('$0.00')
    expect(rows[2]).toContain('有差异')
    expect(rows[2]).toContain('-30.00')
    expect(screen.getByTestId('sales-tax-basis')).toHaveTextContent('订单接口不含收货州')
    expect(screen.getByTestId('sales-tax-range')).toHaveTextContent('2026-09-01')
  })

  it('范围被收窄或用了默认范围时在统计范围里说明；辖区被截断时提示', { timeout: 30000 }, async () => {
    const data = salesTax({ range: { from: '2025-09-01', to: '2026-10-15', defaulted: true, clamped: true }, jurisdictionsTruncated: true })
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/sales-tax': () => ok(data) }) })
    const range = await screen.findByTestId('sales-tax-range', {}, { timeout: 15000 })
    expect(range).toHaveTextContent('默认最近 90 天')
    expect(range).toHaveTextContent('只显示最近 14 个月')
    expect(screen.getByTestId('sales-tax-truncated')).toHaveTextContent('合计是完整的')
  })
})

describe('没有数据与失败', () => {
  it('没有任何数据：写明“需在卖家后台税务文档库先生成报告”，各来源写没有数据，页面上没有任何金额冒充', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/sales-tax': () => ok(emptySalesTax()) }) })
    expect(await screen.findByTestId('sales-tax-empty', {}, { timeout: 15000 })).toHaveTextContent('税务文档库')
    expect(screen.getByTestId('sales-tax-stores')).toHaveTextContent('需在卖家后台')
    expect(screen.getByTestId('sales-tax-totals')).toHaveTextContent('尚无记录')
    expect(screen.getByTestId('sales-tax-sources')).toHaveTextContent('范围内无数据')
    expect(screen.getByTestId('sales-tax-states')).toHaveTextContent('税务文档库')
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('加载失败：显示错误并可重试', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/sales-tax': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })

  it('没有权限：提示缺少 finance.tax.read', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['finance.read']) })
    expect(await screen.findByText(/没有权限|无权/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('趋势图配置', () => {
  it('每月两根柱；没有记录的一边是空（null），不是 0', () => {
    const option = buildSalesTaxTrendOption([
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: 40, ordersTax: null },
      { month: '2026-10', from: '2026-10-01', to: '2026-10-31', reportTax: null, ordersTax: 5 },
    ])
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.map(item => item.name)).toEqual(['税务文档库报告', '订单接口'])
    expect(series[0]!.data).toEqual([40, null])
    expect(series[1]!.data).toEqual([null, 5])
  })
})
