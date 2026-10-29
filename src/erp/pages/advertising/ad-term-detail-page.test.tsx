import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { ScopeSearchSchema } from '@nova/api-contracts'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { detailResponse } from './ad-terms-fixtures.test-helper'

// 词级分析页（P3-10）：词从地址栏的 term 参数来，没有 term 提示先选词；身份区指标与异常标签；趋势、投放关系、投放与否定记录、建议与历史动作效果；
// 品牌分析页签只在接口返回数据时出现；没有数据写“尚无记录”（不写 0）；写亚马逊的按钮禁用并说明原因；读取失败。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdTermDetailPage: { load: () => import('./AdTermDetailPage'), search: ScopeSearchSchema } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/ad-terms/detail?term=yoga%20mat'
const handlers = (data: () => unknown = () => detailResponse()) => ({ '/ads/terms/detail': () => ok(data()) })

describe('词级分析', () => {
  it('按地址栏的 term 请求；身份区：词、状态、关键指标、异常标签、返回链接', async () => {
    const app = mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    expect(await within(page).findByText('yoga mat')).toBeInTheDocument()
    expect(page).toHaveTextContent('已投放')
    expect(page).toHaveTextContent('$40.00')
    expect(page).toHaveTextContent('$150.00')
    expect(page).toHaveTextContent('在 2 个活动里出现')
    expect(page).toHaveTextContent('低广告成本销售比可扩量')
    expect(within(page).getByRole('link', { name: '返回词级中心' })).toHaveAttribute('href', expect.stringContaining('/app/ad-terms'))
    expect(app.calls.some(call => call.path === '/ads/terms/detail' && new URLSearchParams(call.search).get('term') === 'yoga mat')).toBe(true)
    expect(screen.getByTestId('term-basis')).toBeInTheDocument()
  })

  it('没有 term 参数：提示先选词，不发请求', async () => {
    const app = mountApp({ url: '/app/ad-terms/detail', pages, handlers: handlers() })
    expect(await screen.findByText(/请从词级中心选择一个词/)).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/ads/terms/detail')).toBe(false)
  })

  it('趋势页签有图；没有逐日记录时写明原因', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    expect(await within(page).findByRole('img', { name: '词级趋势' })).toBeInTheDocument()
  })

  it('没有逐日记录：写“没有这个词的逐日记录”，不画图', async () => {
    mountApp({ url, pages, handlers: handlers(() => detailResponse({ trend: [] })) })
    const page = await screen.findByTestId('ad-term-detail')
    expect(await within(page).findByText(/没有这个词的逐日记录/)).toBeInTheDocument()
    expect(within(page).queryByRole('img', { name: '词级趋势' })).toBeNull()
  })

  it('投放关系：活动、广告组、投放词、匹配方式、该活动里的状态与指标', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '投放关系' }))
    const relations = await screen.findByTestId('term-relations')
    expect(relations).toHaveTextContent('春季推广')
    expect(relations).toHaveTextContent('核心词组')
    expect(relations).toHaveTextContent('BROAD')
    expect(relations).toHaveTextContent('已投放')
    expect(relations).toHaveTextContent('$150.00')
  })

  it('投放与否定记录：类型、竞价、状态', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '投放与否定记录' }))
    const targeting = await screen.findByTestId('term-targeting')
    expect(targeting).toHaveTextContent('关键词')
    expect(targeting).toHaveTextContent('EXACT')
    expect(targeting).toHaveTextContent('$1.20')
  })

  it('建议与历史：规则建议；历史调价的前后效果，没有数据写“尚无记录”', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '建议与历史' }))
    const advice = await screen.findByTestId('term-advice')
    expect(advice).toHaveTextContent('提高竞价')
    expect(advice).toHaveTextContent('可以小幅提高竞价扩量')
    const history = screen.getByTestId('term-history')
    expect(history).toHaveTextContent('王运营')
    expect(history).toHaveTextContent('$1.00')
    expect(history).toHaveTextContent('$1.20')
    expect(history).toHaveTextContent('7 天里有 7 天有数据')
    expect(within(history).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
    expect(history).toHaveTextContent('效果对照不是因果结论')
  })

  it('没有建议、没有历史：如实写明', async () => {
    mountApp({ url, pages, handlers: handlers(() => detailResponse({ advice: [], history: { state: 'NO_DATA', note: '本系统内还没有对这个词的投放对象调过价。', items: [], truncated: false } })) })
    const page = await screen.findByTestId('ad-term-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '建议与历史' }))
    expect(await screen.findByText(/当前数据没有命中任何建议规则/)).toBeInTheDocument()
    expect((await screen.findAllByText(/还没有对这个词的投放对象调过价/)).length).toBeGreaterThan(0)
  })

  it('品牌分析：brand 为空时没有这个页签；有数据时才出现', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ad-term-detail')
    await within(page).findByText('yoga mat')
    expect(within(page).queryByRole('tab', { name: '品牌分析' })).toBeNull()
  })

  it('品牌分析：接口返回数据后出现页签，空份额写“尚无记录”', async () => {
    mountApp({
      url,
      pages,
      handlers: handlers(() => detailResponse({ brand: { searchVolume: 12000, clickShare: 0.18, purchaseShare: null, periodText: '2026 年第 41 周', sourceUpdatedAt: '2026-10-20T08:00:00.000Z' } })),
    })
    const page = await screen.findByTestId('ad-term-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '品牌分析' }))
    const brand = await screen.findByTestId('term-brand')
    expect(brand).toHaveTextContent('12,000')
    expect(brand).toHaveTextContent('18.0%')
    expect(brand).toHaveTextContent('2026 年第 41 周')
    expect(within(brand).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(1)
  })

  it('没有任何记录的词：指标写“尚无记录”，不写 0；写亚马逊的动作禁用', async () => {
    mountApp({
      url,
      pages,
      handlers: handlers(() =>
        detailResponse({
          status: null,
          campaigns: { total: 0, targeted: 0, negated: 0 },
          totals: null,
          ratios: null,
          anomalies: [],
          trend: [],
          relations: { items: [], truncated: false },
          targeting: { state: 'NO_DATA', note: null, items: [] },
          advice: [],
        }),
      ),
    })
    const page = await screen.findByTestId('ad-term-detail')
    await within(page).findByText('yoga mat')
    expect(within(page).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(6)
    expect(page).not.toHaveTextContent('$0.00')
    for (const name of ['加为否定词', '加为关键词', '调整竞价']) expect(within(page).getByRole('button', { name })).toBeDisabled()
  })

  it('整体没有数据（词不存在）：写明状态与原因并给返回链接', async () => {
    mountApp({
      url,
      pages,
      handlers: handlers(() =>
        detailResponse({
          state: 'NOT_CONNECTED',
          note: '词级报表还没有同步',
          status: null,
          totals: null,
          ratios: null,
          anomalies: [],
          trend: [],
          relations: { items: [], truncated: false },
          targeting: { state: 'NOT_CONNECTED', note: null, items: [] },
          advice: [],
        }),
      ),
    })
    expect(await screen.findByText(/词级报表还没有同步/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回词级中心' })).toBeInTheDocument()
  })

  it('读取失败：显示错误', async () => {
    mountApp({ url, pages, handlers: { '/ads/terms/detail': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
  }, 30_000)
})
