import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { basket, catalog, common, ok, repeat, terms } from './brand-fixtures.test-helper'
import { rowTextById } from '../../test/grid-rows'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 品牌分析另外四页（P4-04）：目录表现、热门搜索词（分组、词的历史、竞品监控尚未接入）、购物篮（热力矩阵与建议）、重复购买
// （只写“复购买家占比”、汇总口径说明、非美元与没给的值写“尚无记录”）。

const pages: LivePages = {
  BrandCatalogPerformancePage: { load: () => import('./BrandCatalogPerformancePage') },
  BrandSearchTermsPage: { load: () => import('./BrandSearchTermsPage') },
  BrandMarketBasketPage: { load: () => import('./BrandMarketBasketPage') },
  BrandRepeatPurchasePage: { load: () => import('./BrandRepeatPurchasePage') },
  AdTermDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const T = { timeout: 30000 }
const handlers = (api: string, body: () => unknown, over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [api]: () => ok(body()),
  ...over,
})
const callsOf = (app: ReturnType<typeof mountApp>, api: string) => app.calls.filter(call => call.path === api).map(call => new URLSearchParams(call.search))

describe('目录表现', () => {
  const API = '/analytics/brand/catalog'
  const PAGE = '/app/analytics/brand/catalog-performance'

  it('合计与各步转化率；表里没有值写“尚无记录”；与上一周期对比；没有目录记录的 ASIN 写明', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(API, () => catalog()) })
    const summary = await screen.findByTestId('ba-catalog-summary', {}, { timeout: 15000 })
    expect(summary).toHaveTextContent('10,000')
    expect(summary).toHaveTextContent('点击率 4.00%')
    expect(summary).toHaveTextContent('搜索带来的销售额 $660.00')
    await within(screen.getByTestId('ba-catalog-table')).findByText('B0AAAAAAA1')
    const rows = ['B0AAAAAAA1', 'B0AAAAAAA2'].map(rowTextById)
    expect(rows[0]).toContain('瑜伽垫')
    expect(rows[0]).toContain('Acme')
    expect(rows[0]).toContain('+1.0 个百分点') // 点击率 4% 比上期 3% 高 1 个百分点
    expect(rows[0]).toContain('$3,300.00')
    expect(rows[1]).toContain('目录里没有这个 ASIN')
    expect(rows[1]).toContain('尚无记录')
    expect(screen.getByTestId('ba-catalog-note')).toHaveTextContent('另一个口径')
  })

  it('排序与关键词进请求并回到第一页', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers(API, () => catalog()) })
    await screen.findByTestId('ba-catalog-table', {}, { timeout: 15000 })
    expect(callsOf(app, API).slice(-1)[0]!.get('sort')).toBe('purchases:desc')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索' }), 'mat{Enter}')
    await waitFor(() => expect(callsOf(app, API).slice(-1)[0]!.get('q')).toBe('mat'))
  })
})

describe('热门搜索词', () => {
  const API = '/analytics/brand/search-terms'
  const PAGE = '/app/analytics/brand/search-terms'

  it('列表：搜索频率排名、较上一周期、前三商品（我方标出）、分组标签；规则写在页面上', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(API, () => terms()) })
    const basis = await screen.findByTestId('ba-terms-basis', {}, { timeout: 15000 })
    expect(basis).toHaveTextContent('机会词：我方没进前三')
    await screen.findByText('tea cup')
    const rows = ['Sports|yoga mat', '|tea cup'].map(rowTextById)
    expect(rows[0]).toContain('下降 20 位')
    expect(rows[0]).toContain('我方进前三')
    expect(rows[0]).toContain('1. B0AAAAAAA1')
    expect(rows[0]).toContain('点击份额 30.0%')
    expect(rows[0]).toContain('转化份额 尚无记录')
    expect(rows[1]).toContain('未分部门')
    expect(rows[1]).toContain('机会词')
    expect(rows[1]).toContain('上升 100 位')
  })

  it('分组按钮带数量，选中后请求带 filter；没有我方商品时写明无法判断', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers(API, () => terms({ ownAsinCount: 0 })) })
    expect(await screen.findByTestId('ba-terms-noasin', {}, { timeout: 15000 })).toHaveTextContent('无法判断')
    await userEvent.click(screen.getByText('机会词 1'))
    await waitFor(() => expect(callsOf(app, API).slice(-1)[0]!.get('filter')).toBe('OPPORTUNITY'))
    expect(screen.getByText('我方进前三 1')).toBeInTheDocument()
  })

  it('点一个词：抽屉里显示最近 12 个周期的排名与我方份额；竞品监控尚未接入，按钮不可点', T, async () => {
    const history = {
      term: 'yoga mat',
      points: [
        { periodStart: '2026-10-11', rank: 120, ownBestClickShare: 0.3, inTop3: true },
        { periodStart: '2026-10-04', rank: null, ownBestClickShare: null, inTop3: false },
      ],
    }
    const app = mountApp({ url: PAGE, pages, handlers: handlers(API, () => terms(), { [API]: url => ok(url.searchParams.get('term') ? terms({ history }) : terms()) }) })
    await userEvent.click(await screen.findByText('yoga mat', {}, { timeout: 15000 }))
    const drawer = await screen.findByTestId('ba-term-drawer')
    expect(await within(drawer).findByText('2026-10-11')).toBeInTheDocument()
    expect(drawer).toHaveTextContent('30.0%')
    expect(drawer).toHaveTextContent('尚无记录') // 上一周期没有记录
    expect(within(drawer).getByTestId('ba-competitor-button')).toBeDisabled()
    expect(drawer).toHaveTextContent('P4-12')
    expect(callsOf(app, API).some(query => query.get('term') === 'yoga mat' && query.get('pageSize') === '1')).toBe(true)
  })
})

describe('购物篮分析', () => {
  const API = '/analytics/brand/market-basket'
  const PAGE = '/app/analytics/brand/market-basket'

  it('矩阵：有值的格子显示同篮率并按高低着色，没有这一对留空；建议规则与数量', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(API, () => basket()) })
    const matrix = await screen.findByTestId('ba-matrix', {}, { timeout: 15000 })
    const cells = within(matrix).getAllByTestId('ba-matrix-cell')
    expect(cells.map(cell => cell.textContent)).toEqual(['12.0%', '6.0%', ''])
    expect(cells[0]!.style.background).not.toBe(cells[1]!.style.background)
    expect(cells[2]!.style.background).toBe('transparent')
    expect(screen.getByTestId('ba-basket-advice')).toHaveTextContent('捆绑销售候选 1 条')
    expect(screen.getByTestId('ba-basket-advice')).toHaveTextContent('商品定向广告候选 1 条')
  })

  it('明细：我方另一个 ASIN 标“我方”并建议捆绑，别家商品建议商品定向；没有值写“尚无记录”或“无上一周期”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(API, () => basket()) })
    const table = await screen.findByTestId('ba-basket-table', {}, { timeout: 15000 })
    await within(table).findAllByText('B0AAAAAAA1')
    const rows = ['a', 'b'].map(rowTextById)
    expect(rows[0]).toContain('瑜伽砖')
    expect(rows[0]).toContain('我方')
    expect(rows[0]).toContain('捆绑销售候选')
    expect(rows[0]).toContain('+2.0 个百分点')
    expect(rows[1]).toContain('别家商品，没有标题')
    expect(rows[1]).toContain('商品定向广告候选')
    expect(rows[1]).toContain('无上一周期')
    expect(rows[1]).toContain('尚无记录')
  })

  it('没有数据时不画矩阵，写原因', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(API, () => basket({ ...common({ state: 'NO_DATA', note: '所选周期内尚无品牌分析数据' }), matrix: { rows: [], columns: [], cells: [], max: null }, items: [] })),
    })
    expect(await screen.findByTestId('ba-empty', {}, { timeout: 15000 })).toHaveTextContent('尚无品牌分析数据')
    expect(screen.getByText('所选周期内没有可画矩阵的同篮数据')).toBeInTheDocument()
    expect(screen.queryByTestId('ba-matrix')).not.toBeInTheDocument()
  })
})

describe('重复购买', () => {
  const API = '/analytics/brand/repeat-purchase'
  const PAGE = '/app/analytics/brand/repeat-purchase'

  it('只写“复购买家占比”，并说明口径；汇总与明细；没给的值写“尚无记录”，不当 0', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(API, () => repeat()) })
    const summary = await screen.findByTestId('ba-repeat-summary', {}, { timeout: 15000 })
    expect(summary).toHaveTextContent('复购买家占比')
    expect(summary).toHaveTextContent('18.00%')
    expect(summary).toHaveTextContent('$600.00')
    expect(screen.getByTestId('ba-repeat-note')).toHaveTextContent('不是复购订单占比')
    expect(screen.queryByText('复购订单占比')).not.toBeInTheDocument()
    await within(screen.getByTestId('ba-repeat-table')).findByText('B0AAAAAAA1')
    const rows = ['B0AAAAAAA1', 'B0AAAAAAA3'].map(rowTextById)
    expect(rows[0]).toContain('+5.0 个百分点')
    expect(rows[0]).toContain('$500.00')
    expect(rows[1]).toContain('目录里没有这个 ASIN')
    expect(rows[1]).toContain('尚无记录')
    expect(screen.getByRole('img', { name: '重复购买逐期趋势图' })).toBeInTheDocument()
  })

  it('换成按品牌：请求带 dimension=BRAND，列头改为“品牌”', T, async () => {
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers(API, () => repeat(), {
        [API]: url =>
          ok(url.searchParams.get('dimension') === 'BRAND' ? repeat({ dimension: 'BRAND', items: [{ ...repeat().items[0]!, key: 'Acme', label: 'Acme', asin: null, asins: 3 }] }) : repeat()),
      }),
    })
    await screen.findByTestId('ba-repeat-table', {}, { timeout: 15000 })
    await userEvent.click(screen.getByText('按品牌'))
    await waitFor(() => expect(callsOf(app, API).slice(-1)[0]!.get('dimension')).toBe('BRAND'))
    expect(await screen.findByText('3 个 ASIN')).toBeInTheDocument()
    expect(within(screen.getByTestId('ba-repeat-table')).getByRole('columnheader', { name: '品牌' })).toBeInTheDocument()
  })

  it('翻页：下一页带游标，上一页回到第一页', T, async () => {
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers(API, () => repeat(), {
        [API]: url => ok(repeat({ pageInfo: { pageSize: 20, nextCursor: url.searchParams.get('cursor') ? null : 'cursor-2', hasMore: !url.searchParams.get('cursor'), approxTotal: null } })),
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /下一页/ }, { timeout: 15000 }))
    await waitFor(() => expect(callsOf(app, API).slice(-1)[0]!.get('cursor')).toBe('cursor-2'))
    await userEvent.click(await screen.findByRole('button', { name: /上一页/ }))
    expect(await screen.findByText(/第 1 页/)).toBeInTheDocument() // 第一页已缓存，不必重新请求
  })
})
