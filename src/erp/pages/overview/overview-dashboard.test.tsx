import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { asinRank, attribution, baseHandlers, cash, kpis, ok, trend, volatility } from './overview-fixtures.test-helper'

// 经营控制台（P2a-02）：假服务端返回固定数据，验证各区域如实展示、没有数据时写明状态、模板与布局、报表与大屏模式。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const noop = () => null
const pages: LivePages = { OverviewPage: { load: () => import('./OverviewPage') } }
// 下钻目标页已上线的环境（用来验证链接）
const livePages: LivePages = {
  ...pages,
  OrdersPage: { load: async () => ({ default: noop }) },
  AdsConsolePage: { load: async () => ({ default: noop }) },
  MyWorkItemsPage: { load: async () => ({ default: noop }) },
  TargetsPage: { load: async () => ({ default: noop }) },
}
afterEach(() => vi.unstubAllGlobals())

const mount = (handlers: Record<string, Handler> = {}, options: { pages?: LivePages; permissions?: string[] } = {}) =>
  mountApp({
    url: '/app/overview',
    pages: options.pages ?? pages,
    me: options.permissions ? { ...defaultMe, permissions: options.permissions } : undefined,
    handlers: { ...baseHandlers(), ...handlers },
  })

describe('指标卡', () => {
  it('销售额有数据；净利润、广告、库存风险如实写“尚未接入”，不显示 0；目标进度与官方净收益对照尚未接入', async () => {
    mount()
    const sales = await screen.findByTestId('kpi-sales')
    expect(within(sales).getByText('$12,345.67')).toBeInTheDocument()
    expect(within(sales).getByLabelText('环比：+12.0%')).toBeInTheDocument()
    for (const key of ['profit', 'margin', 'adsSpend', 'adsShare', 'stockRisk']) {
      const tile = screen.getByTestId(`kpi-${key}`)
      expect(within(tile).getByText('尚未接入')).toBeInTheDocument()
      expect(within(tile).queryByText('$0.00')).not.toBeInTheDocument()
      expect(within(tile).queryByText('0')).not.toBeInTheDocument()
    }
    expect(within(screen.getByTestId('kpi-profit')).getByText('官方净收益对照：尚未接入')).toBeInTheDocument()
    expect(screen.getByTestId('kpi-target')).toHaveTextContent('目标达成进度：尚未接入')
    expect(within(screen.getByTestId('kpi-anomalies')).getByText('3')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-anomalies')).getByText('严重 1 · 警告 1 · 提示 1')).toBeInTheDocument()
  })

  it('顶部：时间范围、对比期、默认范围提示、汇总刷新时间、数据完整度', async () => {
    mount({ '/overview/source-health': () => ok({ asOf: '2026-10-22T08:00:00Z', storeCount: 2, rows: [], summary: { completeness: 0.8, attention: 1 } }) })
    const bar = await screen.findByTestId('overview-topbar')
    await waitFor(() => expect(bar).toHaveTextContent('2026-09-23 至 2026-10-22（30 天）'))
    expect(bar).toHaveTextContent('环比对比 2026-08-24 至 2026-09-22')
    expect(bar).toHaveTextContent('默认近 30 天，对比上一期')
    expect(bar).toHaveTextContent('汇总刷新于')
    expect(bar).toHaveTextContent('数据完整度 80%')
  })

  it('没有汇总记录：写“尚无汇总记录”', async () => {
    mount({ '/overview/kpis': () => ok(kpis({ refreshedAt: null, metricVersion: null })) })
    expect(await screen.findByText('尚无汇总记录')).toBeInTheDocument()
  })

  it('没有利润字段权限：显示“无权查看”', async () => {
    const cards = kpis().cards.map(card => (card.key === 'profit' ? { ...card, state: 'RESTRICTED', note: '需要“利润”字段权限' } : card))
    mount({ '/overview/kpis': () => ok(kpis({ cards })) })
    expect(within(await screen.findByTestId('kpi-profit')).getByText('无权查看')).toBeInTheDocument()
  })

  it('追溯：口径、公式、来源、同步时间与口径版本', async () => {
    mount()
    fireEvent.click(await screen.findByLabelText('追溯销售额'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/追溯：销售额/)).toBeInTheDocument()
    expect(within(dialog).getByText('店铺经营日汇总（订单口径）')).toBeInTheDocument()
    expect(within(dialog).getByText(/口径版本 v1/)).toBeInTheDocument()
  })

  it('下钻：目标页已上线给链接，没上线写“页面尚未上线”', async () => {
    mount({}, { pages: livePages })
    const sales = await screen.findByTestId('kpi-sales')
    expect(within(sales).getByRole('link', { name: '查看明细' })).toHaveAttribute('href', expect.stringContaining('/app/orders'))
    expect(within(screen.getByTestId('kpi-profit')).getByText('页面尚未上线')).toBeInTheDocument()
  })

  it('目标达成进度：已设置目标时显示达成率、预期进度与覆盖店铺数，带目标与预算页链接', async () => {
    mount(
      {
        '/overview/kpis': () =>
          ok(
            kpis({
              target: {
                state: 'OK',
                note: '范围内 2 个店铺中有 1 个已设置目标，达成率只统计这些店铺',
                metric: 'sales',
                periodStart: '2026-10-01',
                periodEnd: '2026-10-31',
                targetValue: 10000,
                actualValue: 3000,
                achievementRatio: 0.3,
                expectedToDateRatio: 0.5,
                storesCovered: 1,
                storesTotal: 2,
              },
            }),
          ),
      },
      { pages: livePages },
    )
    const banner = await screen.findByTestId('kpi-target')
    expect(banner).toHaveTextContent('$3,000')
    expect(banner).toHaveTextContent('$10,000')
    expect(banner).toHaveTextContent('30.0%')
    expect(banner).toHaveTextContent('预期进度 50.0%')
    expect(banner).toHaveTextContent('覆盖 1/2 个店铺')
    expect(within(banner).getByText('范围内 2 个店铺中有 1 个已设置目标，达成率只统计这些店铺')).toBeInTheDocument()
    expect(within(banner).getByRole('link', { name: '查看目标与预算' })).toBeInTheDocument()
  })

  it('读取失败：只影响自己，其他区域照常', async () => {
    mount({ '/overview/kpis': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 8000 })).length).toBeGreaterThan(0)
    expect(await screen.findByText('Northstar US')).toBeInTheDocument()
  })
})

describe('趋势与归因', () => {
  it('趋势图按默认的日、销售额读取；切到周、净利润重新读取', async () => {
    const app = mount()
    expect(await screen.findByLabelText('销售额趋势图')).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/overview/trend' && call.search.includes('granularity=day') && call.search.includes('metric=sales'))).toBe(true)
    fireEvent.click(within(screen.getByLabelText('时间粒度')).getByText('周'))
    await waitFor(() => expect(app.calls.some(call => call.path === '/overview/trend' && call.search.includes('granularity=week'))).toBe(true))
    fireEvent.click(within(screen.getByLabelText('指标切换')).getByText('广告花费'))
    await waitFor(() => expect(app.calls.some(call => call.path === '/overview/trend' && call.search.includes('metric=adsSpend'))).toBe(true))
  })

  it('指标没有数据：趋势区写“尚未接入”，不画图', async () => {
    mount({ '/overview/trend': () => ok(trend({ state: 'NOT_CONNECTED', note: '广告同步在阶段 3 交付', points: [] })) })
    const section = await screen.findByTestId('trend-section')
    await waitFor(() => expect(within(section).getByText('尚未接入')).toBeInTheDocument())
    expect(within(section).queryByLabelText('销售额趋势图')).not.toBeInTheDocument()
  })

  it('净利润第二轴未接入时在图下说明', async () => {
    mount()
    expect(await screen.findByText(/净利润第二轴：尚未接入/)).toBeInTheDocument()
  })

  it('选择日期后读取归因：会话未接入时按两因子，并写明原因与利润桥状态', async () => {
    const app = mount()
    const picker = await screen.findByRole('combobox', { name: '归因日期' })
    fireEvent.mouseDown(picker)
    fireEvent.click(await screen.findByText('2026-10-01', { selector: '.ant-select-item-option-content' }))
    const area = await screen.findByTestId('attribution')
    expect(app.calls.some(call => call.path === '/overview/attribution' && call.search.includes('date=2026-10-01'))).toBe(true)
    expect(within(area).getByText('按“件数 × 件单价”两因子归因')).toBeInTheDocument()
    expect(within(area).getByText(/会话数据尚未接入/)).toBeInTheDocument()
    expect(within(area).getByText('利润桥尚未接入的原因')).toBeInTheDocument()
    expect(within(area).getByTestId('metric-tree')).toBeInTheDocument()
  })

  it('归因没有可比数据：显示状态', async () => {
    mount({ '/overview/attribution': () => ok(attribution({ state: 'NO_DATA', factors: [] })) })
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '归因日期' }))
    fireEvent.click(await screen.findByText('2026-10-01', { selector: '.ant-select-item-option-content' }))
    expect(await within(await screen.findByTestId('attribution')).findByText('尚无记录')).toBeInTheDocument()
  })
})

describe('待办、店铺对比、ASIN 排名', () => {
  it('待我处理：复用我的待办的数据，带处理时限与操作', async () => {
    mount()
    const section = await screen.findByTestId('queue-section')
    expect(await within(section).findByText('广告花费异常需要确认')).toBeInTheDocument()
    expect(within(section).getAllByText('警告').length).toBeGreaterThan(0)
  })

  it('待办为空：写“待处理事项”空态', async () => {
    mount({ '/work-items': () => ok({ items: [], pageInfo: { nextCursor: null, hasMore: false }, counts: null }) })
    expect(await within(await screen.findByTestId('queue-section')).findByText(/待处理事项/)).toBeInTheDocument()
  })

  it('店铺对比：销售额与变化；利润、广告占比、库存风险、账户健康整列写“尚未接入”', async () => {
    mount()
    const section = await screen.findByTestId('store-compare-section')
    expect(await within(section).findByText('Northstar US')).toBeInTheDocument()
    expect(within(section).getByText('$800.00')).toBeInTheDocument()
    expect(within(section).getByText('$200.00')).toBeInTheDocument()
    // 净利润、利润率、广告占比、库存风险、账户健康 5 列 × 2 店铺
    expect(within(section).getAllByText('尚未接入')).toHaveLength(10)
  })

  it('ASIN 排名：前 10 与后 10；切换依据重新读取；候选范围有说明', async () => {
    const app = mount({ '/overview/asin-rank': url => ok(url.searchParams.get('rankBy') === 'margin' ? asinRank({ rankBy: 'margin', candidateLimit: 1000 }) : asinRank()) })
    const section = await screen.findByTestId('asin-rank-section')
    expect(await within(section).findByText('B0AAAAAAA1')).toBeInTheDocument()
    expect(within(section).getByText('B0AAAAAAA9')).toBeInTheDocument()
    expect(within(section).getByText(/净利润、利润率、利润变化：尚未接入/)).toBeInTheDocument()
    fireEvent.click(within(within(section).getByLabelText('排名依据')).getByText('利润率'))
    await waitFor(() => expect(app.calls.some(call => call.path === '/overview/asin-rank' && call.search.includes('rankBy=margin'))).toBe(true))
    expect(await within(section).findByText(/只在销售额靠前的 1000 个 ASIN 内排名/)).toBeInTheDocument()
  })

  it('ASIN 排名依据需要利润而尚未接入：写状态，不列表', async () => {
    mount({ '/overview/asin-rank': () => ok(asinRank({ rankBy: 'profit', state: 'NOT_CONNECTED', note: '净利润尚未接入的原因', top: [], bottom: [] })) })
    const section = await screen.findByTestId('asin-rank-section')
    fireEvent.click(within(within(section).getByLabelText('排名依据')).getByText('净利润'))
    expect(await within(section).findByText('净利润尚未接入的原因')).toBeInTheDocument()
    expect(within(section).queryByText('前 10')).not.toBeInTheDocument()
  })
})

describe('波动异常', () => {
  it('列出连续两期下降的 ASIN，并写明三个期间', async () => {
    mount()
    const section = await screen.findByTestId('volatility-section')
    expect(await within(section).findByText('B0DOWNAAA1')).toBeInTheDocument()
    expect(within(section).getByText(/上上期销售额（2026-08-15 至 2026-09-13）/)).toBeInTheDocument()
    expect(within(section).getByText('$60.00')).toBeInTheDocument()
  })

  it('上上期没有销售：写状态说明，不列表', async () => {
    mount({ '/overview/volatility': () => ok(volatility({ state: 'NO_DATA', note: '上上期没有 ASIN 销售记录，无法做三期对比', rows: [] })) })
    const section = await screen.findByTestId('volatility-section')
    expect(await within(section).findByText('上上期没有 ASIN 销售记录，无法做三期对比')).toBeInTheDocument()
  })
})

describe('广告异常、库存风险、瀑布、现金', () => {
  it('广告异常与库存风险：写“尚未接入”和交付的工作包，不画图', async () => {
    mount()
    const ads = await screen.findByTestId('ad-anomalies-section')
    expect(await within(ads).findByText(/由 P3 交付/)).toBeInTheDocument()
    expect(within(ads).getByText('页面尚未上线')).toBeInTheDocument()
    expect(within(await screen.findByTestId('inventory-risk-section')).getByText(/由 P2a-06 交付/)).toBeInTheDocument()
  })

  it('增长瀑布：按店铺与按驱动因素；断货损失未接入写“尚未接入”并标注模型估算', async () => {
    mount()
    // 加载完成后区域的外层元素会换成图表容器，所以先等图出现再取区域
    expect(await screen.findByLabelText('销售额变化瀑布图')).toBeInTheDocument()
    const section = screen.getByTestId('waterfall-section')
    expect(within(section).getByText(/Northstar US：\+\$400\.00/)).toBeInTheDocument()
    expect(within(section).getByText(/断货损失：/)).toHaveTextContent('尚未接入')
    expect(within(section).getByText('模型估算')).toBeInTheDocument()
  })

  it('现金视角：已释放、递延中、下次打款日；没有财务权限显示“无权查看”', async () => {
    mount()
    const section = await screen.findByTestId('cash-section')
    expect(await within(section).findByText('$160.00')).toBeInTheDocument()
    expect(within(section).getByText(/\$390\.00（截至 2026-10-21）/)).toBeInTheDocument()
    expect(within(section).getByText('2026-10-28')).toBeInTheDocument()
  })

  it('现金视角受限与无记录', async () => {
    mount({ '/overview/cash': () => ok(cash({ state: 'RESTRICTED', note: '现金视角需要“财务查看”权限', released: null, deferred: null, nextPayoutDate: null })) })
    expect(await within(await screen.findByTestId('cash-section')).findByText('无权查看')).toBeInTheDocument()
  })

  it('现金视角没有任何记录：写“尚无记录”', async () => {
    mount({ '/overview/cash': () => ok(cash({ state: 'NO_DATA', note: '尚无财务交易、余额或结算记录', released: null, deferred: null, nextPayoutDate: null })) })
    expect(await within(await screen.findByTestId('cash-section')).findByText('尚无记录')).toBeInTheDocument()
  })
})
