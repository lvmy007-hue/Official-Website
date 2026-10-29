import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { adsHandlers, dataOverview, emptyOverview } from './ads-fixtures.test-helper'

// 广告控制台（P3-05）：假服务端返回固定数据，验证四种数据状态如实展示、没有数据时不出现 0 或示例图、粒度切换与读取失败。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsConsolePage: { load: () => import('./AdsConsolePage') } }
afterEach(() => vi.unstubAllGlobals())

const page = () => screen.findByTestId('ads-console-page')

describe('广告控制台', () => {
  it('从未接入：横幅、12 张卡都写“尚未接入”，各区域给出原因，没有图表也没有 0', async () => {
    mountApp({ url: '/app/advertising', pages, handlers: adsHandlers(() => emptyOverview()) })
    await page()
    expect(await screen.findByTestId('ads-state-banner')).toHaveTextContent('广告数据尚未接入')
    const cards = screen.getByTestId('ads-cards')
    expect(within(cards).getAllByText('尚未接入')).toHaveLength(12)
    expect(within(cards).queryByText(/^\$?0(\.0+)?%?$/)).toBeNull()
    for (const id of ['ads-trend-empty', 'ads-mix-empty', 'ads-funnel', 'ads-budget-empty', 'ads-quadrant', 'ads-anomalies']) expect(screen.getByTestId(id)).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('ads-target-acos')).toHaveTextContent('目标 ACoS 需要活动目标字段')
    expect(screen.queryByLabelText(/趋势图|漏斗|四象限|花费占比|日预算/)).toBeNull()
    expect(screen.getByTestId('ads-products')).toHaveTextContent('同步器未交付')
    expect(screen.getByTestId('ads-attribution')).toHaveTextContent('归因尚未接入')
  })

  it('所选范围没有记录：横幅写“没有广告记录”，区域写“尚无记录”', async () => {
    mountApp({
      url: '/app/advertising',
      pages,
      handlers: adsHandlers(() =>
        emptyOverview({ state: 'NO_DATA', note: '范围内没有记录', refreshedAt: '2026-10-22T07:00:00Z', trend: { state: 'NO_DATA', note: '范围内没有记录', points: [], events: [] } }),
      ),
    })
    expect(await screen.findByTestId('ads-state-banner')).toHaveTextContent('所选范围内没有广告记录')
    expect(screen.getByTestId('ads-trend-empty')).toHaveTextContent('尚无记录')
  })

  it('有数据：卡片数值、对比、图表、象限、异常规则与归因都出现；卡片可追溯', async () => {
    mountApp({ url: '/app/advertising', pages, handlers: adsHandlers(() => dataOverview()) })
    const spend = await screen.findByTestId('ads-card-spend')
    expect(spend).toHaveTextContent('$1,234.50')
    expect(spend).toHaveTextContent('环比')
    expect(screen.getByTestId('ads-card-acos')).toHaveTextContent('个百分点')
    expect(screen.getByTestId('ads-card-haloSales')).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('ads-card-overBudget')).toHaveTextContent('尚未接入')
    for (const name of ['广告销售与花费趋势图', '总销售广告销售自然销售与广告占总销售比', '广告产品花费占比', '曝光点击订单漏斗', '按日花费与日预算', '活动四象限'])
      expect(await screen.findByRole('img', { name })).toBeInTheDocument()
    expect(screen.getByTestId('ads-quadrant')).toHaveTextContent('高花费高 ACoS（优先优化）：1 个')
    expect(screen.getByTestId('ads-quadrant')).toHaveTextContent('另有 1 个活动没有广告销售额')
    expect(screen.getByTestId('ads-anomalies')).toHaveTextContent('无转化活动')
    expect(screen.getByTestId('ads-anomalies')).toHaveTextContent('规则（自定默认值）')
    expect(screen.getByTestId('ads-over-budget')).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('ads-attribution')).toHaveTextContent('广告花费')
    expect(screen.getByTestId('ads-attribution')).toHaveTextContent('广告销售额变化无法拆解')
    expect(screen.queryByTestId('ads-state-banner')).toBeNull()
    fireEvent.click(within(spend).getByText('追溯'))
    expect(await screen.findByText(/广告花费合计/)).toBeInTheDocument()
  })

  it('其他币种、未绑定店铺花费、活动截断都如实提示', async () => {
    mountApp({
      url: '/app/advertising',
      pages,
      handlers: adsHandlers(() => dataOverview({ otherCurrencies: [{ currency: 'GBP', spend: 12.5 }], unboundSpend: 30, campaignsTruncated: true })),
    })
    expect(await screen.findByTestId('ads-other-currencies')).toHaveTextContent('GBP：12.50')
    expect(screen.getByTestId('ads-unbound')).toHaveTextContent('$30.00')
    expect(screen.getByTestId('ads-truncated')).toBeInTheDocument()
  })

  it('范围参数随请求带出，切换粒度会按新粒度重新读取', async () => {
    const app = mountApp({ url: '/app/advertising?storeIds=st2', pages, handlers: adsHandlers(url => dataOverview({ granularity: url.searchParams.get('granularity') })) })
    await screen.findByTestId('ads-card-spend')
    const first = app.calls.find(call => call.path === '/ads/overview')!
    expect(new URLSearchParams(first.search).get('storeIds')).toBe('st2')
    expect(new URLSearchParams(first.search).get('granularity')).toBe('day')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '时间粒度' })).getByText('周'))
    await waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('granularity') === 'week')).toBe(true))
  })

  it('读取失败：显示错误与重试，不显示示例数字', async () => {
    mountApp({ url: '/app/advertising', pages, handlers: { '/ads/overview': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await page()
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('ads-cards')).toBeNull()
  }, 30_000)
})
