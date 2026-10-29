import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, pendingSync, promotionDetail, promotionList, promotionRow } from './promotions-fixtures.test-helper'

// 促销列表与详情（P4-05）：没有数据的写法（尚无记录 / 尚未接入 / 无权限 / 不适用）、接口角色没批时的申请说明、只读、估算标记、六个页签。

const pages: LivePages = {
  PromotionsPage: { load: () => import('./PromotionsPage') },
  PromotionDetailPage: { load: () => import('./PromotionDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }),
  '/promotions': () => ok(promotionList()),
  '/promotions/pr1': () => ok(promotionDetail()),
  ...over,
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

describe('促销列表', () => {
  it('列出促销：类型、状态、折扣力度、报告数字、平台费用；只读说明常驻；带新鲜度', T, async () => {
    mountApp({ url: '/app/promotions', pages, handlers: handlers() })
    expect(await screen.findByText('十月秒杀', {}, WAIT)).toBeInTheDocument()
    const row = screen.getByText('十月秒杀').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('秒杀')).toBeInTheDocument()
    expect(within(row).getByText('进行中')).toBeInTheDocument()
    expect(within(row).getByText('立减 20%')).toBeInTheDocument()
    expect(within(row).getByText('$299.85')).toBeInTheDocument()
    expect(within(row).getByText('$100.00')).toBeInTheDocument()
    expect(screen.getByTestId('promotions-readonly')).toHaveTextContent('只读')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /创建|新建|取消促销|修改/ })).toBeNull()
  })

  it('没有数字的地方写原因：商品清单没同步、报告没接入、报告里没有、无权限、不适用，都不写 0', T, async () => {
    const items = [
      promotionRow({
        id: 'a',
        promotionId: 'A',
        title: '甲',
        itemCount: null,
        reported: { state: 'NOT_CONNECTED', units: null, sales: null, redemptions: null },
        platformFee: { state: 'RESTRICTED', amount: null },
      }),
      promotionRow({
        id: 'b',
        promotionId: 'B',
        title: '乙',
        selectionType: 'CATALOG',
        itemCount: null,
        reported: { state: 'NO_RECORD', units: null, sales: null, redemptions: null },
        platformFee: { state: 'NOT_APPLICABLE', amount: null },
      }),
      promotionRow({ id: 'c', promotionId: 'C', title: '丙', reported: { state: 'OK', units: null, sales: 90, redemptions: 9 }, platformFee: { state: 'NO_DATA', amount: null } }),
    ]
    mountApp({ url: '/app/promotions', pages, handlers: handlers({ '/promotions': () => ok(promotionList(items)) }) })
    await screen.findByText('甲', {}, WAIT)
    const rowOf = (title: string) => screen.getByText(title).closest('tr, [role=row]') as HTMLElement
    expect(within(rowOf('甲')).getByText('尚未同步')).toBeInTheDocument()
    expect(within(rowOf('甲')).getAllByText('尚未接入').length).toBe(3)
    expect(within(rowOf('甲')).getByText('无权限')).toBeInTheDocument()
    expect(within(rowOf('乙')).getByText('整个目录')).toBeInTheDocument()
    expect(within(rowOf('乙')).getAllByText('尚无记录').length).toBe(3)
    expect(within(rowOf('乙')).getByText('不适用')).toBeInTheDocument()
    expect(within(rowOf('丙')).getByText('报告未提供')).toBeInTheDocument()
    expect(within(rowOf('丙')).getByText('尚无记录')).toBeInTheDocument()
  })

  it('接口角色没批：显示申请方式，表里不写“没有促销”', T, async () => {
    mountApp({ url: '/app/promotions', pages, handlers: handlers({ '/promotions': () => ok(promotionList([], { state: 'ROLE_PENDING', note: 'x', sync: pendingSync })) }) })
    const alert = await screen.findByTestId('promotions-role-pending', {}, WAIT)
    expect(within(alert).getByText(/开发者控制台/)).toBeInTheDocument()
    expect(await screen.findByText(/未授权：申请方式见上方说明/)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('同步正常但没有促销：写“尚无记录”', T, async () => {
    mountApp({ url: '/app/promotions', pages, handlers: handlers({ '/promotions': () => ok(promotionList([], { note: '尚无记录：亚马逊促销接口里没有这个店铺的促销' })) }) })
    expect(await screen.findByText(/尚无记录：亚马逊促销接口里没有这个店铺的促销/, {}, WAIT)).toBeInTheDocument()
  })

  it('带上筛选参数请求列表', T, async () => {
    const app = mountApp({ url: '/app/promotions', pages, handlers: handlers() })
    expect(await screen.findByText('十月秒杀', {}, WAIT)).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/promotions')).toBe(true)
  })
})

describe('促销详情', () => {
  it('身份区、常驻只读说明与口径说明；效果页签：估算标记、逐日对比、报告数字另列', T, async () => {
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers() })
    expect(await screen.findByText('十月秒杀', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByTestId('promotion-readonly')).toHaveTextContent('只读')
    expect(screen.getByTestId('method-note')).toHaveTextContent('不是亚马逊给的数字')
    const summary = screen.getByTestId('effect-summary')
    expect(within(summary).getByText('$4,000.00')).toBeInTheDocument()
    expect(within(summary).getAllByText('估算').length).toBeGreaterThan(0)
    expect(within(summary).getByText('200.0%')).toBeInTheDocument()
    expect(within(screen.getByTestId('effect-reported')).getByText('$299.85')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /创建|修改|取消促销|提交/ })).toBeNull()
  })

  it('基线不足：不给增量，写“数据不足”和原因，不当 0', T, async () => {
    const base = promotionDetail()
    const detail = promotionDetail({
      effect: {
        ...base.effect,
        state: 'INSUFFICIENT',
        note: '基线有效日只有 2 天（不足 14 天），不给增量估算',
        baseline: { state: 'INSUFFICIENT', usedDays: 2, excludedDays: 26, from: '2026-09-22', to: '2026-10-19' },
        expected: { units: null, sales: null },
        incremental: { units: null, sales: null, liftPct: null },
      },
    })
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers({ '/promotions/pr1': () => ok(detail) }) })
    expect(await screen.findByTestId('section-note', {}, WAIT)).toHaveTextContent('不给增量估算')
    expect(within(screen.getByTestId('effect-summary')).getAllByText('数据不足').length).toBeGreaterThan(0)
  })

  it('成本与利润页签：折扣成本、平台费用与明细、预览费率；增量毛利与促销投入回报率标估算', T, async () => {
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers() })
    await screen.findByText('十月秒杀', {}, WAIT)
    screen.getByRole('tab', { name: '成本' }).click()
    const cost = await screen.findByTestId('cost-summary')
    expect(within(cost).getByText('$400.00')).toBeInTheDocument()
    expect(within(cost).getByText(/一次性费用 \$150\.00（ONE_TIME）；按销售额 2%；变动费用上限 \$25\.00/)).toBeInTheDocument()
    expect(await screen.findByText('DealParticipationFee')).toBeInTheDocument()
    screen.getByRole('tab', { name: '利润' }).click()
    const profit = await screen.findByTestId('profit-summary')
    expect(within(profit).getByText('$1,000.00')).toBeInTheDocument()
    expect(within(profit).getByText('2.00')).toBeInTheDocument()
    expect(within(profit).getAllByText('估算').length).toBeGreaterThanOrEqual(3)
  })

  it('没有权限的页签写“无权限”：成本里的折扣与平台费用、利润、广告', T, async () => {
    const base = promotionDetail()
    const detail = promotionDetail({
      cost: {
        ...base.cost,
        discount: { state: 'RESTRICTED', amount: null, orderLines: 0, note: '需要订单读取权限（orders.read）才能看折扣成本' },
        platformFee: { state: 'RESTRICTED', amount: null, lines: [], note: '需要财务读取权限' },
        total: null,
      },
      profit: {
        ...base.profit,
        state: 'RESTRICTED',
        note: '需要利润字段权限（field.profit）才能看利润与促销投入回报率',
        actualProfit: null,
        expectedProfit: null,
        incrementalProfit: null,
        roi: { value: null, denominator: null, formula: base.profit.roi.formula },
      },
      ads: { ...base.ads, state: 'RESTRICTED', note: '需要广告读取权限（ads.read）才能看活动期间的广告表现' },
    })
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers({ '/promotions/pr1': () => ok(detail) }) })
    await screen.findByText('十月秒杀', {}, WAIT)
    screen.getByRole('tab', { name: '成本' }).click()
    expect(within(await screen.findByTestId('cost-summary')).getAllByText('无权限').length).toBeGreaterThanOrEqual(3)
    screen.getByRole('tab', { name: '利润' }).click()
    expect(within(await screen.findByTestId('profit-summary')).getAllByText('无权限').length).toBeGreaterThanOrEqual(4)
    screen.getByRole('tab', { name: '广告' }).click()
    expect((await screen.findAllByText(/需要广告读取权限/)).length).toBeGreaterThan(0)
  })

  it('商品、问题、广告页签：商品链接到主数据、商品级问题、修订失败提示、广告尚未接入', T, async () => {
    const base = promotionDetail()
    const detail = promotionDetail({ issues: { ...base.issues, latestRevision: { status: 'FAILED', note: '最近一次修订失败，请到卖家后台查看原因' } } })
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers({ '/promotions/pr1': () => ok(detail) }) })
    await screen.findByText('十月秒杀', {}, WAIT)
    screen.getByRole('tab', { name: '商品' }).click()
    expect(await screen.findByText('B0AAAAAAA1')).toBeInTheDocument()
    expect(screen.getByText('警告：库存偏低')).toBeInTheDocument()
    expect(screen.getByText('固定价 $19.99')).toBeInTheDocument()
    screen.getByRole('tab', { name: '问题' }).click()
    expect(await screen.findByTestId('revision-note')).toHaveTextContent('修订失败')
    expect(screen.getByText('折后价接近最低价')).toBeInTheDocument()
    screen.getByRole('tab', { name: '广告' }).click()
    expect((await screen.findAllByText(/尚未接入：这个店铺还没有绑定亚马逊广告账户/)).length).toBeGreaterThan(0)
  })

  it('按目录选品、还没开始：效果与商品直接写原因', T, async () => {
    const base = promotionDetail()
    const detail = promotionDetail({
      effect: {
        ...base.effect,
        state: 'NO_ITEMS',
        note: '这是按目录选品的促销，没有商品清单，无法按商品估算',
        actual: { units: null, sales: null },
        expected: { units: null, sales: null },
        incremental: { units: null, sales: null, liftPct: null },
        daily: [],
        window: null,
      },
      items: { state: 'NO_ITEMS', note: '这是按目录选品的促销（整个目录参与），亚马逊没有提供商品清单', selectionType: 'CATALOG', total: null, truncated: false, items: [] },
    })
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers({ '/promotions/pr1': () => ok(detail) }) })
    expect(await screen.findByTestId('section-note', {}, WAIT)).toHaveTextContent('无商品清单')
    expect(within(screen.getByTestId('effect-summary')).getAllByText('无商品清单').length).toBeGreaterThan(0)
  })

  it('促销不存在：显示错误状态，不是空白', T, async () => {
    mountApp({
      url: '/app/promotions/nope',
      pages,
      handlers: handlers({ '/promotions/nope': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '促销不存在' } } }) }),
    })
    expect(await screen.findByText(/不存在/, {}, WAIT)).toBeInTheDocument()
  })

  it('同步没批：详情顶部显示申请方式', T, async () => {
    mountApp({ url: '/app/promotions/pr1', pages, handlers: handlers({ '/promotions/pr1': () => ok(promotionDetail({ sync: pendingSync })) }) })
    expect(await screen.findByTestId('promotions-role-pending', {}, WAIT)).toBeInTheDocument()
  })
})
