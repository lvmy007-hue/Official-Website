import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { liveToday, noDataToday, notConnectedToday, todayHandlers } from './ads-today-fixtures.test-helper'
import { buildHourlyOption, hourLabels } from './ads-today-options'

// 今日广告（P3-06）：假服务端返回固定数据，验证“未接入”正式展示并退化到日报表、没有数据时不出现 0 或示例图、各区域如实展示与读取失败。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsTodayPage: { load: () => import('./AdsTodayPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/today'
const page = () => screen.findByTestId('ads-today-page')

describe('今日广告', () => {
  it('数据流未接入：横幅写“未接入”，退化展示最近一天日报表，没有图表也没有 0', async () => {
    mountApp({ url, pages, handlers: todayHandlers(() => notConnectedToday()) })
    await page()
    expect(await screen.findByTestId('ads-today-stream-banner')).toHaveTextContent('营销数据流未接入')
    expect(screen.getByTestId('ads-today-update-note')).toHaveTextContent('转化')
    expect(screen.getByTestId('ads-today-totals')).toHaveTextContent('数据流未接入')
    const fallback = screen.getByTestId('ads-today-fallback')
    expect(fallback).toHaveTextContent('2026-10-22')
    expect(fallback).toHaveTextContent('$321.50')
    expect(fallback).toHaveTextContent('不是今天的数据')
    expect(screen.getByTestId('ads-today-hourly-empty')).toHaveTextContent('尚未接入')
    for (const id of ['ads-today-budget', 'ads-today-out-of-budget', 'ads-today-anomalies', 'ads-today-stockout']) expect(screen.getByTestId(id)).toHaveTextContent('尚未接入')
    expect(screen.queryByLabelText('今日小时花费与点击')).toBeNull()
    expect(screen.queryByText(/^\$?0(\.0+)?$/)).toBeNull()
  })

  it('接收端已配置但今天没有小时指标：写“尚无记录”，不写 0', async () => {
    mountApp({ url, pages, handlers: todayHandlers(() => noDataToday()) })
    expect(await screen.findByTestId('ads-today-stream-banner')).toHaveTextContent('今天还没有收到小时指标')
    expect(screen.getByTestId('ads-today-totals')).toHaveTextContent('尚无记录')
    expect(screen.queryByTestId('ads-today-fallback')).toBeNull()
    expect(screen.queryByLabelText('今日小时花费与点击')).toBeNull()
  })

  it('有数据：指标、昨日同时段、曲线、预算、超预算、异常与断货都出现', async () => {
    mountApp({ url, pages, handlers: todayHandlers(() => liveToday()) })
    const totals = await screen.findByTestId('ads-today-totals')
    expect(totals).toHaveTextContent('$18.00')
    expect(totals).toHaveTextContent('昨日同时段 $15.00')
    expect(totals).toHaveTextContent('转化数据滞后')
    expect(screen.queryByTestId('ads-today-stream-banner')).toBeNull()
    expect(await screen.findByLabelText('今日小时花费与点击')).toBeInTheDocument()
    const budget = screen.getByTestId('ads-today-budget')
    expect(budget).toHaveTextContent('日预算合计 $70.00')
    expect(budget).toHaveTextContent('核心词活动')
    expect(budget).toHaveTextContent('估算')
    expect(budget).toHaveTextContent('今天还没有花费')
    expect(screen.getByTestId('ads-today-out-of-budget')).toHaveTextContent('预算用完活动')
    const anomalies = screen.getByTestId('ads-today-anomalies')
    expect(anomalies).toHaveTextContent('单次点击成本突增')
    expect(anomalies).toHaveTextContent('无转化活动')
    expect(anomalies).toHaveTextContent('规则（自定默认值）')
    const stockout = screen.getByTestId('ads-today-stockout')
    expect(stockout).toHaveTextContent('B0AAA')
    expect(stockout).toHaveTextContent('美国店')
    expect(stockout).toHaveTextContent('库存是日级快照')
  })

  it('没有活动命中规则或没有断货：写明结论，不写 0', async () => {
    const empty = liveToday()
    mountApp({
      url,
      pages,
      handlers: todayHandlers(() =>
        liveToday({
          anomalies: { ...empty.anomalies, count: 0, items: [] },
          stockout: { ...empty.stockout, items: [] },
          outOfBudget: { ...empty.outOfBudget, count: 0, rows: [] },
        }),
      ),
    })
    await screen.findByTestId('ads-today-totals')
    expect(screen.getByTestId('ads-today-anomalies')).toHaveTextContent('今天还没有活动命中规则')
    expect(screen.getByTestId('ads-today-stockout')).toHaveTextContent('最近一次库存快照里都还有货')
    expect(screen.getByTestId('ads-today-out-of-budget')).toHaveTextContent('没有投放状态为“预算用完”')
  })

  it('其他币种与活动截断都如实提示', async () => {
    mountApp({ url, pages, handlers: todayHandlers(() => liveToday({ otherCurrencies: [{ currency: 'GBP', spend: 12.5 }], truncated: true })) })
    expect(await screen.findByTestId('ads-today-other-currencies')).toHaveTextContent('GBP：12.50')
    expect(screen.getByTestId('ads-today-truncated')).toBeInTheDocument()
  })

  it('范围参数随请求带出，刷新会重新读取', async () => {
    const app = mountApp({ url: `${url}?storeIds=st2`, pages, handlers: todayHandlers(() => liveToday()) })
    await screen.findByTestId('ads-today-totals')
    const first = app.calls.find(call => call.path === '/ads/today')!
    expect(new URLSearchParams(first.search).get('storeIds')).toBe('st2')
    const before = app.calls.filter(call => call.path === '/ads/today').length
    fireEvent.click(within(screen.getByTestId('ads-today-page')).getByRole('button', { name: /刷\s*新/ }))
    await vi.waitFor(() => expect(app.calls.filter(call => call.path === '/ads/today').length).toBeGreaterThan(before))
  })

  it('读取失败：显示错误与重试，不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { '/ads/today': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await page()
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('ads-today-totals')).toBeNull()
  }, 30_000)
})

describe('今日小时曲线配置', () => {
  it('小时标签按 0–23 编号；没有小时指标的小时与未到的小时保持断开，不当 0', () => {
    const items = liveToday().hours.items
    expect(hourLabels(items)).toHaveLength(24)
    expect(hourLabels(items)[0]).toBe('0时')
    const option = buildHourlyOption([{ ...items[0]!, spend: null, clicks: null }, ...items.slice(1)])
    const series = (option.series ?? []) as Array<{ name?: string; data?: Array<number | null> }>
    const spend = series.find(item => item.name === '花费')
    expect(spend?.data?.[0]).toBeNull()
    expect(spend?.data?.[1]).toBe(3)
    expect(spend?.data?.[23]).toBeNull()
  })
})
