import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { emptyShell, negativesResponse, quadrantResponse, rootsResponse, searchResponse, targetsResponse, termHandlers } from './ad-terms-fixtures.test-helper'

// 词级中心（P3-10）：假服务端返回固定数据，验证 5 个页签各自的列与请求、异常分组筛选、不适用的筛选在切换页签时被丢掉、
// 空值写“尚无记录”（不写 0）、没有数据与读取失败的写法、保存视图的保存与应用、写亚马逊的按钮禁用并说明原因。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdTermsPage: { load: () => import('./AdTermsPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/ad-terms'
const rowOf = async (page: HTMLElement, text: string) => (await within(page).findByText(text)).closest('tr, [role=row]') as HTMLElement
const open = async (app: ReturnType<typeof mountApp>, tab: string) => {
  const page = await screen.findByTestId('ad-terms-page')
  fireEvent.click(within(page).getByRole('tab', { name: tab }))
  return { page, app }
}
const paramsOf = (app: ReturnType<typeof mountApp>, predicate: (params: URLSearchParams) => boolean) =>
  app.calls.filter(call => call.path.startsWith('/ads/terms') && predicate(new URLSearchParams(call.search))).map(call => new URLSearchParams(call.search))

describe('词级中心：投放对象', () => {
  it('默认是投放对象页签：词链到词级分析页，竞价与状态、没有同步的写“尚无记录”', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const page = await screen.findByTestId('ad-terms-page')
    const first = await rowOf(page, 'yoga mat')
    expect(within(first).getByRole('link', { name: 'yoga mat' })).toHaveAttribute('href', expect.stringMatching(/\/app\/ad-terms\/detail\?.*term=yoga(\+|%20)mat/))
    expect(first).toHaveTextContent('EXACT')
    expect(first).toHaveTextContent('春季推广')
    expect(first).toHaveTextContent('$1.20')
    expect(first).toHaveTextContent('启用中')
    expect(first).toHaveTextContent('$150.00')
    const second = await rowOf(page, 'asin="B0XYZ"')
    expect(second).toHaveTextContent('C-2')
    expect(within(second).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(3)
    expect(second).not.toHaveTextContent('$0.00')
    expect(paramsOf(app, params => params.get('tab') === 'targets' && params.get('sort') === 'spend:desc')).not.toHaveLength(0)
  })

  it('异常分组芯片带计数；点击后按该分组筛选，再点取消；口径与规则常驻', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const page = await screen.findByTestId('ad-terms-page')
    await rowOf(page, 'yoga mat')
    const summary = await screen.findByTestId('term-summary')
    expect(summary).toHaveTextContent('共 2 个词')
    expect(summary).toHaveTextContent('高花费无成交 1')
    expect(summary).toHaveTextContent('低广告成本销售比可扩量 0')
    expect(within(summary).queryByText(/高转化可加词/)).toBeNull()
    expect(summary).toHaveTextContent('分组规则（自定默认值，不是亚马逊口径）')
    fireEvent.click(within(summary).getByText(/高花费无成交 \d/))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('anomaly') === 'HIGH_SPEND_NO_ORDER')).not.toHaveLength(0))
    expect(await screen.findByTestId('term-basis')).toHaveTextContent('投放对象指标来自词级报表的投放层')
  })

  it('写亚马逊的调价按钮禁用', async () => {
    mountApp({ url, pages, handlers: termHandlers() })
    const page = await screen.findByTestId('ad-terms-page')
    const first = await rowOf(page, 'yoga mat')
    expect(within(first).getByRole('button', { name: '调整竞价' })).toBeDisabled()
  })
})

describe('词级中心：搜索词', () => {
  it('状态、异常标签、销售额为空写“尚无记录”；添加关键词与否定按钮禁用', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '搜索词')
    const free = await rowOf(page, 'free yoga')
    expect(free).toHaveTextContent('未投放')
    expect(free).toHaveTextContent('高花费无成交')
    expect(free).toHaveTextContent('否定候选')
    expect(within(free).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(free).not.toHaveTextContent('$0.00')
    expect(within(free).getByRole('button', { name: '添加为关键词' })).toBeDisabled()
    expect(within(free).getByRole('button', { name: '添加否定' })).toBeDisabled()
    expect(await rowOf(page, 'old term')).toHaveTextContent('已否定')
    expect(await rowOf(page, 'yoga mat')).toHaveTextContent('已投放')
    expect(paramsOf(app, params => params.get('tab') === 'search-terms')).not.toHaveLength(0)
  })

  it('各分组芯片：搜索词页签四个分组都有，计数来自服务端', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    await open(app, '搜索词')
    const summary = await screen.findByTestId('term-summary')
    for (const text of ['高花费无成交 1', '低广告成本销售比可扩量 1', '高转化可加词 1', '否定候选 1']) expect(summary).toHaveTextContent(text)
  })

  it('“其他”合并花费与投放记录没同步的说明如实显示', async () => {
    const app = mountApp({
      url,
      pages,
      handlers: termHandlers({ search: () => searchResponse({ undisclosedSpend: 12.5, targetingNote: '否定词记录尚未同步，“未投放”不代表真的没有投放' }) }),
    })
    await open(app, '搜索词')
    expect(await screen.findByTestId('term-undisclosed')).toHaveTextContent('12.50 美元')
    expect(screen.getByTestId('term-targeting-note')).toHaveTextContent('否定词记录尚未同步')
  })

  it('状态筛选随请求带出；切换到不适用的页签时丢掉，保留适用的异常分组与关键字', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '搜索词')
    await rowOf(page, 'free yoga')
    fireEvent.mouseDown(within(page).getByRole('combobox', { name: '搜索词状态' }))
    fireEvent.click(await screen.findByText('已投放', { selector: '.ant-select-item-option-content' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('status') === 'TARGETED')).not.toHaveLength(0))
    fireEvent.click(await within(await screen.findByTestId('term-summary')).findByText(/高花费无成交 \d/))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('status') === 'TARGETED' && params.get('anomaly') === 'HIGH_SPEND_NO_ORDER')).not.toHaveLength(0))
    fireEvent.click(within(page).getByRole('tab', { name: '投放对象' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('tab') === 'targets' && params.get('anomaly') === 'HIGH_SPEND_NO_ORDER')).not.toHaveLength(0))
    expect(paramsOf(app, params => params.get('tab') === 'targets' && params.has('status'))).toHaveLength(0)
    fireEvent.click(within(page).getByRole('tab', { name: '否定词库' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('tab') === 'negatives')).not.toHaveLength(0))
    expect(paramsOf(app, params => params.get('tab') === 'negatives' && (params.has('anomaly') || params.has('status')))).toHaveLength(0)
  })

  it('关键字与排序方向随请求带出', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '搜索词')
    await rowOf(page, 'free yoga')
    fireEvent.click(within(page).getByRole('button', { name: '排序方向' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('tab') === 'search-terms' && params.get('sort') === 'spend:asc')).not.toHaveLength(0))
    const search = within(page).getByRole('searchbox', { name: '关键字' })
    fireEvent.change(search, { target: { value: 'yoga' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('q') === 'yoga')).not.toHaveLength(0))
  })

  it('翻页：带着服务端给的游标重新请求', async () => {
    const app = mountApp({
      url,
      pages,
      handlers: termHandlers({
        search: requestUrl =>
          requestUrl.searchParams.get('cursor')
            ? searchResponse({ items: [searchResponse().items[3]!].map(row => ({ ...row, key: 'zzz', searchTerm: 'zzz term' })) })
            : searchResponse({ pageInfo: { pageSize: 50, nextCursor: 'cursor-2', hasMore: true, approxTotal: 5 } }),
      }),
    })
    const { page } = await open(app, '搜索词')
    await rowOf(page, 'free yoga')
    fireEvent.click(within(page).getByRole('button', { name: /下一页/ }))
    expect(await within(page).findByText('zzz term')).toBeInTheDocument()
    expect(paramsOf(app, params => params.get('cursor') === 'cursor-2')).not.toHaveLength(0)
  })

  it('没有同步词级报表：写明原因，不画示例行也没有汇总条', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ search: () => searchResponse({ ...emptyShell, summary: searchResponse({ items: [] }).summary }) }) })
    await open(app, '搜索词')
    expect(await screen.findByText(/词级报表还没有同步/)).toBeInTheDocument()
    expect(screen.queryByText('yoga mat')).toBeNull()
    expect(screen.queryByTestId('term-summary')).toBeNull()
  })

  it('读取上限：如实提示', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ search: () => searchResponse({ truncated: true }) }) })
    await open(app, '搜索词')
    expect(await screen.findByText(/报表分组数超过读取上限/)).toBeInTheDocument()
  })
})

describe('词级中心：否定词库、四象限、词根分析', () => {
  it('否定词库：层级、匹配方式、没有活动名称时写编号、否定只能按词排序', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '否定词库')
    const first = await rowOf(page, 'free')
    expect(first).toHaveTextContent('活动级')
    expect(first).toHaveTextContent('NEGATIVE_PHRASE')
    expect(first).toHaveTextContent('春季推广')
    const second = await rowOf(page, 'cheap')
    expect(second).toHaveTextContent('广告组级')
    expect(second).toHaveTextContent('核心词组')
    expect(second).toHaveTextContent('美国账户（未绑定店铺）')
    expect(within(first).getByRole('button', { name: '移除否定' })).toBeDisabled()
    expect(paramsOf(app, params => params.get('tab') === 'negatives' && params.get('sort') === 'term:asc')).not.toHaveLength(0)
    expect(within(page).queryByRole('combobox', { name: '排序' })).toBeNull()
  })

  it('否定词库的层级与匹配方式筛选随请求带出', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '否定词库')
    await rowOf(page, 'free')
    fireEvent.mouseDown(within(page).getByRole('combobox', { name: '否定层级' }))
    fireEvent.click(await screen.findByText('广告组级', { selector: '.ant-select-item-option-content' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('level') === 'AD_GROUP')).not.toHaveLength(0))
    const match = within(page).getByRole('searchbox', { name: '匹配方式' })
    fireEvent.change(match, { target: { value: 'NEGATIVE_EXACT' } })
    fireEvent.keyDown(match, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('matchType') === 'NEGATIVE_EXACT' && params.get('level') === 'AD_GROUP')).not.toHaveLength(0))
  })

  it('四象限：图、各象限个数、没有广告销售额的词单独说明', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    await open(app, '四象限')
    const quadrant = await screen.findByTestId('term-quadrant')
    expect(within(quadrant).getByRole('img', { name: '词级四象限' })).toBeInTheDocument()
    expect(quadrant).toHaveTextContent('高花费低 ACoS（保持）：1 个')
    expect(quadrant).toHaveTextContent('另有 2 个词有花费但没有广告销售额（合计花费 33.00 美元）')
    expect(paramsOf(app, params => params.get('tab') === 'quadrant' && params.get('subject') === 'search-terms' && !params.has('sort'))).not.toHaveLength(0)
  })

  it('四象限：切换对象、选异常分组；点数被截断时说明', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ quadrant: () => quadrantResponse({ truncated: true, total: 500 }) }) })
    const { page } = await open(app, '四象限')
    expect(await screen.findByText(/共 500 个点，图上只画花费最高的 2 个/)).toBeInTheDocument()
    fireEvent.mouseDown(within(page).getByRole('combobox', { name: '四象限对象' }))
    fireEvent.click(await screen.findByText('投放词', { selector: '.ant-select-item-option-content' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('tab') === 'quadrant' && params.get('subject') === 'targets')).not.toHaveLength(0))
    fireEvent.mouseDown(within(page).getByRole('combobox', { name: '异常分组' }))
    const options = await screen.findAllByText(/可扩量/, { selector: '.ant-select-item-option-content' })
    expect(options).toHaveLength(1)
    fireEvent.click(options[0]!)
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('subject') === 'targets' && params.get('anomaly') === 'SCALE_UP')).not.toHaveLength(0))
  })

  it('四象限没有数据：写明原因，不画图', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ quadrant: () => quadrantResponse({ state: 'NO_DATA', note: '没有可画的词', points: [] }) }) })
    await open(app, '四象限')
    expect(await screen.findByText(/没有可画的词/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '词级四象限' })).toBeNull()
  })

  it('词根分析：走独立接口，写法与例子词，口径与词数说明', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers() })
    const { page } = await open(app, '词根分析')
    const mat = await rowOf(page, 'mat')
    expect(mat).toHaveTextContent('写法：mat、mats')
    expect(within(mat).getByRole('link', { name: 'yoga mat' })).toBeInTheDocument()
    expect(screen.getByTestId('term-notes')).toHaveTextContent('共分析 4 个不同的搜索词')
    expect(screen.getByTestId('term-basis')).toHaveTextContent('词根之间不能相加')
    expect(app.calls.some(call => call.path === '/ads/terms/roots' && new URLSearchParams(call.search).get('sort') === 'spend:desc')).toBe(true)
    fireEvent.mouseDown(within(page).getByRole('combobox', { name: '排序' }))
    fireEvent.click(await screen.findByText('按搜索词数', { selector: '.ant-select-item-option-content' }))
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/terms/roots' && new URLSearchParams(call.search).get('sort') === 'terms:desc')).toBe(true))
  })
})

describe('词级中心：保存视图与读取失败', () => {
  const saved = {
    id: 'v1',
    name: '否定复查',
    mine: true,
    version: 2,
    filter: { tab: 'negatives', level: 'AD_GROUP', matchType: 'NEGATIVE_EXACT', sort: 'term', dir: 'desc', anomaly: 'SPEND_ALL', status: 'TARGETED' },
  }

  it('应用保存的视图：还原页签与适用的筛选，认不出的字段丢弃', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ views: () => ok({ items: [saved], limit: 20 }) }) })
    const page = await screen.findByTestId('ad-terms-page')
    const views = within(page).getByRole('combobox', { name: '保存的视图' })
    await vi.waitFor(() => expect(views.closest('.ant-select')).not.toHaveClass('ant-select-disabled'))
    fireEvent.mouseDown(views)
    fireEvent.click(await screen.findByText('否定复查', { selector: '.ant-select-item-option-content' }))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('tab') === 'negatives' && params.get('level') === 'AD_GROUP' && params.get('sort') === 'term:desc')).not.toHaveLength(0))
    expect(paramsOf(app, params => params.get('tab') === 'negatives' && (params.has('status') || params.has('anomaly')))).toHaveLength(0)
    expect(within(page).getByRole('tab', { name: '否定词库' })).toHaveAttribute('aria-selected', 'true')
  })

  it('保存当前视图：新名称创建，同名覆盖自己的旧视图', async () => {
    const bodies: Array<{ method: string; body: Record<string, unknown> }> = []
    const views = (_url: URL, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') bodies.push({ method: init.method, body: JSON.parse(String(init.body)) })
      return ok(init?.method === 'POST' || init?.method === 'PATCH' ? { id: 'v2' } : { items: [saved], limit: 20 })
    }
    const app = mountApp({ url, pages, handlers: { ...termHandlers(), '/views': views, '/views/v1': views } })
    const page = await screen.findByTestId('ad-terms-page')
    fireEvent.click(within(page).getByRole('tab', { name: '搜索词' }))
    fireEvent.click(await within(page).findByRole('button', { name: '保存当前视图' }))
    const name = await screen.findByLabelText('视图名称')
    fireEvent.change(name, { target: { value: '新视图' } })
    fireEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]!.method).toBe('POST')
    expect(bodies[0]!.body).toMatchObject({ pageKey: 'ad-terms', name: '新视图', filterJson: { tab: 'search-terms', sort: 'spend', dir: 'desc' }, shared: false })
    expect(app.calls.some(call => call.path === '/views' && call.method === 'POST')).toBe(true)
    fireEvent.click(within(page).getByRole('button', { name: '保存当前视图' }))
    const again = await screen.findByLabelText('视图名称')
    fireEvent.change(again, { target: { value: '否定复查' } })
    fireEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]!.method).toBe('PATCH')
    expect(bodies[1]!.body).toMatchObject({ version: 2 })
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { ...termHandlers(), '/ads/terms': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('ad-terms-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('yoga mat')).toBeNull()
  }, 30_000)
})

describe('词级中心：切换页签清掉不适用的筛选', () => {
  it('四象限与词根不带排序之外的无关参数；词根不带异常分组', async () => {
    const app = mountApp({ url, pages, handlers: termHandlers({ negatives: () => negativesResponse(), roots: () => rootsResponse(), targets: () => targetsResponse() }) })
    const { page } = await open(app, '搜索词')
    await rowOf(page, 'free yoga')
    fireEvent.click(await within(await screen.findByTestId('term-summary')).findByText(/高花费无成交 \d/))
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('anomaly') === 'HIGH_SPEND_NO_ORDER')).not.toHaveLength(0))
    fireEvent.click(within(page).getByRole('tab', { name: '词根分析' }))
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/terms/roots')).toBe(true))
    expect(app.calls.filter(call => call.path === '/ads/terms/roots').every(call => !new URLSearchParams(call.search).has('anomaly'))).toBe(true)
  })
})
