import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SNS_ASIN_SORTS, SNS_OFFER_SORTS, SNS_SORT_LABEL } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { buildDailyOption, buildMonthlyOption } from './subscribe-save-options'
import { asinList, asinRow, offerList, offerRow, ok, overview, pendingSync } from './subscribe-save-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 订阅省页面（P4-06）：八张指标卡（对比期、取消数尚未接入、预测过期）、范围与覆盖提示、没有数据的四种原因（未开通 / 角色没批 / 尚未同步 / 尚无记录）、
// 过期快照提示、两个明细页签（没有值写“尚无记录”、补货采用与原因、跳 ASIN 360、搜索请求）、只读、图表配置里没有的天是 null 而不是 0。

const pages: LivePages = {
  SubscribeSavePage: { load: () => import('./SubscribeSavePage') },
  Asin360Page: { load: () => Promise.resolve({ default: () => null }) },
  ReplenishmentPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/subscribe-save': () => ok(overview()),
  '/subscribe-save/asins': () => ok(asinList()),
  '/subscribe-save/offers': () => ok(offerList()),
  ...over,
})
const open = (over: Record<string, Handler> = {}, permissions?: string[]) => mountApp({ url: '/app/subscribe-save', pages, handlers: handlers(over, permissions) })
const card = (key: string) => screen.getByTestId(`sns-card-${key}`)

describe('概览', () => {
  it('八张卡：数字、对比期、另一币种、取消数尚未接入、预测过期；范围、口径、新鲜度、图表；没有写入口', T, async () => {
    open()
    expect(await screen.findByTestId('sns-card-activeSubscribers', {}, WAIT)).toHaveTextContent('50')
    expect(card('activeSubscribers')).toHaveTextContent('截至 2026-10-22')
    expect(card('shippedUnits')).toHaveTextContent('27')
    expect(card('shippedUnits')).toHaveTextContent('对比期 18')
    expect(card('revenue')).toHaveTextContent('$489.78')
    expect(card('revenue')).toHaveTextContent('对比期 $300.00')
    expect(card('revenue')).toHaveTextContent(/另有.*50\.00/)
    expect(card('cancellations')).toHaveTextContent('尚未接入')
    expect(card('cancellations')).not.toHaveTextContent('0')
    expect(screen.getByTestId('sns-cancel-note')).toHaveTextContent('官方是否提供取消指标需要对照真实响应核对')
    expect(card('forecast30')).toHaveTextContent('36')
    expect(card('forecast90')).toHaveTextContent('数据已过期')
    expect(card('offers')).toHaveTextContent('可订阅 2')
    expect(screen.getByTestId('sns-range')).toHaveTextContent('2026-09-25 ~ 2026-10-24')
    expect(screen.getByTestId('sns-range')).toHaveTextContent('对比期 2026-08-26 ~ 2026-09-24')
    expect(screen.getByTestId('sns-basis')).toHaveTextContent('不当 0')
    expect(screen.getByTestId('sns-forecast-basis')).toHaveTextContent('其中 2 条有预测，1 条已用于补货建议')
    expect(screen.getByRole('link', { name: '查看补货建议' })).toHaveAttribute('href', expect.stringContaining('/app/replenishment'))
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /逐日趋势图/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /月度对照图/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /创建|新建|修改|提交|取消订阅/ })).toBeNull()
  })

  it('日级记录不足：提示只有几天有记录、亚马逊只给最近 31 天；没选对比期时卡片不写对比', T, async () => {
    const data = overview({ compare: null })
    open({ '/subscribe-save': () => ok(data) })
    expect(await screen.findByTestId('sns-coverage', {}, WAIT)).toHaveTextContent('只有 2 天有日级记录')
    expect(screen.getByTestId('sns-coverage')).toHaveTextContent('31 天')
    expect(screen.getByTestId('sns-range')).toHaveTextContent('没有选对比期')
    expect(card('shippedUnits')).not.toHaveTextContent('对比期')
  })

  it('对比期没有记录：写“对比期尚无记录”，不写 0', T, async () => {
    const base = overview()
    const data = overview({ cards: base.cards.map(item => (item.key === 'shippedUnits' ? { ...item, previous: null } : item)) })
    open({ '/subscribe-save': () => ok(data) })
    expect(await screen.findByTestId('sns-card-shippedUnits', {}, WAIT)).toHaveTextContent('对比期尚无记录')
  })

  it('有店铺快照过期：给出店铺名与影响；同步失败时给原因；读取量超限给提示', T, async () => {
    const base = overview()
    const data = overview({
      forecast: { ...base.forecast, staleStores: ['加拿大店'] },
      truncated: true,
      sync: { status: 'FAILED', statusLabel: '失败', lastSuccessAt: null, errorCode: 'X', errorMessage: '补货接口暂时不可用', rolePending: false },
    })
    open({ '/subscribe-save': () => ok(data) })
    expect(await screen.findByTestId('sns-stale', {}, WAIT)).toHaveTextContent('加拿大店 的报价快照已超过 7 天')
    expect(screen.getByTestId('sns-stale')).toHaveTextContent('不会用于补货建议')
    expect(screen.getByTestId('sns-sync-warning')).toHaveTextContent('补货接口暂时不可用')
    expect(screen.getByTestId('sns-truncated')).toBeInTheDocument()
  })

  it.each([
    ['ROLE_PENDING', 'sns-role-pending', '开发者控制台'],
    ['NOT_APPLICABLE', 'sns-not-applicable', '没有开通订阅省'],
    ['NOT_CONNECTED', 'sns-not-connected', '尚未同步'],
    ['NO_DATA', 'sns-no-data', '尚无记录'],
  ] as const)('%s：只写原因，不显示指标卡与图表', T, async (state, testId, text) => {
    const data = overview({ state, note: `${text}（说明）`, sync: state === 'ROLE_PENDING' ? pendingSync : overview().sync })
    open({ '/subscribe-save': () => ok(data), '/subscribe-save/asins': () => ok(asinList([], { state, note: `${text}（说明）` })) })
    expect(await screen.findByTestId(testId, {}, WAIT)).toHaveTextContent(text)
    expect(screen.queryByTestId('sns-card-activeSubscribers')).toBeNull()
    expect(screen.queryByRole('img', { name: /趋势图/ })).toBeNull()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
    // 角色没批时同步提示不重复出现
    if (state === 'ROLE_PENDING') expect(screen.queryByTestId('sns-sync-warning')).toBeNull()
  })

  it('没有 analytics.read：提示无权限，不请求也不显示数字', T, async () => {
    const app = open({}, ['finance.read'])
    expect(await screen.findByText(/没有权限|无权/, {}, WAIT)).toBeInTheDocument()
    expect(screen.queryByTestId('sns-card-activeSubscribers')).toBeNull()
    expect(app.calls.some(call => call.path === '/subscribe-save')).toBe(false)
  })

  it('加载失败：显示错误并可重试，不显示数字', T, async () => {
    open({ '/subscribe-save': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, WAIT)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
    expect(screen.queryByTestId('sns-card-activeSubscribers')).toBeNull()
  })
})

describe('ASIN 明细页签', () => {
  it('默认页签：SKU 合并、没有值写尚无记录、补货采用与原因、ASIN 链到 ASIN 360', T, async () => {
    const rows = [
      asinRow(),
      asinRow({
        key: 's1|B0BBBBBBB2',
        asin: 'B0BBBBBBB2',
        skus: ['SKU-C'],
        productId: null,
        subscriptions: null,
        forecastNext30: null,
        forecastNext60: null,
        shippedUnitsPrevMonth: null,
        replenishment: { used: false, reason: 'INELIGIBLE' },
      }),
    ]
    open({ '/subscribe-save/asins': () => ok(asinList(rows)) })
    const table = await screen.findByTestId('sns-asins', {}, WAIT)
    const first = (await within(table).findByRole('link', { name: 'B0AAAAAAA1' }, WAIT)).closest('tr, [role=row]') as HTMLElement
    expect(first.querySelector('a')).toHaveAttribute('href', expect.stringContaining('/app/products/p1'))
    expect(within(first).getByText('SKU-A、SKU-B')).toBeInTheDocument()
    expect(within(first).getByText('已用于补货')).toBeInTheDocument()
    expect(within(first).getAllByText('尚无记录').length).toBe(1) // 只有未来 90 天没有值
    const second = within(table).getByText('B0BBBBBBB2').closest('tr, [role=row]') as HTMLElement
    expect(within(second).queryByRole('link')).toBeNull()
    expect(within(second).getAllByText('尚无记录').length).toBe(5)
    expect(within(second).getByText('未采用')).toBeInTheDocument()
    expect(within(second).getByText('报价当前不可订阅')).toBeInTheDocument()
  })

  it('搜索把关键词带进请求；换页签才请求报价列表', T, async () => {
    const app = open()
    await screen.findByTestId('sns-asins', {}, WAIT)
    expect(app.calls.some(call => call.path === '/subscribe-save/offers')).toBe(false)
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索ASIN' }), 'b0aaa{enter}')
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/subscribe-save/asins' && call.search.includes('q=b0aaa'))).toBe(true))
  })

  it('过期店铺与超限提示出现在表上方；没有记录时写原因', T, async () => {
    open({ '/subscribe-save/asins': () => ok(asinList([], { state: 'NO_DATA', note: '尚无记录：放宽筛选条件试试', staleStores: ['加拿大店'], truncated: true })) })
    expect(await screen.findByTestId('sns-list-stale', {}, WAIT)).toHaveTextContent('加拿大店')
    expect(screen.getByTestId('sns-list-truncated')).toBeInTheDocument()
    expect(await screen.findByText(/尚无记录：放宽筛选条件试试/)).toBeInTheDocument()
  })
})

describe('报价参与列表页签', () => {
  it('每行：可订阅状态、折扣、价格、库存、补货原因；过期快照的行写“报价快照已超过 7 天”', T, async () => {
    const rows = [
      offerRow(),
      offerRow({
        key: 's1|SKU-B',
        sku: 'SKU-B',
        eligibility: 'SUSPENDED',
        eligibilityLabel: '已暂停',
        discountPct: null,
        price: null,
        inventory: null,
        forecastNext30: null,
        replenishment: { used: false, reason: 'INELIGIBLE' },
      }),
      offerRow({ key: 's2|SKU-L', sku: 'SKU-L', storeName: '加拿大店', replenishment: { used: false, reason: 'STALE' } }),
    ]
    open({ '/subscribe-save/offers': () => ok(offerList(rows, { staleStores: ['加拿大店'] })) })
    await userEvent.click(await screen.findByRole('tab', { name: '报价参与列表' }, WAIT))
    const table = await screen.findByTestId('sns-offers', {}, WAIT)
    const a = (await within(table).findByText('SKU-A', {}, WAIT)).closest('tr, [role=row]') as HTMLElement
    expect(within(a).getByText('可订阅')).toBeInTheDocument()
    expect(within(a).getByText('5%')).toBeInTheDocument()
    expect(within(a).getByText('$19.99')).toBeInTheDocument()
    expect(within(a).getByText('已用于补货')).toBeInTheDocument()
    const b = within(table).getByText('SKU-B').closest('tr, [role=row]') as HTMLElement
    expect(within(b).getByText('已暂停')).toBeInTheDocument()
    expect(within(b).getByText('未提供')).toBeInTheDocument()
    expect(within(b).getAllByText('尚无记录').length).toBe(3) // 价格、库存、预计
    const l = within(table).getByText('SKU-L').closest('tr, [role=row]') as HTMLElement
    expect(within(l).getByText('报价快照已超过 7 天')).toBeInTheDocument()
    expect(within(table).getByTestId('sns-list-stale')).toBeInTheDocument()
  })
})

describe('排序字段与图表配置', () => {
  it('每个可用排序字段都有中文名（下拉不会出现英文字段名）', () => {
    for (const field of [...SNS_ASIN_SORTS, ...SNS_OFFER_SORTS]) expect(SNS_SORT_LABEL[field]).toMatch(/[\u4e00-\u9fa5]/)
  })

  it('逐日图：没有记录的天是 null（不画成 0）；没有币种时不画金额线', () => {
    const points = overview().trend.points
    const option = buildDailyOption(points, 'USD') as { series: Array<{ name: string; data: Array<number | null> }> }
    expect(option.series.find(item => item.name === '订阅出货件数')?.data).toEqual([17, null])
    expect(option.series.find(item => item.name.startsWith('订阅销售额'))?.data).toEqual([289.88, null])
    expect((buildDailyOption(points, null) as { series: unknown[] }).series.map(item => (item as { name: string }).name)).toEqual(['订阅出货件数', '活跃订阅数'])
  })

  it('月度图：只画出货与销售额', () => {
    const option = buildMonthlyOption(overview().trend.months, 'USD') as { series: Array<{ name: string }>; xAxis: { data: string[] } }
    expect(option.series.map(item => item.name)).toEqual(['订阅出货件数', '订阅销售额（USD）'])
    expect(option.xAxis.data).toEqual(['2026-09'])
  })
})
