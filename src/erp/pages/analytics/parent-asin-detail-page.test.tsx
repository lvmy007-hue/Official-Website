import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PARENT_TABS } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { occurrences, rowTextById, rowTextOf } from '../../test/grid-rows'
import { ads, changes, identity, inventory, matrix, ok, PARENT, reviews, traffic, trend } from './asin-analytics-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 父体详情页（P4-03）：身份区、七个页签（权限不足的页签不显示）、子体矩阵与变体属性透视、没有值与没接入的写法。

const pages: LivePages = {
  ParentAsinDetailPage: { load: () => import('./ParentAsinDetailPage') },
  Asin360Page: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = `/app/analytics/parents/${PARENT}?from=2026-10-08&to=2026-10-10`
const BASE = `/analytics/parents/${PARENT}`
const T = { timeout: 30000 }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  [BASE]: () => ok(identity()),
  [`${BASE}/matrix`]: () => ok(matrix()),
  [`${BASE}/trend`]: () => ok(trend()),
  [`${BASE}/traffic`]: () => ok(traffic()),
  [`${BASE}/inventory`]: () => ok(inventory()),
  [`${BASE}/ads`]: () => ok(ads()),
  [`${BASE}/reviews`]: () => ok(reviews()),
  [`${BASE}/changes`]: () => ok(changes()),
  ...over,
})
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }, { timeout: 15000 }))
const callsOf = (app: ReturnType<typeof mountApp>, path: string) => app.calls.filter(call => call.path === path).map(call => new URLSearchParams(call.search))

describe('身份区与页签', () => {
  it('身份区：子体数、销售额、转化率；净利润没有权限写“无权查看”，库存风险没配策略写“尚未接入”，都不是 0', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const box = await screen.findByTestId('identity', {}, { timeout: 15000 })
    expect(box).toHaveTextContent(`父体 ${PARENT}`)
    expect(box).toHaveTextContent('子体数')
    expect(box).toHaveTextContent('$200.00')
    expect(box).toHaveTextContent('5.0%')
    expect(box).toHaveTextContent('净利润')
    expect(box).toHaveTextContent('无权查看')
    expect(box).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('parent-identity-extra')).toHaveTextContent('变体维度：COLOR_SIZE')
    expect(screen.getByTestId('parent-identity-extra')).toHaveTextContent('美国主店')
  })

  it('身份区的金额没有记录时写“尚无记录”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [BASE]: () => ok(identity({ sales: null, conversion: null, brand: null, state: 'NO_DATA', note: '所选范围内没有销售与流量记录' })) }) })
    const box = await screen.findByTestId('identity', {}, { timeout: 15000 })
    expect(within(box).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('parent-identity-extra')).toHaveTextContent('目录未给出')
    expect(screen.getByText('所选范围内没有销售与流量记录')).toBeInTheDocument()
  })

  it('拥有全部权限时显示七个页签，只有被打开的页签才取数', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await screen.findByRole('tab', { name: '子体贡献矩阵' }, { timeout: 15000 })
    expect(screen.getAllByRole('tab')).toHaveLength(PARENT_TABS.length)
    await screen.findByTestId('parent-matrix-frame')
    expect(callsOf(app, `${BASE}/matrix`).length).toBeGreaterThan(0)
    expect(callsOf(app, `${BASE}/ads`)).toHaveLength(0)
    expect(callsOf(app, `${BASE}/inventory`)).toHaveLength(0)
  })

  it('没有库存读取与广告读取权限时，库存与补货、广告覆盖页签不显示', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['analytics.read']) })
    await screen.findByRole('tab', { name: '子体贡献矩阵' }, { timeout: 15000 })
    expect(screen.queryByRole('tab', { name: '库存与补货' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '广告覆盖' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(PARENT_TABS.length - 2)
  })

  it('父体不存在时写明，不渲染空页面', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [BASE]: () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '没有找到这个父体' } } }) }) })
    await waitFor(() => expect(screen.queryByTestId('identity')).not.toBeInTheDocument(), { timeout: 15000 })
    expect((await screen.findAllByText(/没有找到这个父体|不存在|NOT_FOUND/, {}, { timeout: 15000 })).length).toBeGreaterThanOrEqual(1)
  })
})

describe('子体贡献矩阵', () => {
  it('子体行：没有值写“尚无记录”，没有变体属性写“目录未给出”，没有目录记录的子体写明；库存风险没权限写“无权查看”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const frame = await screen.findByTestId('parent-matrix-frame', {}, { timeout: 15000 })
    const first = rowTextOf(await within(frame).findByText('B0CHILD001'))
    expect(first).toContain('color：Red')
    expect(first).toContain('$140.00')
    expect(first).toContain('70.0%')
    expect(first).toContain('无权查看')
    const last = rowTextOf(within(frame).getByText('B0CHILD004'))
    expect(last).toContain('目录里没有这个 ASIN')
    expect(last).toContain('目录未给出')
    expect(last).toContain('尚无记录')
  })

  it('变体属性透视：行列维度、单元格数值；没有属性的子体归到“未填写”；切换维度会重新取数', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    const pivot = await screen.findByTestId('parent-pivot', {}, { timeout: 15000 })
    expect(pivot).toHaveTextContent('变体属性透视')
    expect(within(pivot).getAllByText('L').length).toBeGreaterThanOrEqual(1)
    expect(within(pivot).getAllByText('未填写').length).toBeGreaterThanOrEqual(2)
    const red = rowTextById('Red')
    expect(red).toContain('$140.00')
    expect(red).toContain('$60.00')
    await userEvent.click(within(pivot).getByRole('combobox', { name: '透视行维度' }))
    await userEvent.click(await screen.findByText('size', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(callsOf(app, `${BASE}/matrix`).slice(-1)[0]!.get('pivot')).toBe('size,color'))
  })

  it('目录没有变体属性时，透视位置写“尚未接入”与原因，不猜测', T, async () => {
    const empty = matrix({ pivot: { state: 'NOT_CONNECTED', note: '商品目录同步后才有变体属性', dimensions: [], rowDim: null, colDim: null, rowValues: [], colValues: [], cells: [] } })
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${BASE}/matrix`]: () => ok(empty) }) })
    const note = await screen.findByTestId('parent-pivot-note', {}, { timeout: 15000 })
    expect(note).toHaveTextContent('尚未接入')
    expect(note).toHaveTextContent('商品目录同步后才有变体属性')
    expect(screen.queryByTestId('parent-pivot')).not.toBeInTheDocument()
  })

  it('切换着色指标为库存风险：请求带 metric，没有权限时写明原因', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await screen.findByTestId('parent-pivot', {}, { timeout: 15000 })
    await userEvent.click(screen.getByText('库存风险', { selector: '.ant-segmented-item-label' }))
    await waitFor(() => expect(callsOf(app, `${BASE}/matrix`).slice(-1)[0]!.get('metric')).toBe('risk'))
    expect(await screen.findByTestId('parent-risk-note')).toHaveTextContent('无权查看')
  })
})

describe('其他页签', () => {
  it('子体趋势：有数据时出图；全是空值时写明原因而不是画一条 0 线', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('子体趋势')
    expect(await screen.findByRole('img', { name: '父体名下子体逐日堆叠趋势图' })).toBeInTheDocument()
  })

  it('子体趋势没有任何记录时不出图', T, async () => {
    const none = {
      ...trend(),
      series: [{ asin: 'B0CHILD001', title: null, sales: [null, null, null], sessions: [null, null, null], units: [null, null, null] }],
      note: '所选范围内这些子体没有逐日记录',
    }
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${BASE}/trend`]: () => ok(none) }) })
    await openTab('子体趋势')
    expect(await screen.findByText(/所选范围内这些子体没有逐日记录/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '父体名下子体逐日堆叠趋势图' })).not.toBeInTheDocument()
  })

  it('流量分布：占比、没有会话的子体写“尚无记录”；有对比期时给出占比变化（个百分点）', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${BASE}/traffic`]: () => ok(traffic(true)) }) })
    await openTab('流量分布')
    const panel = await screen.findByRole('tabpanel')
    const row = rowTextOf(await within(panel).findByText('红色大号（B0CHILD001）'))
    expect(row).toContain('75.0%')
    expect(row).toContain('+15.0 个百分点')
    const empty = rowTextOf(within(panel).getByText('B0CHILD002'))
    expect(empty).toContain('尚无记录')
  })

  it('库存与补货：没配补货策略写“尚未接入”，没有补货建议写原因；没有的值写“尚无记录”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('库存与补货')
    expect(await screen.findByTestId('parent-policy-note')).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('parent-replenishment-note')).toHaveTextContent('还没有生成过补货建议')
    const row = rowTextOf(await within(screen.getByRole('tabpanel')).findByText(/^B0CHILD001/))
    expect(row).toContain('2 个 SKU')
    expect(row).toContain('30')
    expect(occurrences(row, '尚无记录')).toBeGreaterThanOrEqual(1)
  })

  it('广告覆盖：有数据时给出已覆盖与缺口数，“有销售无广告”打标；没有广告数据来源时整块写“尚未接入”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('广告覆盖')
    expect(await screen.findByTestId('parent-ads-covered')).toHaveTextContent('1')
    expect(screen.getByTestId('parent-ads-gap')).toHaveTextContent('1')
    expect(screen.getByText('有销售无广告')).toBeInTheDocument()
    expect(screen.getByTestId('parent-ads-basis')).toHaveTextContent('广告归因窗口')
  })

  it('广告没有接入时只写说明，不展示 0 与空表', T, async () => {
    const off = ads({ adsState: 'NOT_CONNECTED', adsNote: '还没有绑定广告账号', rows: [], coveredCount: 0, gapCount: 0, totalSpend: null, totalAdsSales: null })
    mountApp({ url: PAGE, pages, handlers: handlers({ [`${BASE}/ads`]: () => ok(off) }) })
    await openTab('广告覆盖')
    expect(await screen.findByTestId('parent-ads-note')).toHaveTextContent('尚未接入：还没有绑定广告账号')
    expect(screen.queryByTestId('parent-ads-covered')).not.toBeInTheDocument()
  })

  it('评论主题：尚未接入，写明由哪个工作包交付，不编造主题', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('评论主题')
    expect(await screen.findByTestId('parent-reviews-note')).toHaveTextContent('尚未接入')
    expect(screen.getByTestId('parent-reviews-note')).toHaveTextContent('P4-13')
    expect(screen.getByText('暂无评论主题')).toBeInTheDocument()
  })

  it('变体结构变更历史：按时间倒序，写类型、前后值；没有记录时写原因', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('变体结构变更历史')
    const frame = await screen.findByTestId('parent-changes')
    const first = await within(frame).findByText('变体属性变化')
    expect(first.closest('[row-index]')?.getAttribute('row-index')).toBe('0')
    expect(rowTextOf(first)).toContain('Red → Rose')
    const second = within(frame).getByText('新增子体')
    expect(second.closest('[row-index]')?.getAttribute('row-index')).toBe('1')
    expect(rowTextOf(second)).toContain(`无 → ${PARENT}`)
  })

  it('变体结构变更历史没有记录时写明原因', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        [`${BASE}/changes`]: () => ok(changes({ items: [], note: '变更记录从第二次商品目录同步起才有', pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 0 } })),
      }),
    })
    await openTab('变体结构变更历史')
    expect(await screen.findByText(/变更记录从第二次商品目录同步起才有/)).toBeInTheDocument()
  })
})
