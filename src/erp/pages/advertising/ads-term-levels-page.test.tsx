import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { countsResponse, rowText } from './ads-campaigns-fixtures.test-helper'
import { emptyShell, searchResponse, searchRows, targetRows, targetsResponse, termHandlers } from './ad-terms-fixtures.test-helper'

// 投放与搜索词列表（P6-23，统一骨架）：数据沿用词级接口 /ads/terms?tab=…；分类计数走 /ads/:level/counts；汇总行取服务端汇总。
// 验证：指标与“尚无记录”（不写 0）、固定的 tab 参数、点分类带上 bucket、投放行有对象编号才能看趋势（没有则置灰并写原因）、搜索词的分析列置灰并写原因、没有数据时的说明。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsTargetsPage: { load: () => import('./AdsTargetsPage') },
  AdsSearchTermsPage: { load: () => import('./AdsSearchTermsPage') },
}
afterEach(() => vi.unstubAllGlobals())

const listCalls = (calls: Array<{ path: string; search: string }>) => calls.filter(call => call.path === '/ads/terms' && new URLSearchParams(call.search).get('pageSize') !== '1')
const withCounts = (handlers: ReturnType<typeof termHandlers>) => ({
  ...handlers,
  '/ads/targets/counts': () => ok(countsResponse({ level: 'targets', total: 5, withoutMetrics: 0, buckets: { CONVERTED: 3, CLICK_NO_ORDER: 2, IMPRESSION_NO_CLICK: 0, NO_IMPRESSION: 0 } })),
  '/ads/search-terms/counts': () => ok(countsResponse({ level: 'search-terms', total: 4, withoutMetrics: 0, buckets: { CONVERTED: 2, CLICK_NO_ORDER: 1, IMPRESSION_NO_CLICK: 1, NO_IMPRESSION: 0 } })),
})

describe('投放列表（统一骨架）', () => {
  const url = '/app/advertising/targets'
  const withEntity = () => targetsResponse({ items: targetRows().map((row, index) => (index === 0 ? { ...row, entityId: 'kw-sys-1' } : row)) })

  it('固定带 tab=targets；有指标显示美元与比率，没有的投放词写“尚无记录”', async () => {
    const app = mountApp({ url, pages, handlers: withCounts(termHandlers({ targets: withEntity })) })
    const page = await screen.findByTestId('ads-targets-page')
    expect(await within(page).findByRole('link', { name: 'yoga mat' })).toHaveAttribute('href', expect.stringContaining('/app/ad-terms/detail'))
    expect(listCalls(app.calls).every(call => new URLSearchParams(call.search).get('tab') === 'targets')).toBe(true)
    const first = rowText('k1')
    for (const text of ['$40.00', '$150.00', '春季推广', 'EXACT']) expect(first).toContain(text)
    const second = rowText('k2')
    expect(second).toContain('asin="B0XYZ"')
    expect(second).toContain('尚无记录')
  })

  it('分类计数来自 /ads/targets/counts；点一类带上 bucket', async () => {
    const app = mountApp({ url, pages, handlers: withCounts(termHandlers({ targets: withEntity })) })
    const chips = await screen.findByTestId('ads-bucket-chips')
    expect(await within(chips).findByText('有成交 3')).toBeInTheDocument()
    await userEvent.click(within(chips).getByText('有点击无成交 2'))
    await vi.waitFor(() => expect(listCalls(app.calls).some(call => new URLSearchParams(call.search).get('bucket') === 'CLICK_NO_ORDER')).toBe(true))
  })

  it('末列分析：有对象编号的行可点开趋势，没有的行置灰', async () => {
    mountApp({
      url,
      pages,
      handlers: withCounts({ ...termHandlers({ targets: withEntity }), '/ads/targets/kw-sys-1/trend': () => ok({ state: 'NO_DATA', note: '没有趋势记录', points: [] }) }),
    })
    const page = await screen.findByTestId('ads-targets-page')
    await within(page).findByRole('link', { name: 'yoga mat' })
    expect(within(page).getAllByRole('button', { name: '查看趋势' })).toHaveLength(1)
    expect(within(page).getAllByRole('button', { name: '分析（不可用）' })).toHaveLength(1)
  })

  it('汇总行取服务端汇总请求（pageSize=1）', async () => {
    const app = mountApp({ url, pages, handlers: withCounts(termHandlers({ targets: withEntity })) })
    await within(await screen.findByTestId('ads-targets-page')).findByRole('link', { name: 'yoga mat' })
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/terms' && new URLSearchParams(call.search).get('pageSize') === '1')).toBe(true))
  })

  it('词级报表还没有同步：写明原因，不画示例行', async () => {
    mountApp({ url, pages, handlers: withCounts(termHandlers({ targets: () => targetsResponse({ ...emptyShell }) })) })
    expect((await screen.findAllByText(/词级报表还没有同步/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('yoga mat')).toBeNull()
  })
})

describe('搜索词列表（统一骨架）', () => {
  const url = '/app/advertising/search-terms'

  it('固定带 tab=search-terms；状态、异常、覆盖数显示；没有广告销售额的词写“尚无记录”，不写 0', async () => {
    const app = mountApp({ url, pages, handlers: withCounts(termHandlers()) })
    const page = await screen.findByTestId('ads-search-terms-page')
    await within(page).findByRole('link', { name: 'yoga mat' })
    expect(listCalls(app.calls).every(call => new URLSearchParams(call.search).get('tab') === 'search-terms')).toBe(true)
    const free = rowText('free yoga')
    for (const text of ['高花费无成交', '$30.00']) expect(free).toContain(text)
    expect(free).toContain('尚无记录')
  })

  it('分析列置灰并写明原因（搜索词没有对象级趋势）', async () => {
    mountApp({ url, pages, handlers: withCounts(termHandlers()) })
    const page = await screen.findByTestId('ads-search-terms-page')
    await within(page).findByRole('link', { name: 'yoga mat' })
    expect(within(page).getAllByRole('button', { name: '分析（不可用）' })).toHaveLength(searchRows().length)
  })

  it('合并成“其他”的花费与投放记录说明如实显示', async () => {
    mountApp({ url, pages, handlers: withCounts(termHandlers({ search: () => searchResponse({ undisclosedSpend: 12.5, targetingNote: '投放词记录还没有同步' }) })) })
    expect(await screen.findByText(/合并成“其他”的搜索词花费 12.50 美元/)).toBeInTheDocument()
    expect(screen.getByText('投放词记录还没有同步')).toBeInTheDocument()
  })

  it('点分类带上 bucket，计数请求不带分类', async () => {
    const app = mountApp({ url, pages, handlers: withCounts(termHandlers()) })
    const chips = await screen.findByTestId('ads-bucket-chips')
    await userEvent.click(await within(chips).findByText('有成交 2'))
    await vi.waitFor(() => expect(listCalls(app.calls).some(call => new URLSearchParams(call.search).get('bucket') === 'CONVERTED')).toBe(true))
    expect(app.calls.filter(call => call.path === '/ads/search-terms/counts').every(call => new URLSearchParams(call.search).get('bucket') === null)).toBe(true)
  })

  it('读取失败：不显示示例词', async () => {
    mountApp({ url, pages, handlers: { '/ads/terms': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', retryable: true } } }) } })
    const page = await screen.findByTestId('ads-search-terms-page')
    await vi.waitFor(() => expect(within(page).queryByText('yoga mat')).toBeNull())
  })
})
