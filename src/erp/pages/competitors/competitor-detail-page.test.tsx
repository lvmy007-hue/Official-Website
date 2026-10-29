import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { buildPriceTrendOption, buildRankTrendOption, buildShareTrendOption } from './competitors-detail-options'
import { asinIssue, detailPath, detailSearch } from './competitors-state'
import { SHARE_TREND_DISCLAIMER } from '@nova/api-contracts'
import { detailResponse, ok } from './competitors-fixtures.test-helper'

// 竞品详情（P4-12）：最新属性、并排对照、目录变化、其他卖家报价、评分“无官方来源”；没有数据写“尚无记录”，不写 0。

// jsdom 里没有画布，图表容器换成占位（图表配置本身由 competitors-detail-options 的纯函数生成）
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { CompetitorDetailPage: { load: () => import('./CompetitorDetailPage') } }
const url = '/app/competitors/B0COMPET01?storeId=st1&ownAsin=B0OWN00001'
afterEach(() => vi.unstubAllGlobals())

const open = async (response = () => detailResponse(), extra: Record<string, Handler> = {}, path = url) => {
  const app = mountApp({
    url: path,
    pages,
    handlers: {
      '/competitors/B0COMPET01': () => ok(response()),
      '/analytics/brand/share-trend': () =>
        ok({ asin: 'B0COMPET01', state: 'NO_DATA', message: '尚无这个 ASIN 的搜索查询表现（周报）。', disclaimer: SHARE_TREND_DISCLAIMER, points: [], truncated: false }),
      ...extra,
    },
  })
  const page = within(await screen.findByTestId('competitor-detail-page'))
  return { app, page }
}

describe('竞品详情', () => {
  it('摘要：价格、推荐报价、配送、会员资格、排名、图片数量；评分与评分数写“无官方来源”并说明不抓取前台页面', async () => {
    const { app, page } = await open()
    const summary = within(await page.findByTestId('competitor-summary-card', {}, { timeout: 15_000 }))
    expect(summary.getByText('$25.50')).toBeInTheDocument()
    expect(summary.getByText('有推荐报价')).toBeInTheDocument()
    expect(summary.getByText('FBA')).toBeInTheDocument()
    expect(summary.getByText('会员可享')).toBeInTheDocument()
    expect(summary.getByText('第 80 名（行李箱）')).toBeInTheDocument()
    expect(summary.getByTestId('competitor-rating')).toHaveTextContent('无官方来源')
    expect(summary.getByText(/不抓取亚马逊前台页面/)).toBeInTheDocument()
    expect(page.getByTestId('share-trend')).toHaveTextContent('这不是前台排名')
    const request = app.calls.find(call => call.path === '/competitors/B0COMPET01')
    const search = new URLSearchParams(request?.search)
    expect(search.get('storeId')).toBe('st1')
    expect(search.get('ownAsin')).toBe('B0OWN00001')
    expect(search.get('days')).toBe('90')
  })

  it('并排对照：我方没有的项写“尚无记录”；目录变化与其他卖家报价各自成表；趋势与份额图都有图表容器', async () => {
    const { page } = await open()
    const compare = within(await page.findByTestId('competitor-compare', {}, { timeout: 15_000 }))
    const brand = compare.getByText('品牌').closest('tr, [role=row]') as HTMLElement
    expect(brand).toHaveTextContent('尚无记录')
    expect(brand).toHaveTextContent('Acme')
    expect(compare.getByText('第 100 名（行李箱）')).toBeInTheDocument()
    expect(within(page.getByTestId('competitor-changes')).getByText('旧标题')).toBeInTheDocument()
    expect(within(page.getByTestId('competitor-offers')).getByText('其他卖家')).toBeInTheDocument()
    expect(page.getByRole('img', { name: '价格对比曲线' })).toBeInTheDocument()
    expect(page.getByRole('img', { name: '销售排名对比曲线' })).toBeInTheDocument()
    expect(page.getByRole('img', { name: '核心词点击份额曲线' })).toBeInTheDocument()
    expect(within(page.getByTestId('competitor-share')).getByText(/这是下限，不是精确值/)).toBeInTheDocument()
  })

  it('还没有快照：摘要写等待首次同步的说明，并排对照与其他卖家报价写“尚无记录 / 前置条件”，不写 0', async () => {
    const { page } = await open(() =>
      detailResponse({
        latest: null,
        trend: { state: 'NO_DATA', note: '还没有同步到这个竞品的快照；新关注的竞品要等下一次同步（每 6 小时一次）', range: { from: 'a', to: 'b' }, points: [], truncated: false, currency: 'USD' },
        changes: { state: 'NO_DATA', note: '还没有同步到快照', items: [], truncated: false },
        shareTrend: { state: 'NO_DATA', note: '我方对应商品还没有“搜索查询表现”数据，无法确定核心搜索词', points: [], coreTerms: 0 },
        otherOffers: { state: 'NO_DATA', note: '我方对应商品最近 3 天没有竞争报价记录', observedAt: null, items: [] },
      }),
    )
    expect((await page.findAllByText(/新关注的竞品要等下一次同步/, {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
    expect(await page.findByText(/最近 3 天没有竞争报价记录/, {}, { timeout: 10_000 })).toBeInTheDocument()
    expect(page.queryByTestId('competitor-rating')).toBeNull()
  })

  it('没有指定我方对应商品：对照与份额写“不适用”的原因，没有选择器', async () => {
    const { page } = await open(
      () =>
        detailResponse({
          ownAsin: null,
          ownTitle: null,
          watches: [{ id: 'w2', ownAsin: null, ownTitle: null, reason: 'MANUAL', reasonNote: null, addedAt: '2026-10-20T00:00:00Z' }],
          compare: { state: 'NOT_APPLICABLE', note: '没有指定我方对应商品，无法并排对照', rows: [] },
          shareTrend: { state: 'NOT_APPLICABLE', note: '没有指定我方对应商品，无法计算在核心词中的点击份额', points: [], coreTerms: 0 },
        }),
      {},
      '/app/competitors/B0COMPET01?storeId=st1',
    )
    expect(await page.findByText(/没有指定我方对应商品，无法并排对照/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(page.queryByRole('combobox', { name: '对照的我方商品' })).toBeNull()
  })

  it('缺少店铺参数：提示从列表点进来，不请求；读取失败：显示错误', async () => {
    const empty = await open(() => detailResponse(), {}, '/app/competitors/B0COMPET01')
    expect(await empty.page.findByText(/缺少店铺参数/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(empty.app.calls.some(call => call.path === '/competitors/B0COMPET01')).toBe(false)
    empty.app.unmount()
    mountApp({ url, pages, handlers: { '/competitors/B0COMPET01': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '没有找到这个竞品' } } }) } })
    expect((await screen.findAllByText(/读取竞品详情失败/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
  }, 40_000)
})

describe('图表配置与小工具（纯函数）', () => {
  const points = [
    { at: '2026-10-22T00:00:00Z', price: 24, ownPrice: null, rank: 90, ownRank: null },
    { at: '2026-10-24T05:00:00Z', price: null, ownPrice: 20, rank: null, ownRank: 100 },
  ]

  it('价格与排名曲线：没有记录的点保持为空，不补 0；排名纵轴反向', () => {
    const price = buildPriceTrendOption(points, 'USD') as { series: Array<{ data: Array<number | null> }> }
    expect(price.series[0]!.data).toEqual([24, null])
    expect(price.series[1]!.data).toEqual([null, 20])
    const rank = buildRankTrendOption(points) as { yAxis: { inverse: boolean }; series: Array<{ data: Array<number | null> }> }
    expect(rank.yAxis.inverse).toBe(true)
    expect(rank.series[0]!.data).toEqual([90, null])
  })

  it('份额曲线：没有结果的周为空；ASIN 校验与路径', () => {
    const share = buildShareTrendOption([
      { periodStart: '2026-10-05', share: null, hit: 0, total: 0 },
      { periodStart: '2026-10-12', share: 0.4, hit: 1, total: 2 },
    ]) as { series: Array<{ data: Array<number | null> }> }
    expect(share.series[0]!.data).toEqual([null, 0.4])
    expect(asinIssue('')).toContain('请填写')
    expect(asinIssue('abc')).toContain('10 位')
    expect(asinIssue(' b0abcde123 ')).toBeNull()
    expect(asinIssue('', '我方对应 ASIN')).toContain('我方对应 ASIN')
    expect(detailPath('B0 X')).toBe('/app/competitors/B0%20X')
    expect(detailSearch('st1', null)).toEqual({ storeId: 'st1' })
    expect(detailSearch('st1', 'B0OWN00001')).toEqual({ storeId: 'st1', ownAsin: 'B0OWN00001' })
  })
})
