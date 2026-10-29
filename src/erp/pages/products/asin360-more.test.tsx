import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { asin360ActionRuleViews } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { identityFixture } from './asin360-economics-fixtures.test-helper'
import { competitorsFixture, contentFixture, listingFixture, pricingFixture, reviewsFixture, trafficFixture } from './asin360-more-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// ASIN 360 流量转化、刊登与问题、评价、定价与购物车、竞品、内容与 A+ 页签与建议规则清单（P4-08）。

const pages: LivePages = { Asin360Page: { load: () => import('./Asin360Page') } }
afterEach(() => vi.unstubAllGlobals())
const ok = (data: unknown) => ({ body: { success: true, data } })
const RANGE = { from: '2026-10-01', to: '2026-10-03', days: 3 }
const FULL = ['products.read', 'listing.read', 'reviews.read', 'pricing.read', 'competitors.read', 'aplus.read', 'inventory.read']

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = FULL): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/products/p1': () => ok(identityFixture()),
  '/products/p1/overview': () =>
    ok({
      period: RANGE,
      previous: RANGE,
      yoy: RANGE,
      hasRows: false,
      cards: [],
      daily: [],
      table: [],
      attribution: null,
      compare: null,
      defaulted: true,
      currency: 'USD',
      split: { state: 'NO_DATA', note: null },
      profit: { state: 'NO_DATA', note: null },
      refunds: { note: '' },
    }),
  '/products/p1/actions': () => ok({ state: 'OK', note: null, inventoryId: 'inv1', items: [], rules: asin360ActionRuleViews({ inventory: 'OK', suggestionIds: ['replenish'] }) }),
  '/products/p1/traffic': () => ok(trafficFixture()),
  '/products/p1/listing': () => ok(listingFixture()),
  '/products/p1/reviews': () => ok(reviewsFixture()),
  '/products/p1/content': () => ok(contentFixture()),
  '/products/p1/pricing': () => ok(pricingFixture()),
  '/products/p1/competitors': () => ok(competitorsFixture()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})
const open = async (_label: string, over: Record<string, Handler> = {}, permissions: string[] = FULL) => {
  const app = mountApp({ url: '/app/products/p1', pages, handlers: handlers(over, permissions) })
  await screen.findByText('示例商品标题')
  return app
}

describe('页签入口', () => {
  it('有各自的读权限：六个页签都出现；缺权限的不出现', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    for (const label of ['订单与流量', '刊登与问题', '评价', '定价与购物车', '竞品对比', '内容与 A+']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
  })

  it('只有 products.read：只有订单与流量，没有另外五个', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({}, ['products.read']) })
    await screen.findByText('示例商品标题')
    expect(screen.getByRole('tab', { name: '订单与流量' })).toBeInTheDocument()
    for (const label of ['刊登与问题', '评价', '定价与购物车', '竞品', '内容与 A+']) expect(screen.queryByRole('tab', { name: label })).not.toBeInTheDocument()
  })
})

describe('建议规则清单', () => {
  it('6 条规则：库存类按数据显示，其余写“尚未接入”与负责的工作包，不当作“没触发”', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    const panel = await screen.findByTestId('asin360-action-rules')
    expect(within(panel).getByText('建议规则：6 条中 2 条已接入，1 条已触发')).toBeInTheDocument()
    await userEvent.click(within(panel).getByText(/建议规则：/))
    expect(within(await screen.findByTestId('asin360-rule-LOW_COVER')).getByText('已触发')).toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-rule-AGING_FEE')).getByText('未触发')).toBeInTheDocument()
    const price = screen.getByTestId('asin360-rule-PRICE_ABOVE_WIN')
    expect(within(price).getByText('尚未接入')).toBeInTheDocument()
    expect(price).toHaveTextContent('P4-11')
    expect(screen.getByTestId('asin360-rule-CONTENT_CHANGED')).toHaveTextContent('尚未接入')
  })

  it('没有库存读权限：库存类规则写“无权查看”', async () => {
    mountApp({
      url: '/app/products/p1',
      pages,
      handlers: handlers({
        '/products/p1/actions': () => ok({ state: 'RESTRICTED', note: null, inventoryId: null, items: [], rules: asin360ActionRuleViews({ inventory: 'RESTRICTED', suggestionIds: [] }) }),
      }),
    })
    await screen.findByText('示例商品标题')
    const panel = await screen.findByTestId('asin360-action-rules')
    await userEvent.click(within(panel).getByText(/建议规则：/))
    expect(within(await screen.findByTestId('asin360-rule-LOW_COVER')).getByText('无权查看')).toBeInTheDocument()
  })
})

describe('流量转化页签', () => {
  it('逐日汇总、趋势图、搜索漏斗、核心搜索词与断点、目录表现、没有来源的区块', async () => {
    const app = await open('流量转化')
    const summary = await screen.findByTestId('asin360-traffic-summary')
    expect(within(summary).getByText('400')).toBeInTheDocument()
    expect(within(summary).getByText('1.3%')).toBeInTheDocument()
    expect(within(summary).getByText('60.0%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '商品流量转化趋势图' })).toBeInTheDocument()
    expect(screen.getByTestId('ba-funnel-clicks')).toBeInTheDocument()
    const search = screen.getByTestId('asin360-traffic-search')
    expect(within(search).getByText('低点击词')).toBeInTheDocument()
    expect(within(search).getAllByText('展示高、点击低').length).toBeGreaterThan(0)
    expect(screen.getByTestId('asin360-traffic-breakpoints')).toHaveTextContent('展示高、点击低 1 个词')
    const catalog = screen.getByTestId('asin360-traffic-catalog')
    expect(within(catalog).getByText('1,000')).toBeInTheDocument()
    expect(within(catalog).getAllByText('无上一周期').length).toBeGreaterThan(0)
    for (const key of ['device', 'cartRate', 'hourly']) expect(screen.getByTestId(`asin360-pending-${key}`)).toHaveTextContent('尚未接入')
    expect(app.calls.some(call => call.path === '/products/p1/traffic' && call.search.includes('period=WEEK'))).toBe(true)
  })

  it('切换周期：带上 period 参数重新取数', async () => {
    const app = await open('流量转化')
    const search = await screen.findByTestId('asin360-traffic-search')
    await userEvent.click(within(search).getByText('月'))
    await screen.findByTestId('asin360-traffic-search')
    expect(app.calls.some(call => call.path === '/products/p1/traffic' && call.search.includes('period=MONTH'))).toBe(true)
  })

  it('没有数据与没有权限：逐日写“尚无记录”，品牌区块写“无权查看”，不显示 0', async () => {
    const base = trafficFixture()
    await open('流量转化', {
      '/products/p1/traffic': () =>
        ok(
          trafficFixture({
            daily: { state: 'NO_DATA', note: '所选日期范围内没有这个 ASIN 的流量记录', points: [], summary: null, truncated: false },
            searchFunnel: { ...base.searchFunnel, state: 'RESTRICTED', note: '需要“品牌分析”读取权限', period: null, stages: [], terms: [], termCount: 0 },
            catalogFunnel: { state: 'NOT_CONNECTED', note: '品牌分析尚未接入', period: null, current: null, previous: null },
          }),
        ),
    })
    const daily = await screen.findByTestId('asin360-traffic-daily')
    expect(within(daily).getByText('尚无记录')).toBeInTheDocument()
    expect(screen.queryByTestId('asin360-traffic-summary')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-traffic-search')).getByText('无权查看')).toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-traffic-catalog')).getByText('尚未接入')).toBeInTheDocument()
  })
})

describe('刊登与问题、评价、内容页签', () => {
  it('刊登与问题：已同步的资料给真实值，没有取值写“尚无记录”，刊登问题等逐项“尚未接入”', async () => {
    await open('刊登与问题')
    const facts = await screen.findByTestId('asin360-listing-facts')
    expect(within(facts).getByText('示例品牌')).toBeInTheDocument()
    expect(within(facts).getAllByText('尚无记录').length).toBeGreaterThan(0)
    for (const key of ['issues', 'quality', 'restrictions', 'attributes']) expect(screen.getByTestId(`asin360-pending-${key}`)).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('asin360-pending-issues')).toHaveTextContent('P4-09、P4-10')
  })

  it('评价：评分（标注来源）、前 10 主题与类目对比用真实数据，请求评价覆盖率仍是“尚未接入”', async () => {
    await open('评价')
    const rating = await screen.findByTestId('asin360-reviews-rating')
    expect(rating).toHaveTextContent('来源：文件导入')
    expect(within(rating).getByText('4.4')).toBeInTheDocument()
    expect(within(rating).getByText('1280')).toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-reviews-topics')).getByText('Easy to use')).toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-reviews-topics')).getByText('Battery life')).toBeInTheDocument()
    const category = screen.getByTestId('asin360-reviews-category')
    expect(within(category).getByText('12.0%')).toBeInTheDocument()
    expect(within(category).getByText('20.0%')).toBeInTheDocument()
    expect(within(category).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('asin360-pending-coverage')).toHaveTextContent('P4-13')
  })

  it('评价：没有评分与主题时写清原因，不显示 0', async () => {
    const empty = { state: 'NO_DATA' as const, note: '还没有数据的原因', snapshotDate: null, positive: [], negative: [] }
    await open('评价', {
      '/products/p1/reviews': () =>
        ok(
          reviewsFixture({
            rating: { state: 'NO_DATA', note: '还没有评分记录', sourceLabel: '文件导入', latest: null, points: [] },
            topics: empty,
            category: { state: 'NO_DATA', note: '需要先有评论主题', browseNodeName: null, month: null, previousMonth: null, rows: [] },
          }),
        ),
    })
    const rating = await screen.findByTestId('asin360-reviews-rating')
    expect(within(rating).getByText('还没有评分记录')).toBeInTheDocument()
    expect(within(screen.getByTestId('asin360-reviews-topics')).getByText('还没有数据的原因')).toBeInTheDocument()
    expect(rating).not.toHaveTextContent('0.0')
  })
  it('内容与 A+：字段事实与“尚未接入”区块；没有主图写“尚无记录”', async () => {
    await open('内容与 A+')
    expect(await screen.findByTestId('asin360-content-facts')).toBeInTheDocument()
    expect(screen.getByText('主图：尚无记录')).toBeInTheDocument()
    expect(screen.getByTestId('asin360-pending-othersChanged')).toHaveTextContent('P4-14')
    expect(within(screen.getByTestId('asin360-content-aplus')).getByText('品牌故事 A+')).toBeInTheDocument()
  })
})

describe('定价与购物车、竞品页签', () => {
  it('定价：标价、成交均价、购物车获得率与趋势图；推荐报价等逐项“尚未接入”', async () => {
    await open('定价与购物车')
    const summary = await screen.findByTestId('asin360-pricing-summary')
    expect(within(summary).getByText('$19.90')).toBeInTheDocument()
    expect(within(summary).getByText('$20.00')).toBeInTheDocument()
    expect(within(summary).getByText('60.0%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '商品价格趋势图' })).toBeInTheDocument()
    for (const key of ['winPrice', 'offers', 'history', 'events']) expect(screen.getByTestId(`asin360-pending-${key}`)).toHaveTextContent('P4-11')
  })

  it('定价：没有标价时写“尚无记录”，不显示 $0', async () => {
    await open('定价与购物车', {
      '/products/p1/pricing': () =>
        ok(pricingFixture({ listPrice: { value: null, currency: 'USD', updatedAt: null }, daily: { state: 'NO_DATA', note: '范围内没有销售记录', points: [], avgPrice: null, buyBoxPct: null } })),
    })
    const summary = await screen.findByTestId('asin360-pricing-summary')
    expect(within(summary).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(3)
    expect(within(summary).queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('竞品：核心搜索词点击前三，标出本品与我方其他商品；关注竞品在竞品对比区块', async () => {
    await open('竞品')
    const terms = await screen.findByTestId('asin360-competitor-terms')
    expect(within(terms).getByText('yoga mat')).toBeInTheDocument()
    expect(within(terms).getByText('B0RIVAL001')).toBeInTheDocument()
    expect(within(terms).getByText('本品')).toBeInTheDocument()
    expect(within(terms).getByText('第 2 名')).toBeInTheDocument()
    expect(screen.queryByTestId('asin360-pending-watch')).not.toBeInTheDocument()
  })

  it('竞品：品牌角色缺失时写清原因，不画空表', async () => {
    await open('竞品', {
      '/products/p1/competitors': () => ok(competitorsFixture({ terms: { state: 'NOT_CONNECTED', note: '这个店铺没有品牌分析角色', period: null, rows: [] } })),
    })
    const terms = await screen.findByTestId('asin360-competitor-terms')
    expect(within(terms).getByText('尚未接入')).toBeInTheDocument()
    expect(within(terms).getByText('这个店铺没有品牌分析角色')).toBeInTheDocument()
  })
})
