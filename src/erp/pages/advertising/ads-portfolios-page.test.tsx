import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { detailHandlers, detailResponse, emptyList, listHandlers, listResponse, portfolioRow } from './ads-portfolios-fixtures.test-helper'
import { paceChartOption } from './ads-portfolios-options'

// 广告组合与预算页（P3-11）：假服务端返回固定数据，验证预算上限与周期、已用金额、节奏标签（偏快、偏慢、算不出时写原因而不是 0）、
// 非美元不折算、汇总、写亚马逊的动作禁用并说明原因、筛选排序翻页、空状态与读取失败；详情的调整建议、活动预算分配、预算规则（功能开关）。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsPortfoliosPage: { load: () => import('./AdsPortfoliosPage') },
  AdsPortfolioDetailPage: { load: () => import('./AdsPortfolioDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/portfolios'
const detailUrl = '/app/advertising/portfolios/pf-1'
const rowOf = async (page: HTMLElement, name: string) => (await within(page).findByText(name)).closest('tr, [role=row]') as HTMLElement

describe('广告组合列表', () => {
  it('有数据：预算上限与周期、已用金额与占比、理想累计与节奏比、活动数、范围内指标', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-portfolios-page')
    const first = await rowOf(page, '春季组合')
    expect(first).toHaveTextContent('$300.00')
    expect(first).toHaveTextContent('指定日期范围 2026-10-14 至 2026-11-12')
    expect(first).toHaveTextContent('$135.00')
    expect(first).toHaveTextContent('占上限 45.0%')
    expect(first).toHaveTextContent('花得偏快')
    expect(first).toHaveTextContent('理想 $90.00')
    expect(first).toHaveTextContent('节奏比 150.0%')
    expect(first).toHaveTextContent('已过 9 / 30 天')
    expect(first).toHaveTextContent('1 / 2')
    expect(first).toHaveTextContent('25.0%')
    expect(first).toHaveTextContent('4.00')
    expect(within(first).getByRole('link', { name: '春季组合' })).toHaveAttribute('href', '/app/advertising/portfolios/pf-1')
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-23 至 2026-10-22/)).toBeInTheDocument()
  })

  it('偏慢；没有预算上限与周期未知写原因，不写 0%；非美元的指标不折算', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-portfolios-page')
    expect(await rowOf(page, '夏季组合')).toHaveTextContent('花得偏慢')
    const none = await rowOf(page, '无预算组合')
    expect(none).toHaveTextContent('未设预算上限')
    expect(none).toHaveTextContent('未绑定店铺')
    expect(none).not.toHaveTextContent('%')
    expect(within(none).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(4)
    const cad = await rowOf(page, '加元组合')
    expect(cad).toHaveTextContent('非美元不计算')
    expect(cad).toHaveTextContent('周期未知')
    expect(within(cad).getAllByText('非美元不折算').length).toBeGreaterThanOrEqual(4)
  })

  it('汇总条：组合数、设了预算的个数、偏快正常偏慢各几个、预算上限与已用合计', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse()) })
    const summary = await screen.findByTestId('ads-portfolios-summary')
    expect(summary).toHaveTextContent('组合 4 个，设了预算 3 个')
    expect(summary).toHaveTextContent('偏快 1 个，正常 0 个，偏慢 1 个')
    expect(summary).toHaveTextContent('预算上限合计 $600.00')
    expect(summary).toHaveTextContent('已用 $180.00')
  })

  it('新建组合与修改预算上限禁用（本包未提供组合写入）；口径说明常驻页面底部', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-portfolios-page')
    await rowOf(page, '春季组合')
    for (const name of ['新建组合', '修改预算上限']) expect(within(page).getByRole('button', { name })).toBeDisabled()
    expect(screen.getByTestId('ads-portfolios-basis')).toHaveTextContent('节奏比 = 实际累计 ÷ 理想累计')
  })

  it('筛选与排序随请求带出，并回到第一页', async () => {
    const app = mountApp({ url, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-portfolios-page')
    await rowOf(page, '春季组合')
    const first = app.calls.find(call => call.path === '/ads/portfolios')!
    expect(new URLSearchParams(first.search).get('sort')).toBe('spend:desc')
    fireEvent.click(within(page).getByRole('button', { name: '排序方向' }))
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('sort') === 'spend:asc')).toBe(true))
    const search = within(page).getByRole('searchbox', { name: '搜索组合名称' })
    fireEvent.change(search, { target: { value: '春季' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('q') === '春季')).toBe(true))
  })

  it('翻页：有下一页时下一页可点，带着游标重新请求，上一页回到第一页', async () => {
    const app = mountApp({
      url,
      pages,
      handlers: listHandlers(requestUrl =>
        requestUrl.searchParams.get('cursor')
          ? listResponse({ items: [portfolioRow({ id: 'pf-9', name: '第二页组合' })], pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 5 } })
          : listResponse({ pageInfo: { pageSize: 20, nextCursor: 'cursor-2', hasMore: true, approxTotal: 5 } }),
      ),
    })
    const page = await screen.findByTestId('ads-portfolios-page')
    await rowOf(page, '春季组合')
    fireEvent.click(within(page).getByRole('button', { name: /下一页/ }))
    expect(await within(page).findByText('第二页组合')).toBeInTheDocument()
    expect(app.calls.some(call => new URLSearchParams(call.search).get('cursor') === 'cursor-2')).toBe(true)
    fireEvent.click(within(page).getByRole('button', { name: /上一页/ }))
    expect(await within(page).findByText('春季组合')).toBeInTheDocument()
  })

  it('还没有同步广告组合：写明原因，不画示例行，没有汇总条', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => emptyList()) })
    expect(await screen.findByText(/还没有同步到广告组合/)).toBeInTheDocument()
    expect(screen.queryByText('春季组合')).toBeNull()
    expect(screen.queryByTestId('ads-portfolios-summary')).toBeNull()
  })

  it('筛选后没有结果：提示放宽条件', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => emptyList({ state: 'NO_DATA', note: '没有符合筛选条件的广告组合' })) })
    expect(await screen.findByTestId('ads-portfolios-page')).toBeInTheDocument()
    expect((await screen.findAllByText(/没有符合筛选条件的广告组合/)).length).toBeGreaterThan(0)
  })

  it('读取上限：如实提示', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ truncated: true, metricsTruncated: true })) })
    expect(await screen.findByText(/超过读取上限，只处理了一部分/)).toBeInTheDocument()
    expect(screen.getByText(/报表分组超过读取上限/)).toBeInTheDocument()
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { '/ads/portfolios': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('ads-portfolios-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('春季组合')).toBeNull()
  }, 30_000)
})

describe('广告组合详情', () => {
  it('身份区：名称、状态、预算上限、已用金额、理想累计、节奏比、周期进度、节奏标签；修改预算上限禁用', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers() })
    const page = await screen.findByTestId('ads-portfolio-detail')
    expect(await within(page).findByText('春季组合')).toBeInTheDocument()
    expect(page).toHaveTextContent('启用中')
    expect(page).toHaveTextContent('$300.00')
    expect(page).toHaveTextContent('$135.00')
    expect(page).toHaveTextContent('$90.00')
    expect(page).toHaveTextContent('150.0%')
    expect(page).toHaveTextContent('9 / 30 天')
    expect(page).toHaveTextContent('花得偏快')
    expect(page).toHaveTextContent('预算周期：指定日期范围（2026-10-14 至 2026-11-12）')
    expect(within(page).getByRole('button', { name: '修改预算上限' })).toBeDisabled()
  })

  it('预算节奏页签：调整建议与数字、口径说明、图表', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers() })
    const page = await screen.findByTestId('ads-portfolio-detail')
    const advice = await within(page).findByTestId('portfolio-advice')
    expect(advice).toHaveTextContent('实际花费比理想节奏快 50%')
    expect(advice).toHaveTextContent('剩余 21 天')
    expect(advice).toHaveTextContent('剩余预算 $165.00')
    expect(advice).toHaveTextContent('预计 2026-11-03 前后用完')
    expect(within(advice).getByRole('button', { name: '按建议调整日预算' })).toBeDisabled()
    expect(within(page).getByRole('img', { name: '预算节奏：理想累计与实际累计' })).toBeInTheDocument()
    expect(within(page).getByTestId('portfolio-basis')).toHaveTextContent('节奏比 = 实际累计 ÷ 理想累计')
  })

  it('没有建议时写原因；没有预算周期时不画图并写原因', async () => {
    const row = portfolioRow({
      budget: { cap: 300, kind: 'UNKNOWN', from: null, to: null, issue: '没有同步到预算周期，无法计算节奏' },
      pace: {
        state: 'UNKNOWN_PERIOD',
        note: '没有同步到预算周期，无法计算节奏',
        verdict: null,
        elapsedDays: 0,
        totalDays: null,
        idealSpent: null,
        spent: 0,
        ratio: null,
        shape: null,
        capReached: false,
      },
    })
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse({ row, curve: [], advice: null, adviceNote: '没有同步到预算周期，无法计算节奏' })) })
    const page = await screen.findByTestId('ads-portfolio-detail')
    expect((await within(page).findAllByText('没有同步到预算周期，无法计算节奏')).length).toBeGreaterThanOrEqual(2)
    expect(within(page).queryByRole('img', { name: /预算节奏/ })).toBeNull()
    expect(page).not.toHaveTextContent('0.0%')
  })

  it('没有逐日花费时实际线不画并说明（不是 0）', async () => {
    const curve = detailResponse().curve.map(point => ({ ...point, actual: null, daily: null }))
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse({ curve, row: portfolioRow({ spentSource: 'PORTFOLIO' }) })) })
    const page = await screen.findByTestId('ads-portfolio-detail')
    expect(await within(page).findByText(/实际累计线没有画（不是 0）/)).toBeInTheDocument()
    expect(within(page).getByText(/已用金额来自亚马逊同步/)).toBeInTheDocument()
  })

  it('活动预算分配页签：活动链接、日预算与占比、花费与占比、没有汇总写“尚无记录”、统计区间说明', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers() })
    const page = await screen.findByTestId('ads-portfolio-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '活动预算分配' }))
    const first = (await within(page).findByText('春季推广')).closest('tr, [role=row]') as HTMLElement
    expect(within(first).getByRole('link', { name: '春季推广' })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
    expect(first).toHaveTextContent('$50.00')
    expect(first).toHaveTextContent('100.0%')
    expect(first).toHaveTextContent('$90.00')
    expect(first).toHaveTextContent('66.7%')
    const paused = (await within(page).findByText('春季暂停')).closest('tr, [role=row]') as HTMLElement
    expect(paused).toHaveTextContent('已暂停')
    const blank = (await within(page).findByText('没有汇总的活动')).closest('tr, [role=row]') as HTMLElement
    expect(within(blank).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(4)
    expect(within(page).getByTestId('allocation-period')).toHaveTextContent('2026-10-14 至 2026-10-22（预算周期内，截至昨天）')
  })

  it('预算规则页签：功能开关关闭时只说明；打开后列出规则与参数，写入动作禁用', async () => {
    const app = mountApp({ url: detailUrl, pages, handlers: detailHandlers() })
    const page = await screen.findByTestId('ads-portfolio-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: /预算规则/ }))
    const state = await within(page).findByTestId('rules-state')
    expect(state).toHaveTextContent('功能开关未打开')
    expect(state).toHaveTextContent('测试版')
    expect(within(page).getByRole('button', { name: '新增预算规则' })).toBeDisabled()
    expect(app.calls.some(call => call.path === '/ads/portfolios/pf-1')).toBe(true)
  })

  it('预算规则打开后：规则按活动列出，参数原样显示', async () => {
    const rules = {
      state: 'OK' as const,
      note: null,
      flag: 'ADS_BUDGET_RULES_BETA' as const,
      items: [{ id: 'rule-1', campaignId: 'c1', campaignName: '春季推广', ruleType: 'SCHEDULE', status: 'ACTIVE', params: [{ key: 'name', value: '黑五' }], syncedAt: '2026-10-22T08:00:00.000Z' }],
    }
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse({ rules })) })
    const page = await screen.findByTestId('ads-portfolio-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: /预算规则/ }))
    const row = (await within(page).findByText('SCHEDULE')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('春季推广')
    expect(row).toHaveTextContent('name：黑五')
    expect(within(page).getByTestId('rules-state')).not.toHaveTextContent('功能开关未打开')
  })

  it('不存在或不在范围内：显示读取失败，不显示示例数据', async () => {
    mountApp({ url: detailUrl, pages, handlers: { '/ads/portfolios/pf-1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '广告组合不存在' } } }) } })
    expect((await screen.findAllByText(/广告组合不存在|不存在/)).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('ads-portfolio-detail')).toBeNull()
  })
})

describe('预算节奏图配置', () => {
  it('理想线与实际线用 null 断开（不画成 0）；有预算上限画上限线，有今天画今天线', () => {
    const curve = detailResponse().curve
    const option = paceChartOption(curve, 300, '2026-10-23')
    const series = option.series as Array<{ name: string; data: Array<number | null>; markLine?: unknown }>
    expect(series.map(item => item.name)).toEqual(['理想累计', '实际累计'])
    expect(series[1].data.slice(0, 9).every(value => value !== null)).toBe(true)
    expect(series[1].data.slice(9).every(value => value === null)).toBe(true)
    expect(series[0].markLine).toBeDefined()
    expect(series[1].markLine).toBeDefined()
    const noCap = paceChartOption(
      curve.map(point => ({ ...point, ideal: null })),
      null,
      '2030-01-01',
    )
    const noCapSeries = noCap.series as Array<{ data: Array<number | null>; markLine?: unknown }>
    expect(noCapSeries[0].data.every(value => value === null)).toBe(true)
    expect(noCapSeries[0].markLine).toBeUndefined()
    expect(noCapSeries[1].markLine).toBeUndefined()
  })
})
