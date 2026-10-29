import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { asinList, byDate, emptySummary, gap, ok, point, summary, trends } from './business-reports-fixtures.test-helper'
import { rowTextById, rowTextOf, occurrences } from '../../test/grid-rows'
import { buildTrendOption, formatMetric } from './business-reports-options'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 业务报告页（P4-02）：销售仪表盘（指标卡与对比期、漏斗、归因、广告拆分、设备拆分尚未接入、各店铺同步情况）、按日期（日、周、对比期）、
// 三个层级的 ASIN 表（搜索、排序方向、翻页、趋势抽屉、跳 ASIN 360）、月度、没有数据与失败的写法。页面上不出现拿 0 冒充的金额。

const pages: LivePages = {
  BusinessReportsPage: { load: () => import('./BusinessReportsPage') },
  Asin360Page: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/analytics/business-reports?from=2026-10-08&to=2026-10-10'
const API = '/analytics/sales-traffic'
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [`${API}/summary`]: () => ok(summary()),
  [`${API}/by-date`]: url => ok(byDate({ granularity: url.searchParams.get('granularity') === 'WEEK' ? 'WEEK' : url.searchParams.get('granularity') === 'MONTH' ? 'MONTH' : 'DAY' })),
  [`${API}/by-asin`]: () => ok(asinList()),
  [`${API}/trends`]: () => ok(trends()),
  ...over,
})
const T = { timeout: 30000 }
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }, { timeout: 15000 }))
const paramsOf = (app: ReturnType<typeof mountApp>, path: string) => app.calls.filter(call => call.path === path).map(call => new URLSearchParams(call.search))

describe('销售仪表盘', () => {
  it('十个指标卡带对比期；金额与件数写变化比率，百分比写个百分点；请求带全局范围', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    const cards = await screen.findAllByTestId('br-card', {}, { timeout: 15000 })
    expect(cards.length).toBeGreaterThanOrEqual(10)
    const sales = cards.find(card => card.textContent?.includes('订购商品销售额'))!
    expect(sales).toHaveTextContent('$1,200.00')
    expect(sales).toHaveTextContent('环比')
    expect(within(sales).getByTestId('br-compare-orderedSales')).toHaveTextContent('对比期 $1,000.00')
    expect(within(sales).getByLabelText('环比：+20.0%')).toBeInTheDocument()
    const sessions = cards.find(card => card.textContent?.includes('会话数'))!
    expect(within(sessions).getByLabelText('环比：-20.0%')).toBeInTheDocument()
    expect(screen.getByTestId('br-points-unitSessionPct')).toHaveTextContent('1.00 个百分点')
    expect(screen.getByTestId('br-coverage')).toHaveTextContent('有数据 2 天')
    expect(screen.getByTestId('br-coverage')).toHaveTextContent('其中 1 天只有报告补充')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '销售与流量逐日趋势图' })).toBeInTheDocument()
    const params = paramsOf(app, `${API}/summary`)[0]!
    expect(params.get('from')).toBe('2026-10-08')
    expect(params.get('to')).toBe('2026-10-10')
  })

  it('漏斗每一环节写相对上一环节的比值；归因给出三个因子；自然销售与广告销售拆分', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const funnel = await screen.findByTestId('br-funnel', {}, { timeout: 15000 })
    await waitFor(() => expect(new Set(Array.from(funnel.querySelectorAll('[row-id]')).map(row => row.getAttribute('row-id'))).size).toBe(4))
    expect(funnel).toHaveTextContent('1.50')
    expect(funnel).toHaveTextContent('1.67%')
    expect(screen.getByTestId('metric-tree')).toHaveTextContent('订购商品销售额：变化归因')
    expect(screen.getByTestId('metric-tree')).toHaveTextContent('转化率')
    const split = screen.getByTestId('br-split')
    expect(split).toHaveTextContent('$300.00')
    expect(split).toHaveTextContent('$900.00')
    expect(split).toHaveTextContent('25.0%')
  })

  it('设备拆分写“尚未接入”；各店铺同步情况：未授权的写明原因', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    expect(await screen.findByTestId('br-device-split', {}, { timeout: 15000 })).toHaveTextContent('尚未接入')
    const stores = screen.getByTestId('br-stores')
    expect(stores).toHaveTextContent('美国主店 · 已同步')
    expect(stores).toHaveTextContent('美国二店 · 未授权')
    expect(stores).toHaveTextContent('未授权：需要品牌分析角色')
    expect(screen.getByTestId('br-basis')).toHaveTextContent('订购口径')
  })

  it('没选日期、读取被截断、广告口径不符时各自提示；没选对比期写原因，不画归因', T, async () => {
    const data = summary({
      range: { from: '2026-09-25', to: '2026-10-24', days: 30, defaulted: true },
      truncated: true,
      compare: null,
      compareTrend: null,
      attribution: null,
      attributionNote: '没有选择对比期，无法做变化归因',
      split: { state: 'MISMATCH', note: '口径不符：广告销售额大于官方订购销售额', adsSales: 5000, organicSales: null, adsShare: null },
    })
    mountApp({ url: '/app/analytics/business-reports', pages, handlers: handlers({ [`${API}/summary`]: () => ok(data) }) })
    expect(await screen.findByTestId('br-defaulted', {}, { timeout: 15000 })).toHaveTextContent('2026-09-25 至 2026-10-24（30 天）')
    expect(screen.getByTestId('br-truncated')).toHaveTextContent('读取上限')
    expect(screen.getByTestId('br-attribution-empty')).toHaveTextContent('没有选择对比期')
    expect(screen.getByTestId('br-split-note')).toHaveTextContent('口径不符')
    expect(screen.getByTestId('br-split')).toHaveTextContent('自然销售额')
    expect(screen.queryByTestId('metric-tree')).not.toBeInTheDocument()
  })

  it('没有数据：写明原因，指标卡是“尚无记录”，页面上没有金额冒充', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${API}/summary`]: () => ok(emptySummary()) }) })
    expect(await screen.findByTestId('br-empty', {}, { timeout: 15000 })).toHaveTextContent('不会用订单估算来冒充官方数据')
    const cards = screen.getAllByTestId('br-card')
    expect(cards.length).toBeGreaterThanOrEqual(10)
    expect(within(cards[0]!).getByText('尚无记录')).toBeInTheDocument()
    expect(screen.getByTestId('br-split-note')).toHaveTextContent('没有广告销售额')
    expect(document.body.textContent).not.toContain('$0.00')
    expect(screen.queryByRole('img', { name: '销售与流量逐日趋势图' })).not.toBeInTheDocument()
  })

  it('加载失败显示错误并可重试；没有 analytics.read 提示无权限', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${API}/summary`]: () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })

  it('没有权限：不显示页面内容', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['finance.read']) })
    expect(await screen.findByText(/没有权限|无权/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByTestId('br-dashboard')).not.toBeInTheDocument()
  })
})

describe('按日期与月度', () => {
  it('日粒度：没有记录的日子写“尚无记录”；切到按周重新请求；周粒度不显示对比', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('按日期')
    const table = await screen.findByTestId('br-date-table', {}, { timeout: 15000 })
    await within(table).findByText('2026-10-08')
    const rows = ['2026-10-08', '2026-10-09', '2026-10-10'].map(rowTextById)
    expect(rows[0]).toContain('数据中心')
    expect(rows[1]).toContain('无记录')
    expect(occurrences(rows[1]!, '尚无记录')).toBeGreaterThanOrEqual(10)
    expect(rows[1]).not.toContain('$0.00')
    expect(screen.getAllByTestId('br-total')[0]).toHaveTextContent('$2,000.00')
    await userEvent.click(screen.getByText('按周'))
    await waitFor(() => expect(paramsOf(app, `${API}/by-date`).some(params => params.get('granularity') === 'WEEK')).toBe(true))
  })

  it('选了对比期时并排显示对比期销售额与变化；对比期缺失时写“无法比较”', T, async () => {
    const data = byDate({
      compare: { mode: 'previous', from: '2026-10-05', to: '2026-10-07', days: 3 },
      comparePoints: [point('2026-10-05', { orderedSales: 600 }), point('2026-10-06'), gap('2026-10-07')],
    })
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${API}/by-date`]: () => ok(data) }) })
    await openTab('按日期')
    const table = await screen.findByTestId('br-date-table', {}, { timeout: 15000 })
    await within(table).findByText('2026-10-08')
    const rows = ['2026-10-08', '2026-10-09', '2026-10-10'].map(rowTextById)
    expect(rows[0]).toContain('2026-10-05')
    expect(rows[0]).toContain('$600.00')
    expect(rows[0]).toContain('+100.0%')
    expect(rows[2]).toContain('无法比较')
  })

  it('月度页签请求月粒度，说明被忽略的对比期', T, async () => {
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({ [`${API}/by-date`]: () => ok(byDate({ granularity: 'MONTH', compareNote: '对比期只支持按日：周与月的桶无法与对比期逐个对齐，已忽略对比期。' })) }),
    })
    await openTab('月度销售与订单')
    expect(await screen.findByTestId('br-monthly', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(await screen.findByTestId('br-compare-note')).toHaveTextContent('只支持按日')
    expect(paramsOf(app, `${API}/by-date`).some(params => params.get('granularity') === 'MONTH')).toBe(true)
  })
})

describe('按 ASIN', () => {
  it('三个页签请求各自的层级；子体表：标题跳 ASIN 360，缺值写“尚无记录”，目录里没有的 ASIN 写明', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('详情页销售与流量')
    const table = await screen.findByTestId('br-asin-child', {}, { timeout: 15000 })
    const link = await within(table).findByRole('link', { name: '护眼台灯' })
    expect(link).toHaveAttribute('href', expect.stringContaining('/p1'))
    const first = rowTextOf(link)
    expect(first).toContain('$500.00')
    expect(first).toContain('2.50%')
    expect(first).toContain('父体 B00000000P')
    const second = rowTextOf(within(table).getByText('B000000002'))
    expect(occurrences(second, '尚无记录')).toBeGreaterThanOrEqual(4)
    expect(second).toContain('商品目录里没有这个 ASIN')
    await openTab('销售与流量')
    await openTab('父体详情页销售与流量')
    await waitFor(() => expect(paramsOf(app, `${API}/by-asin`).map(params => params.get('level'))).toEqual(expect.arrayContaining(['CHILD', 'SKU', 'PARENT'])))
  })

  it('搜索带进请求并从第一块重新取；默认按销售额从高到低；父体行没有趋势', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers({ [`${API}/by-asin`]: () => ok(asinList({ level: 'PARENT' })) }) })
    await openTab('父体详情页销售与流量')
    await screen.findByTestId('br-asin-parent', {}, { timeout: 15000 })
    expect((await screen.findAllByText('不支持')).length).toBe(2)
    expect(paramsOf(app, `${API}/by-asin`)[0]!.get('sort')).toBe('orderedSales:desc')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索' }), 'b0000{enter}')
    await waitFor(() => {
      const calls = paramsOf(app, `${API}/by-asin`)
      const last = calls[calls.length - 1]!
      expect(last.get('q')).toBe('b0000')
      expect(last.get('cursor')).toBeNull()
    })
  })

  it('游标无限滚动：每块 100 行，请求不带页码；表头给出“约 N 行”', T, async () => {
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({ [`${API}/by-asin`]: () => ok(asinList({ pageInfo: { pageSize: 100, nextCursor: 'cur-2', hasMore: true, approxTotal: 40 } })) }),
    })
    await openTab('详情页销售与流量')
    await screen.findByTestId('br-asin-child', {}, { timeout: 15000 })
    expect(await screen.findByText('约 40 行')).toBeInTheDocument()
    const first = paramsOf(app, `${API}/by-asin`)[0]!
    expect(first.get('pageSize')).toBe('100')
    expect(first.get('cursor')).toBeNull()
    expect(first.has('page')).toBe(false)
  })

  it('点“趋势”打开抽屉请求这个 ASIN 的逐日数据，并给出 ASIN 360 入口', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('详情页销售与流量')
    await screen.findByTestId('br-asin-child', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('button', { name: '查看 B000000001 的趋势' }))
    const drawer = await screen.findByTestId('br-trend', {}, { timeout: 15000 })
    expect(paramsOf(app, `${API}/trends`)[0]!.get('asin')).toBe('B000000001')
    expect(within(drawer).getByRole('link', { name: '打开 ASIN 360' })).toBeInTheDocument()
    expect(within(drawer).getAllByTestId('br-trend-total')[0]).toHaveTextContent('$900.00')
    expect(within(drawer).getByRole('img', { name: /B000000001 逐日销售与流量趋势图/ })).toBeInTheDocument()
  })

  it('没有数据：说明原因；搜不到时写没有符合条件', T, async () => {
    const empty = asinList({ state: 'NO_DATA', note: '所选范围内尚无销售与流量数据', items: [], pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 0 } })
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${API}/by-asin`]: () => ok(empty) }) })
    await openTab('销售与流量')
    expect(await screen.findByTestId('br-empty', {}, { timeout: 15000 })).toHaveTextContent('尚无销售与流量数据')
    expect(document.body.textContent).not.toContain('$0.00')
  })
})

describe('图表配置与数值显示', () => {
  const points = [point('2026-10-08'), gap('2026-10-09'), point('2026-10-10', { sessions: null })]

  it('主指标是柱、次指标是线走右轴；没有记录的点是 null，不是 0', () => {
    const option = buildTrendOption({ primary: 'orderedSales', secondary: 'sessions', points })
    const series = option.series as Array<{ name: string; type: string; yAxisIndex?: number; data: Array<number | null> }>
    expect(series.map(item => [item.name, item.type, item.yAxisIndex ?? 0])).toEqual([
      ['订购商品销售额', 'bar', 0],
      ['会话数', 'line', 1],
    ])
    expect(series[0]!.data).toEqual([1200, null, 1200])
    expect(series[1]!.data).toEqual([2000, null, null])
    expect(option.yAxis).toHaveLength(2)
  })

  it('叠加对比期时多一条虚线，按位置对齐；次指标与主指标相同或没选就只有一根轴', () => {
    const option = buildTrendOption({ primary: 'orderedSales', secondary: 'orderedSales', points, comparePoints: [point('2026-10-05', { orderedSales: 600 })] })
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.map(item => item.name)).toEqual(['订购商品销售额', '对比期：订购商品销售额'])
    expect(series[1]!.data).toEqual([600, null, null])
    expect(option.yAxis).toHaveLength(1)
  })

  it('指标按格式显示；空值写“尚无记录”', () => {
    expect(formatMetric('orderedSales', 1234.5)).toBe('$1,234.50')
    expect(formatMetric('unitsOrdered', 1234)).toBe('1,234')
    expect(formatMetric('unitSessionPct', 0.0312)).toBe('3.12%')
    expect(formatMetric('sessions', null)).toBe('尚无记录')
    expect(formatMetric('orderedSales', undefined)).toBe('尚无记录')
  })
})
