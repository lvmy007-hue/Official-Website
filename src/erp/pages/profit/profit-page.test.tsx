import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ads, asins, compare, coverage, emptyOverview, ok, overview, stores } from './profit-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 利润分析页（P2b-10）：总览（净利润缺成本时不给并写明部分利润、尚未接入的项目、问题标记）、口径切换、店铺利润、ASIN 利润（维度、搜索、排序、翻页、展开明细）、
// 广告后利润、成本覆盖（需要成本字段权限）、利润桥对比、没有数据与加载失败的写法。页面上不出现拿 0 冒充的金额。

const pages: LivePages = {
  ProfitPage: { load: () => import('./ProfitPage') },
  Asin360Page: { load: () => Promise.resolve({ default: () => null }) },
  AccountingPeriodsPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/profit?storeIds=st1&from=2026-10-01&to=2026-10-10'
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/profit/overview': () => ok(overview()),
  '/profit/stores': () => ok(stores()),
  '/profit/asins': () => ok(asins()),
  '/profit/ads': () => ok(ads()),
  '/profit/cost-coverage': () => ok(coverage()),
  '/profit/bridge': () => ok(compare()),
  ...over,
})
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }, { timeout: 15000 }))
const rowOf = (text: string) => screen.getByText(text).closest('tr, [role=row]') as HTMLElement
const T = { timeout: 30000 }

describe('总览', () => {
  it('净利润缺成本时不给并写明部分利润；关税与汇兑损益尚未接入；只列有数的问题标记；请求带范围与口径', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    const kpis = await screen.findByTestId('profit-kpis', {}, { timeout: 15000 })
    expect(within(kpis).getByText('净利润')).toBeInTheDocument()
    expect(within(kpis).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('profit-partial')).toHaveTextContent('有 1 行缺成本算不出，已能算出的部分 $66.00（只是部分）')
    expect(within(kpis).getByText('$420.00')).toBeInTheDocument()
    expect(within(kpis).getByText('成本覆盖率')).toBeInTheDocument()

    const table = screen.getByTestId('profit-bridge-table')
    // 关税在 P6-18 接入（来自成本版本的单件关税），没有数据时和其他成本项一样显示“尚无记录”
    expect(within(rowOf0(table, '关税')).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
    expect(within(rowOf0(table, '汇兑损益')).getAllByText('尚未接入').length).toBeGreaterThanOrEqual(1)
    expect(within(rowOf0(table, '广告')).getByText('$25.00')).toBeInTheDocument()
    expect(within(rowOf0(table, '净利润')).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
    expect(within(rowOf0(table, '净利润')).getByText('有 1 行因缺少成本算不出利润')).toBeInTheDocument()

    expect(screen.getByText('缺少成本')).toBeInTheDocument()
    expect(screen.getByText('汇率沿用前值')).toBeInTheDocument()
    expect(screen.queryByText('成本仍是草稿')).not.toBeInTheDocument()
    expect(screen.getByTestId('profit-notes')).toHaveTextContent('关税尚未接入')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '从销售额到净利润的利润桥瀑布图' })).toBeInTheDocument()

    const params = new URLSearchParams(app.calls.find(call => call.path === '/profit/overview')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('from')).toBe('2026-10-01')
    expect(params.get('recognition')).toBe('ORDERED')
  })

  it('净利润能算出时显示金额与利润率；没有成本字段权限的返回里没有成本覆盖率', T, async () => {
    const full = overview()
    const data = overview({
      summary: { revenue: 420, units: 21, netProfit: 66, margin: 66 / 420, coveredProfit: 66, incompleteRows: 0, rows: 5 },
      bridge: { ...full.bridge, netProfit: 66, incompleteRows: 0 },
    })
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/overview': () => ok(data) }, ['profit.read', 'field.profit']) })
    const kpis = await screen.findByTestId('profit-kpis', {}, { timeout: 15000 })
    expect(within(kpis).getByText('$66.00')).toBeInTheDocument()
    expect(within(kpis).getByText('15.7%')).toBeInTheDocument()
    expect(within(kpis).queryByText('成本覆盖率')).not.toBeInTheDocument()
    expect(screen.queryByTestId('profit-partial')).not.toBeInTheDocument()
  })

  it('切换收入确认口径：所有请求带新口径', T, async () => {
    const seen: Array<string | null> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/profit/overview': url => {
          seen.push(url.searchParams.get('recognition'))
          return ok(overview())
        },
      }),
    })
    await screen.findByTestId('profit-kpis', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('combobox', { name: '收入确认口径' }))
    await userEvent.click(await screen.findByTitle('结算释放'))
    await waitFor(() => expect(seen).toContain('SETTLED'))
  })

  it('没有数据：写明原因，不显示任何 $0.00', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/overview': () => ok(emptyOverview()) }) })
    expect(await screen.findByTestId('profit-note', {}, { timeout: 15000 })).toHaveTextContent('尚无利润数据')
    expect(screen.getByTestId('profit-kpis')).toHaveTextContent('尚无记录')
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('加载失败：显示错误并可重试；没有权限写明需要的权限', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/overview': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })
})

function rowOf0(table: HTMLElement, label: string) {
  return within(table).getByText(label, { selector: 'td, td *, .ag-cell, .ag-cell *' }).closest('tr, [role=row]') as HTMLElement
}

describe('店铺利润', () => {
  it('每个店铺一行（没有数据的店铺写尚无记录）；展开看该店铺的利润桥', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('店铺利润')
    await screen.findByText('美国主店')
    expect(within(rowOf('欧洲店')).getByText('+$16.00')).toBeInTheDocument()
    expect(within(rowOf('欧洲店')).getByText('40.0%')).toBeInTheDocument()
    expect(within(rowOf('日本店')).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(3)
    await userEvent.click(rowOf('欧洲店'))
    const expanded = await screen.findAllByText('关税')
    expect(expanded.length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('$0.00')
  })
})

describe('ASIN 利润', () => {
  it('SKU 视图：缺成本的行净利润不给并标出；展开看单位经济、官方对照尚未接入、成本折算明细；店铺级费用另列', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('ASIN 利润')
    await screen.findByText('商品 A')
    const rowB = rowOf('商品 B')
    expect(within(rowB).getByText('缺成本 1 行')).toBeInTheDocument()
    expect(within(rowB).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(within(rowOf('商品 A')).getByRole('link', { name: 'B0A' }).getAttribute('href')).toMatch(/^\/app\/products\/prod-SKU-A/)

    await userEvent.click(rowOf('商品 A'))
    const expanded = await screen.findByTestId('profit-expanded')
    expect(within(expanded).getByText('单位经济（每件）')).toBeInTheDocument()
    expect(expanded).toHaveTextContent('官方单品经济对比：本表暂不并排对照官方单品经济；逐 SKU 逐日核对在“官方经济数据对账”页')
    expect(within(expanded).getByText('手工覆盖（1 行沿用前值）')).toBeInTheDocument()
    expect(within(expanded).getByText(/648\.00/)).toBeInTheDocument()
    expect(within(expanded).getByText('7.2')).toBeInTheDocument()

    await userEvent.click(screen.getByText('店铺级费用与账户级广告（不属于任何 SKU）'))
    expect(await screen.findByTestId('profit-store-level')).toBeInTheDocument()
  })

  it('维度、搜索、排序都发给服务端，并回到第一页；下一页带服务端签发的游标', T, async () => {
    const seen: URLSearchParams[] = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/profit/asins': url => {
          seen.push(url.searchParams)
          return ok(asins({ pageInfo: { pageSize: 20, nextCursor: url.searchParams.get('cursor') ? null : 'cur-2', hasMore: !url.searchParams.get('cursor'), approxTotal: 2 } }))
        },
      }),
    })
    await openTab('ASIN 利润')
    await screen.findByText('商品 A')
    expect(seen[0]!.get('by')).toBe('SKU')
    expect(seen[0]!.get('sort')).toBe('revenue:desc')
    await userEvent.click(screen.getByRole('button', { name: /下\s*一\s*页/ }))
    await waitFor(() => expect(seen.some(params => params.get('cursor') === 'cur-2')).toBe(true))
    await userEvent.click(screen.getByText('按 ASIN'))
    await waitFor(() => expect(seen.some(params => params.get('by') === 'ASIN' && !params.get('cursor'))).toBe(true))
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索商品' }), 'SKU-A{Enter}')
    await waitFor(() => expect(seen.some(params => params.get('q') === 'SKU-A')).toBe(true))
    await userEvent.click(screen.getByRole('combobox', { name: '排序' }))
    await userEvent.click(await screen.findByTitle('按净利润从高到低'))
    await waitFor(() => expect(seen.some(params => params.get('sort') === 'profit:desc' && params.get('q') === 'SKU-A')).toBe(true))
  })

  it('没有成本字段权限：接口不返回成本相关字段时不显示成本覆盖率列与折算明细', T, async () => {
    const stripped = asins({ items: [groupWithoutCost()] })
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/asins': () => ok(stripped) }, ['profit.read', 'field.profit']) })
    await openTab('ASIN 利润')
    await screen.findByText('商品 A')
    expect(screen.queryByText('成本覆盖率')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '成本覆盖' })).not.toBeInTheDocument()
  })
})

function groupWithoutCost() {
  const row = asins().items[0]!
  const { productCost: _a, firstMileCost: _b, otherCost: _c, costCoverage: _d, costDetail: _e, ...rest } = row
  void [_a, _b, _c, _d, _e]
  return { ...rest, perUnit: { revenue: 20, fees: 7, profit: 5 } }
}

describe('广告后利润', () => {
  it('广告尚未分摊：说明原因，商品行写“广告尚未分摊”，不是 0；店铺层面给账户级广告花费', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('广告后利润')
    expect(await screen.findByTestId('ads-allocation')).toHaveTextContent('广告尚未分摊到商品')
    expect(screen.getByTestId('ads-allocation')).toHaveTextContent('没有广告分摊结果')
    expect(within(rowOf('商品 A')).getAllByText('广告尚未分摊').length).toBeGreaterThanOrEqual(2)
    expect(within(rowOf('商品 B')).getByText('缺成本，无法判断')).toBeInTheDocument()
    expect(within(rowOf('美国主店')).getByText('$25.00')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('广告已分摊：商品行显示分摊金额、广告前后净利润与占比；店铺层面照常给广告花费', T, async () => {
    const base = ads()
    const allocated = ads({
      allocation: { state: 'ALLOCATED', note: '广告花费先按广告商品报表归属到 ASIN，剩余按规则分摊。' },
      items: [{ ...base.items[0]!, adsAllocated: 40, profitBeforeAds: 120, profit: 80, adsShare: 40 / 300, verdict: 'PROFIT_AFTER_ADS' }, base.items[1]!],
    })
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/ads': () => ok(allocated) }) })
    await openTab('广告后利润')
    expect(await screen.findByTestId('ads-allocation')).toHaveTextContent('广告已分摊到商品')
    const row = rowOf('商品 A')
    expect(within(row).getByText('$40.00')).toBeInTheDocument()
    expect(within(row).getByText('+$120.00')).toBeInTheDocument()
    expect(within(row).queryByText('广告尚未分摊')).not.toBeInTheDocument()
    expect(within(rowOf('商品 B')).getByText('缺成本，无法判断')).toBeInTheDocument()
  })
})

describe('成本覆盖', () => {
  it('有成本字段权限才出现；列出问题与最新成本生效日；未分摊广告与汇率沿用的汇总', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('成本覆盖')
    const summary = await screen.findByTestId('coverage-summary')
    expect(summary).toHaveTextContent('2 / 3')
    expect(summary).toHaveTextContent('1 / 0')
    expect(summary).toHaveTextContent('成本版本超过 180 天未更新')
    expect(screen.getByTestId('coverage-ads')).toHaveTextContent('账户级广告里还没分摊到商品的金额：$25.00')
    expect(within(rowOf('商品 B')).getByText('缺少成本（1 行）')).toBeInTheDocument()
    expect(within(rowOf('商品 B')).getByText('没有生效的成本版本')).toBeInTheDocument()
    expect(within(rowOf('商品 A')).getByText('2020-01-01（2486 天前）')).toBeInTheDocument()
  })

  it('广告已全部分摊：未分摊为 0 时写已全部分摊，不显示金额', T, async () => {
    const done = { state: 'OK' as const, total: 0, stores: [{ sellerAccountId: 's1', storeName: '美国主店', amount: 0 }] }
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/cost-coverage': () => ok(coverage({ adsUnallocated: done })) }) })
    await openTab('成本覆盖')
    expect(await screen.findByTestId('coverage-ads')).toHaveTextContent('广告花费已全部分摊到商品')
    expect(screen.getByTestId('coverage-ads')).not.toHaveTextContent('美国主店')
  })

  it('广告没接入：写“尚未接入”，不显示 0；没有成本字段权限时没有这个页签', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/cost-coverage': () => ok(coverage({ adsUnallocated: { state: 'NOT_CONNECTED', total: null, stores: [] } })) }) })
    await openTab('成本覆盖')
    expect(await screen.findByTestId('coverage-ads')).toHaveTextContent('广告花费尚未接入')
  })
})

describe('利润桥对比', () => {
  it('两期的销售额与净利润、净利润变化、逐项影响；没有数据的项不给影响；尚未接入的项写明', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('利润桥对比')
    expect(await screen.findByTestId('compare-net')).toHaveTextContent('对比方式：上一期。净利润变化：+$40.00')
    expect(screen.getByText('对比期：2026-09-21 至 2026-09-30')).toBeInTheDocument()
    expect(within(rowOf('佣金')).getByText('-$30.00')).toBeInTheDocument()
    expect(within(rowOf('广告')).getByText('不给（有一期没有数据）')).toBeInTheDocument()
    expect(within(rowOf('关税')).getByText('尚未接入')).toBeInTheDocument()
  })

  it('任一期净利润算不出：净利润变化不给；逐项影响与净利润变化对不上时写明差额', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/profit/bridge': () => ok(compare({ netImpact: null, unexplained: null, note: '至少一期有行因缺少成本算不出净利润，净利润变化不给。' })) }) })
    await openTab('利润桥对比')
    expect(await screen.findByTestId('compare-net')).toHaveTextContent('净利润变化：不给')
    expect(screen.getByTestId('profit-note')).toHaveTextContent('至少一期有行因缺少成本')
  })
})

describe('期间关账', () => {
  it('只是指引：链接到期间关账页，说明未关账时看到的是实时口径；这里没有任何写入口', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('期间关账')
    expect(await screen.findByText('关账在“期间关账”页处理')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '期间关账' }).getAttribute('href')).toContain('/app/finance/periods')
    expect(screen.getByText(/实时口径的利润/)).toBeInTheDocument()
    expect(screen.queryByText('尚未接入', { selector: '.ant-alert-message' })).toBeNull()
  })
})
