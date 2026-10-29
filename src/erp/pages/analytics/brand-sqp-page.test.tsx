import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { buildQuadrantOption, buildTrendOption, changeText, heatColor, percentText, rankChangeText } from './brand-options'
import { common, ok, shares, sqp } from './brand-fixtures.test-helper'
import { rowTextById } from '../../test/grid-rows'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 品牌分析·搜索查询表现页（P4-04）：份额漏斗、趋势、价格与配送、象限与断点（词太少写原因）、品牌总览、明细表（没有值写“尚无记录”、
// 未投放的词给“加入投放”链接）、周期切换、无数据/缺品牌分析角色/超上限的说明、权限。

const pages: LivePages = {
  BrandSearchQueryPage: { load: () => import('./BrandSearchQueryPage') },
  AdTermDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/analytics/brand/search-query'
const API = '/analytics/brand/search-query'
const T = { timeout: 30000 }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [API]: () => ok(sqp()),
  ...over,
})
const calls = (app: ReturnType<typeof mountApp>) => app.calls.filter(call => call.path === API).map(call => new URLSearchParams(call.search))
const last = (app: ReturnType<typeof mountApp>) => calls(app).slice(-1)[0]!

describe('搜索查询表现页', () => {
  it('份额漏斗：四个环节的份额、较上一周期的变化与次数；没有记录的值写“尚无记录”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const impressions = await screen.findByTestId('ba-funnel-impressions', {}, { timeout: 15000 })
    expect(impressions).toHaveTextContent('展示份额')
    expect(impressions).toHaveTextContent('20.0%')
    expect(impressions).toHaveTextContent('较上一周期 +5.0 个百分点')
    expect(impressions).toHaveTextContent('我方 300 / 全部 1,500')
    expect(screen.getByTestId('ba-funnel-purchases')).toHaveTextContent('10.0%')
    expect(screen.getByRole('img', { name: '搜索查询份额逐期趋势图' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '机会象限散点图' })).toBeInTheDocument()
  })

  it('周期：默认用最近有数据的周期并提示；价格与配送里没值的写“尚无记录”', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    expect(await screen.findByTestId('ba-defaulted', {}, { timeout: 15000 })).toHaveTextContent('2026-10-11 至 2026-10-17')
    expect(screen.getByTestId('ba-period-range')).toHaveTextContent('对比上一周期 2026-10-04')
    const price = screen.getByTestId('ba-price')
    expect(within(price).getByText('贵 10.0%')).toBeInTheDocument()
    expect(rowTextById('cartAdd')).toContain('尚无记录')
    expect(within(price).getByText('当日达')).toBeInTheDocument()
    expect(last(app).get('period')).toBe('WEEK')
    expect(last(app).has('periodStart')).toBe(false)
    expect(last(app).get('sort')).toBe('searchVolume:desc')
  })

  it('换成“月”重新请求，起始日清空；选一个起始日后请求带上它', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await screen.findByTestId('ba-funnel', {}, { timeout: 15000 })
    await userEvent.click(screen.getByText('月'))
    await waitFor(() => expect(last(app).get('period')).toBe('MONTH'))
    expect(last(app).has('periodStart')).toBe(false)
    await userEvent.click(screen.getByRole('combobox', { name: '周期起始日' }))
    await userEvent.click(await screen.findByTitle('2026-10-04'))
    await waitFor(() => expect(last(app).get('periodStart')).toBe('2026-10-04'))
  })

  it('明细表：份额与变化、没有值写“尚无记录”；未投放的词有“加入投放”链接，已投放的没有', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const table = await screen.findByTestId('ba-sqp-table', {}, { timeout: 15000 })
    await within(table).findByText('yoga mat')
    const rows = ['yoga mat', 'yoga block'].map(rowTextById)
    expect(rows[0]).toContain('+2.0 个百分点')
    expect(rows[0]).toContain('-1.2 个百分点')
    expect(rows[0]).toContain('核心优势')
    const links = within(table).getAllByRole('link', { name: '加入投放' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('term=yoga+mat'))
    expect(rows[1]).toContain('已投放')
    expect(rows[1]).toContain('尚无记录')
    expect(rows[1]).toContain('未判断')
    expect(rows[1]).toContain('展示高、点击低')
  })

  it('词太少时象限与断点写明原因，不画图', T, async () => {
    const note = '带份额的词不足 5 个，不做象限判断'
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        [API]: () =>
          ok(
            sqp({
              quadrant: { state: 'INSUFFICIENT', note, medians: null, counts: { STAR: 0, OPPORTUNITY: 0, NICHE: 0, WATCH: 0 }, points: [] },
              breakpoints: { state: 'INSUFFICIENT', note: '断点诊断需要至少 5 个词', medians: null, counts: { CLICK: 0, CART: 0, PURCHASE: 0 }, examples: { CLICK: [], CART: [], PURCHASE: [] } },
            }),
          ),
      }),
    })
    expect(await screen.findByTestId('ba-quadrant-note', {}, { timeout: 15000 })).toHaveTextContent(note)
    expect(screen.getByTestId('ba-breakpoints-note')).toHaveTextContent('至少 5 个词')
    expect(screen.queryByRole('img', { name: '机会象限散点图' })).not.toBeInTheDocument()
  })

  it('维度：按 ASIN 时选择 ASIN 后请求带 asin 与 dimension，不带 brand', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await screen.findByTestId('ba-funnel', {}, { timeout: 15000 })
    await userEvent.click(screen.getByText('按 ASIN'))
    await userEvent.click(await screen.findByRole('combobox', { name: 'ASIN' }))
    await userEvent.click(await screen.findByText(/B0AAAAAAA1 · 瑜伽垫/))
    await waitFor(() => expect(last(app).get('asin')).toBe('B0AAAAAAA1'))
    expect(last(app).get('dimension')).toBe('ASIN')
    expect(last(app).has('brand')).toBe(false)
  })

  it('没有数据：写原因，缺品牌分析角色的店铺单独写明；读到上限时提示只含已读到的部分', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        [API]: () =>
          ok(
            sqp({
              ...common({
                state: 'NO_DATA',
                note: '所选周期内尚无品牌分析数据',
                truncated: true,
                period: { kind: 'WEEK', start: null, end: null, previousStart: null, available: [], defaulted: true },
              }),
              items: [],
              funnel: [],
              trend: [],
            }),
          ),
      }),
    })
    expect(await screen.findByTestId('ba-empty', {}, { timeout: 15000 })).toHaveTextContent('尚无品牌分析数据')
    expect(screen.getByTestId('ba-truncated')).toHaveTextContent('超过读取上限')
    expect(screen.getByTestId('br-stores')).toHaveTextContent('美国二店 · 未授权')
    expect(screen.getByTestId('br-stores')).toHaveTextContent('需要品牌分析角色')
  })

  it('没有品牌分析权限：不显示内容', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['analytics.read']) })
    expect(await screen.findByText(/没有权限|无权/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByTestId('ba-sqp')).not.toBeInTheDocument()
  })
})

describe('品牌分析纯函数', () => {
  it('份额变化写百分点；没有上一周期写明；排名变化正数是上升', () => {
    expect(changeText(0.012)).toBe('+1.2 个百分点')
    expect(changeText(-0.05)).toBe('-5.0 个百分点')
    expect(changeText(0)).toBe('持平')
    expect(changeText(null)).toBe('无上一周期')
    expect(rankChangeText(20)).toBe('上升 20 位')
    expect(rankChangeText(-3)).toBe('下降 3 位')
    expect(rankChangeText(null)).toBe('无上一周期')
    expect(percentText(null)).toBe('尚无记录')
    expect(percentText(0)).toBe('0.0%')
  })

  it('趋势图：某期没有份额不画成 0；象限图按象限分系列并带中位数线', () => {
    const option = buildTrendOption([
      { periodStart: '2026-10-04', volume: 10, shares: shares({ purchase: null }) },
      { periodStart: '2026-10-11', volume: null, shares: shares({ purchase: 0.1 }) },
    ])
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.find(item => item.name === '购买份额')!.data).toEqual([null, 0.1])
    expect(series.find(item => item.name === '搜索量')!.data).toEqual([10, null])
    const quadrant = sqp().quadrant
    const quadrantSeries = buildQuadrantOption(quadrant).series as Array<{ name: string; data: unknown[]; markLine?: unknown }>
    expect(quadrantSeries.map(item => item.name)).toEqual(['核心优势', '增长机会', '利基词', '观察'])
    expect(quadrantSeries[0]!.data).toHaveLength(1)
    expect(quadrantSeries[0]!.markLine).toBeDefined()
  })

  it('热力色：没有值透明，越高越深', () => {
    expect(heatColor(null, 0.12)).toBe('transparent')
    expect(heatColor(0.12, null)).toBe('transparent')
    const low = Number(/,\s*([\d.]+)\)$/.exec(heatColor(0.01, 0.12))![1])
    const high = Number(/,\s*([\d.]+)\)$/.exec(heatColor(0.12, 0.12))![1])
    expect(high).toBeGreaterThan(low)
  })
})
