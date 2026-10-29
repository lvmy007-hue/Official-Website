import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ASIN_COMPARE_MAX } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { asinAnalytics, ok, selectionOf, values, PARENT } from './asin-analytics-fixtures.test-helper'
import { buildSelectionOption, formatAsin, heatColor } from './asin-analytics-options'
import { rowTextById } from '../../test/grid-rows'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// ASIN 与父体分析页（P4-03）：左侧父体树（销售额从高到低、展开子体、勾选最多 5 个）、右侧趋势与范围合计、筛选与翻页、
// 没有值写“尚无记录”、没有库存读取权限就不显示库存风险筛选。

const pages: LivePages = {
  AsinAnalyticsPage: { load: () => import('./AsinAnalyticsPage') },
  ParentAsinDetailPage: { load: () => Promise.resolve({ default: () => null }) },
  Asin360Page: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/analytics/asins?from=2026-10-08&to=2026-10-10'
const API = '/analytics/asins'
const T = { timeout: 30000 }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [API]: () => ok(asinAnalytics()),
  ...over,
})
const listCalls = (app: ReturnType<typeof mountApp>) => app.calls.filter(call => call.path === API).map(call => new URLSearchParams(call.search))
const lastCall = (app: ReturnType<typeof mountApp>) => listCalls(app).slice(-1)[0]!

describe('父体树', () => {
  it('按销售额从高到低排列；父体显示子体数，单个 ASIN 显示“单个 ASIN”；没有值写“尚无记录”', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const nodes = await screen.findAllByTestId('asin-tree-node', {}, { timeout: 15000 })
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toHaveTextContent('单品台灯')
    expect(nodes[0]).toHaveTextContent('单个 ASIN')
    expect(nodes[0]).toHaveTextContent('$500.00')
    expect(nodes[1]).toHaveTextContent(`父体 ${PARENT}`)
    expect(nodes[1]).toHaveTextContent('父体 · 2 个子体')
    expect(nodes[1]).toHaveTextContent('会话 尚无记录')
    expect(screen.getByTestId('asin-issue-note')).toBeInTheDocument()
  })

  it('展开子体能看到每个子体；没有目录记录的子体写明，不当成有名字', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('button', { name: `展开 ${PARENT} 的子体` }, { timeout: 15000 }))
    const children = screen.getAllByTestId('asin-tree-child')
    expect(children).toHaveLength(2)
    expect(children[0]).toHaveTextContent('红色大号')
    expect(children[1]).toHaveTextContent('目录里没有这个 ASIN')
    await userEvent.click(screen.getByRole('button', { name: `收起 ${PARENT} 的子体` }))
    expect(screen.queryAllByTestId('asin-tree-child')).toHaveLength(0)
  })

  it('没有符合条件的对象时写明，而不是空白', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [API]: () => ok(asinAnalytics({ tree: [], selection: [], selectionDefaulted: false })) }) })
    expect(await screen.findByText('没有符合条件的父体或 ASIN', {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('选择与对比', () => {
  it('没有选中时默认选最高的一项并提示；范围合计里没值的指标写“尚无记录”，说明原因', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    expect(await screen.findByTestId('asin-defaulted', {}, { timeout: 15000 })).toHaveTextContent('已默认选中销售额最高的一项')
    expect(screen.getByTestId('asin-chosen')).toHaveTextContent('ASIN B0SINGLE01 · 商品 B0SINGLE01')
    const table = screen.getByTestId('asin-selection-table')
    await within(table).findByText('广告销售')
    expect(rowTextById('adsSales')).toContain('尚无记录')
    expect(within(table).getByTestId('asin-gaps')).toHaveTextContent('广告销售')
    expect(screen.getByRole('img', { name: 'ASIN 与父体逐日趋势图' })).toBeInTheDocument()
    const first = lastCall(app)
    expect(first.get('from')).toBe('2026-10-08')
    expect(first.get('to')).toBe('2026-10-10')
    expect(first.get('pageSize')).toBe('20')
    expect(first.has('select')).toBe(false)
  })

  it('再勾选一个对象就进入对比模式，请求带上选择；取消勾选回到单个对象', T, async () => {
    const calls: string[] = []
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        [API]: url => {
          const select = url.searchParams.get('select')
          calls.push(select ?? '')
          if (!select) return ok(asinAnalytics())
          const picked = select.split(',').map(key => selectionOf(key.startsWith('parent') ? 'parent' : 'asin', key.split(':')[1]!))
          return ok(asinAnalytics({ selectionDefaulted: false, selection: picked }))
        },
      }),
    })
    await userEvent.click(await screen.findByRole('checkbox', { name: `选择 ${PARENT}` }, { timeout: 15000 }))
    await waitFor(() => expect(lastCall(app).get('select')).toBe(`asin:B0SINGLE01,parent:${PARENT}`))
    expect(await screen.findByText('对比模式：只对比下方选择的主指标')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'ASIN 与父体逐日趋势图' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '趋势次指标' })).not.toBeInTheDocument()
    expect(screen.getByTestId('asin-chosen')).toHaveTextContent(`父体 ${PARENT} · 3 个子体`)
    await userEvent.click(screen.getByRole('checkbox', { name: `选择 ${PARENT}` }))
    await waitFor(() => expect(lastCall(app).get('select')).toBe('asin:B0SINGLE01'))
    expect(calls.slice(-1)[0]).toBe('asin:B0SINGLE01')
  })

  it(`最多同时对比 ${ASIN_COMPARE_MAX} 个：满了以后其余对象不能再勾选`, T, async () => {
    const asins = ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3', 'B0AAAAAAA4', 'B0AAAAAAA5']
    const tree = [...asins, 'B0AAAAAAA6'].map(asin => ({ key: `asin:${asin}`, kind: 'asin' as const, asin, title: asin, brand: null, childCount: 0, sales: 10, sessions: 20, children: [] }))
    const full = asinAnalytics({ tree, selectionDefaulted: false, selection: asins.map(asin => selectionOf('asin', asin)) })
    mountApp({ url: PAGE, pages, handlers: handlers({ [API]: () => ok(full) }) })
    expect(await screen.findByRole('checkbox', { name: '选择 B0AAAAAAA6' }, { timeout: 15000 })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '选择 B0AAAAAAA1' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: '选择 B0AAAAAAA1' })).toBeChecked()
  })

  it('只选中一个对象时它不能被取消勾选', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    expect(await screen.findByRole('checkbox', { name: '选择 B0SINGLE01' }, { timeout: 15000 })).toBeDisabled()
  })

  it('所选对象在所选范围内没有这个指标的值时，图表区写明原因', T, async () => {
    const empty = selectionOf('asin', 'B0SINGLE01', { points: [{ date: '2026-10-08', ...values() }], gaps: { sales: '这个 ASIN 在所选范围内没有销售与流量记录' } })
    mountApp({ url: PAGE, pages, handlers: handlers({ [API]: () => ok(asinAnalytics({ selection: [empty] })) }) })
    expect((await screen.findAllByText(/这个 ASIN 在所选范围内没有销售与流量记录/, {}, { timeout: 15000 })).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('img', { name: 'ASIN 与父体逐日趋势图' })).not.toBeInTheDocument()
  })
})

describe('筛选与翻页', () => {
  it('搜索关键词与下拉筛选都进请求；改筛选回到第一页', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    const box = await screen.findByRole('searchbox', { name: '搜索' }, { timeout: 15000 })
    await userEvent.type(box, '台灯{Enter}')
    await waitFor(() => expect(lastCall(app).get('q')).toBe('台灯'))
    await userEvent.click(screen.getByRole('combobox', { name: '品牌' }))
    await userEvent.click(await screen.findByText('甲牌', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(lastCall(app).get('brand')).toBe('甲牌'))
    expect(lastCall(app).get('q')).toBe('台灯')
    expect(lastCall(app).has('cursor')).toBe(false)
  })

  it('库存风险筛选只有拥有库存读取权限才出现', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['analytics.read']) })
    await screen.findByRole('combobox', { name: '品牌' }, { timeout: 15000 })
    expect(screen.queryByRole('combobox', { name: '库存风险' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '刊登问题' })).toBeInTheDocument()
  })

  it('有下一页时翻页带上游标，并能回到上一页', T, async () => {
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        [API]: url => ok(asinAnalytics({ pageInfo: { pageSize: 20, nextCursor: url.searchParams.get('cursor') ? null : 'c1', hasMore: !url.searchParams.get('cursor'), approxTotal: 25 } })),
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '下一页' }, { timeout: 15000 }))
    await waitFor(() => expect(lastCall(app).get('cursor')).toBe('c1'))
    expect(await screen.findByText('第 2 页，共约 25 条')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(await screen.findByText('第 1 页，共约 25 条')).toBeInTheDocument()
  })

  it('接口失败时写明，不显示空表', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ [API]: () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    await waitFor(() => expect(screen.queryByTestId('asin-tree')).not.toBeInTheDocument(), { timeout: 15000 })
    expect((await screen.findAllByText(/服务暂时不可用/)).length).toBeGreaterThanOrEqual(1)
  })
})

describe('图表选项与格式', () => {
  it('formatAsin：金额带符号、百分比、天数；整数用千分位', () => {
    expect(formatAsin('sales', 1234.5)).toBe('$1,234.50')
    expect(formatAsin('conversion', 0.0512)).toContain('5.1')
    expect(formatAsin('units', 1200)).toBe('1,200')
  })

  it('heatColor：没有值或没有量程不着色；有量程按高低着色', () => {
    expect(heatColor(null, { min: 0, max: 10 })).toBeUndefined()
    expect(heatColor(5, null)).toBeUndefined()
    expect(heatColor(10, { min: 0, max: 10 })).not.toBe(heatColor(0, { min: 0, max: 10 }))
  })

  it('buildSelectionOption：单个对象可叠加次指标；缺失的天保持为 null（图上断开），不画成 0', () => {
    const one = selectionOf('asin', 'B0SINGLE01')
    const option = buildSelectionOption([one], 'sales', 'sessions') as { series: Array<{ data: Array<number | null> }> }
    expect(option.series).toHaveLength(2)
    expect(option.series[0]!.data).toEqual([null, 150, 50])
    const compare = buildSelectionOption([one, selectionOf('parent', PARENT)], 'sales', 'sessions') as { series: unknown[] }
    expect(compare.series).toHaveLength(2)
  })
})
