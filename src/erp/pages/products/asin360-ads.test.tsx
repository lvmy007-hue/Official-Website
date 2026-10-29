import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Asin360AdsDailyPoint } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { adsFixture, unboundFixture } from './asin360-ads-fixtures.test-helper'
import { buildAdsTrendOption, hasTrendData } from './asin360-ads-options'
import { identityFixture } from './asin360-economics-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// ASIN 360 广告页签（P3-19）：页签入口随 ads.read；汇总、断货仍在花钱、趋势图、活动与广告组与投放对象与搜索词、品牌分析缺口；
// 空值不写 0、没接入写“尚未接入”、店铺没有绑定广告账户时只写原因。

const pages: LivePages = { Asin360Page: { load: () => import('./Asin360Page') } }
afterEach(() => vi.unstubAllGlobals())

const ok = (data: unknown) => ({ body: { success: true, data } })
const RANGE = { from: '2026-10-01', to: '2026-10-02', days: 2 }
const FULL = ['products.read', 'ads.read']

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
  '/products/p1/actions': () => ok({ state: 'NO_DATA', note: null, inventoryId: null, items: [] }),
  '/products/p1/ads': () => ok(adsFixture()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})
const open = async (over: Record<string, Handler> = {}, permissions: string[] = FULL) => {
  const app = mountApp({ url: '/app/products/p1', pages, handlers: handlers(over, permissions) })
  await screen.findByText('示例商品标题')
  await userEvent.click(await screen.findByRole('tab', { name: '广告' }))
  return app
}

describe('页签入口', () => {
  it('有 ads.read：显示“广告”页签', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    expect(screen.getByRole('tab', { name: '广告' })).toBeInTheDocument()
  })

  it('没有 ads.read：不出现', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({}, ['products.read']) })
    await screen.findByText('示例商品标题')
    expect(screen.queryByRole('tab', { name: '广告' })).not.toBeInTheDocument()
  })
})

describe('广告页签：有数据', () => {
  it('汇总：花费、销售额、广告成本销售比、全部销售额、广告占比、自然销售额、光环销售、活动数与广告数', async () => {
    const app = await open()
    const summary = await screen.findByTestId('asin360-ads-summary')
    expect(within(summary).getByText('$30.00')).toBeInTheDocument()
    expect(within(summary).getByText('$90.00')).toBeInTheDocument()
    expect(within(summary).getByText('33.3%')).toBeInTheDocument()
    expect(within(summary).getByText('$400.00')).toBeInTheDocument()
    expect(within(summary).getByText('7.5%')).toBeInTheDocument()
    expect(within(summary).getByText('$310.00')).toBeInTheDocument()
    expect(within(summary).getByText('$15.00')).toBeInTheDocument()
    expect(within(summary).getByText('3 / 4')).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/products/p1/ads')).toBe(true)
  })

  it('断货仍在花钱：提示出现；有货时不提示', async () => {
    await open()
    expect(await screen.findByTestId('asin360-ads-stockout')).toHaveTextContent('已断货')
  })

  it('有货：没有断货提示', async () => {
    await open({ '/products/p1/ads': () => ok(adsFixture({ stock: { stock: 'IN_STOCK', sellable: 20, snapshotDate: '2026-10-03', spend: 30 } })) })
    await screen.findByTestId('asin360-ads-summary')
    expect(screen.queryByTestId('asin360-ads-stockout')).not.toBeInTheDocument()
  })

  it('趋势图、活动表（有名称的给链接，没有记录的不给）、广告组（组内商品数大于 1 有提示）、投放对象、搜索词状态', async () => {
    await open()
    expect(await screen.findByRole('img', { name: '商品广告趋势图' })).toBeInTheDocument()
    const campaigns = screen.getByTestId('asin360-ads-campaigns')
    expect(within(campaigns).getByRole('link', { name: '春季推广' })).toHaveAttribute('href', expect.stringContaining('/campaigns/cam-1'))
    expect(within(campaigns).getByText('活动记录尚未同步')).toBeInTheDocument()
    expect(within(campaigns).getByRole('link', { name: '秋季推广' })).toBeInTheDocument()
    expect(campaigns).toHaveTextContent('尚无记录') // 只有广告关联、没有报表行：指标是空，不是 0
    const groups = screen.getByTestId('asin360-ads-adgroups')
    expect(within(groups).getByRole('link', { name: '核心词组' })).toHaveAttribute('href', expect.stringContaining('/ad-groups/ag-1'))
    expect(within(groups).getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByTestId('asin360-ads-shared-note')).toHaveTextContent('亚马逊没有按 ASIN 拆开')
    expect(within(screen.getByTestId('asin360-ads-targets')).getByRole('link', { name: 'yoga mat' })).toHaveAttribute('href', expect.stringContaining('/targets/kw-1'))
    const terms = screen.getByTestId('asin360-ads-terms')
    expect(within(terms).getByText('已否定')).toBeInTheDocument()
    expect(within(terms).getByText('已投放')).toBeInTheDocument()
    expect(within(terms).getByText('花费无转化')).toBeInTheDocument()
    expect(screen.getByTestId('asin360-ads-term-basis')).toHaveTextContent('完全相同')
  })

  it('品牌分析缺口写“尚未接入”，并写明口径说明', async () => {
    await open()
    expect(await screen.findByTestId('asin360-ads-brand-gaps')).toHaveTextContent('尚未接入')
    expect(screen.getByText(/没有记录的日子留空/)).toBeInTheDocument()
  })

  it('花费上限截断：提示只列了前 50 行', async () => {
    const data = adsFixture()
    await open({ '/products/p1/ads': () => ok({ ...data, campaigns: { ...data.campaigns, truncated: true } }) })
    expect(await within(await screen.findByTestId('asin360-ads-campaigns')).findByText(/只列出花费最高的前 50 行/)).toBeInTheDocument()
  })
})

describe('广告页签：没有数据与没有接入', () => {
  it('转化商品报表还没有记录、自然销售额不可给：光环写“尚无记录”，自然销售额写“不给出”，都不是 0', async () => {
    const data = adsFixture()
    await open({
      '/products/p1/ads': () =>
        ok({ ...data, halo: { state: 'NOT_CONNECTED', note: '转化商品报表还没有同步', sales: null }, summary: { ...data.summary, organicSales: null, organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL' } }),
    })
    const summary = await screen.findByTestId('asin360-ads-summary')
    expect(within(summary).getByText('不给出')).toBeInTheDocument()
    expect(within(summary).getByText('尚无记录')).toBeInTheDocument()
  })

  it('所选范围没有记录：说明状态，各块写原因，趋势图换成空状态', async () => {
    const empty = { state: 'NO_DATA' as const, note: '这些广告组下没有记录', items: [], truncated: false }
    const data = adsFixture()
    await open({
      '/products/p1/ads': () =>
        ok({
          ...data,
          state: 'NO_DATA',
          note: '所选日期范围内这个 ASIN 没有被推广商品的报表行',
          summary: {
            ...data.summary,
            totals: { impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 },
            ratios: { acos: null, roas: null, ctr: null, cpc: null, cvr: null },
            totalSales: null,
            adsShare: null,
            organicSales: null,
            ads: null,
          },
          trend: data.trend.map(item => ({ ...item, impressions: null, clicks: null, spend: null, sales: null, orders: null, totalSales: null, acos: null, adsShare: null })),
          stock: { stock: 'UNKNOWN', sellable: null, snapshotDate: null, spend: null },
          campaigns: empty,
          adGroups: empty,
          targets: empty,
          searchTerms: { ...empty, matchBasis: '口径' },
        }),
    })
    expect(await screen.findByText('所选日期范围内这个 ASIN 没有被推广商品的报表行')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '商品广告趋势图' })).not.toBeInTheDocument()
    expect(within(await screen.findByTestId('asin360-ads-summary')).getAllByText('尚无记录').length).toBeGreaterThan(3)
    expect(screen.queryByTestId('asin360-ads-stockout')).not.toBeInTheDocument()
  })

  it('店铺没有绑定广告账户：只写原因与品牌分析缺口，不显示汇总与各表', async () => {
    await open({ '/products/p1/ads': () => ok(unboundFixture()) })
    const unbound = await screen.findByTestId('asin360-ads-unbound')
    expect(unbound).toHaveTextContent('还没有绑定广告账户')
    expect(unbound).toHaveTextContent('品牌分析缺口：尚未接入')
    expect(screen.queryByTestId('asin360-ads-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('asin360-ads-campaigns')).not.toBeInTheDocument()
  })

  it('接口失败：显示读取失败的说明，不显示 0', async () => {
    await open({ '/products/p1/ads': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务暂不可用' } } }) })
    expect(await screen.findByText(/服务暂不可用|读取失败|出错/)).toBeInTheDocument()
    expect(screen.queryByTestId('asin360-ads-summary')).not.toBeInTheDocument()
  })
})

describe('趋势图配置', () => {
  const points: Asin360AdsDailyPoint[] = adsFixture().trend

  it('没有记录的日子保持 null：柱不画、线断开，不补 0', () => {
    const option = buildAdsTrendOption(points) as { series: Array<{ name: string; data: Array<number | null> }> }
    expect(option.series.map(item => item.name)).toEqual(['广告花费', '广告成本销售比', '广告占总销售比'])
    for (const item of option.series) expect(item.data[0]).toBeNull()
    expect(option.series[0].data).toEqual([null, 8, 22])
  })

  it('全部为空：没有趋势数据', () => {
    expect(hasTrendData(points)).toBe(true)
    expect(hasTrendData(points.map(item => ({ ...item, spend: null, acos: null, adsShare: null })))).toBe(false)
  })
})
