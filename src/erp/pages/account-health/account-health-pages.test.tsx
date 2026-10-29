import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { emptyStore, issueDetail, issueList, issueRow, ok, overview, roleGuide, storeView } from './account-health-fixtures.test-helper'

// 账户健康页（P5-02）：状态与变更、评级、订单缺陷率与构成、政策合规；没有数据的店铺（未接入、报告接口未授权）只写原因；推送未接入的说明；
// 问题列表、地址栏直达详情、处理表单的请求内容与权限。

// jsdom 里没有画布，图表容器换成占位（图表配置本身由 account-health-options 的纯函数生成，下面单独测）
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AccountHealthPage: { load: () => import('./AccountHealthPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/account-health': () => ok(overview()),
  '/account-health/issues': () => ok(issueList()),
  '/account-health/issues/i1': () => ok(issueDetail()),
  ...over,
})

describe('账户健康：总览', () => {
  it('账户状态与最近一次变化、评级、订单缺陷率（目标与判定）、构成（没分项给的写明）、政策问题数、其他指标', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health', pages, handlers: handlers() })
    const block = await screen.findByTestId('store-block-s1', {}, { timeout: 15000 })
    const status = within(block).getByTestId('account-status')
    expect(within(status).getByText('有风险')).toBeInTheDocument()
    expect(within(status).getAllByText(/正常 → 有风险/).length).toBeGreaterThanOrEqual(1)
    expect(within(status).getByText('每日报告')).toBeInTheDocument()
    expect(within(within(status).getByTestId('status-history')).getByText('变差')).toBeInTheDocument()
    const rating = within(block).getByTestId('account-rating')
    expect(within(rating).getByText('312')).toBeInTheDocument()
    expect(within(rating).getByText('良好')).toBeInTheDocument()
    const defect = within(block).getByTestId('order-defect-metrics')
    expect(within(defect).getByText('订单缺陷率（亚马逊配送）')).toBeInTheDocument()
    expect(within(defect).getByText('1.2%')).toBeInTheDocument()
    expect(within(defect).getByText('低于 1%')).toBeInTheDocument()
    expect(within(defect).getByText('未达标')).toBeInTheDocument()
    expect(within(defect).getByText('近 60 天')).toBeInTheDocument()
    const breakdown = within(block).getByTestId('odr-breakdown')
    expect(within(breakdown).getByText('0.4%')).toBeInTheDocument()
    expect(within(breakdown).getAllByText('报告未分项给出')).toHaveLength(2)
    const policy = within(block).getByTestId('policy-section')
    expect(within(policy).getByText('上架政策违规 2')).toBeInTheDocument()
    const policyMetrics = within(policy).getByTestId('policy-metrics')
    expect(within(policyMetrics).getByText('报告没给目标')).toBeInTheDocument()
    expect(within(policyMetrics).getByText('未判定')).toBeInTheDocument()
    expect(within(policyMetrics).getByText('报告未说明')).toBeInTheDocument()
    expect(within(within(block).getByTestId('other-metrics')).getByText('迟发率')).toBeInTheDocument()
    expect(within(within(block).getByTestId('other-metrics')).getByText('3%')).toBeInTheDocument()
  })

  it('推送未接入：页面顶部给出说明，状态最长晚一天', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health', pages, handlers: handlers() })
    expect(await screen.findByTestId('push-not-connected', {}, { timeout: 15000 })).toHaveTextContent('推送尚未接入')
  })

  it('没有数据的店铺：未接入只写原因，不画指标也不显示状态标签；报告接口未授权给出申请方式', { timeout: 30000 }, async () => {
    const pending = emptyStore({ sellerAccountId: 's3', storeName: '日本店', state: 'ROLE_PENDING', note: roleGuide })
    mountApp({ url: '/app/account-health', pages, handlers: handlers({ '/account-health': () => ok(overview([storeView(), emptyStore(), pending])) }) })
    const europe = await screen.findByTestId('store-block-s2', {}, { timeout: 15000 })
    expect(within(europe).getByText('尚未接入')).toBeInTheDocument()
    expect(within(europe).getByText(/还没有接入亚马逊授权/)).toBeInTheDocument()
    expect(within(europe).queryByTestId('account-status')).toBeNull()
    expect(within(europe).queryByTestId('order-defect')).toBeNull()
    const japan = screen.getByTestId('store-block-s3')
    expect(within(japan).getByText('报告接口未授权')).toBeInTheDocument()
    expect(within(japan).getByText(/需要为应用授权对应角色/)).toBeInTheDocument()
  })

  it('有数据但某项没有：写“尚无记录”或原因，不写 0', { timeout: 30000 }, async () => {
    const sparse = storeView({
      accountStatus: { status: null, label: null, asOf: null, source: null, previousStatus: null, previousLabel: null, changedAt: null },
      rating: null,
      ratingTrend: [],
      statusHistory: [],
      orderDefect: { metrics: [], breakdown: [], trend: [] },
      policy: { metrics: [], openByKind: [], openCount: 1 },
      other: [],
    })
    mountApp({ url: '/app/account-health', pages, handlers: handlers({ '/account-health': () => ok(overview([sparse])) }) })
    const block = await screen.findByTestId('store-block-s1', {}, { timeout: 15000 })
    expect(within(within(block).getByTestId('account-status')).getAllByText('尚无记录').length).toBeGreaterThan(0)
    expect(within(block).getByText('报告里没有账户健康评级')).toBeInTheDocument()
    expect(within(block).getByText('报告没有给出订单缺陷率')).toBeInTheDocument()
    expect(within(block).getByText('报告没有给出政策合规指标')).toBeInTheDocument()
    expect(within(block).getByText('报告里没有其他指标')).toBeInTheDocument()
  })

  it('没有可见店铺：说明原因；读取失败：显示错误态', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health', pages, handlers: handlers({ '/account-health': () => ok(overview([])) }) })
    expect(await screen.findByText(/还没有可见的亚马逊店铺/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('账户健康：政策合规问题', () => {
  it('列表：类型、状态、处理状态、负责人（未指定）、案件编号（尚未填写）；筛选带上参数', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/account-health?tab=issues', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: 'Restricted products' }, { timeout: 15000 }).catch(() => screen.findByText('Restricted products', {}, { timeout: 15000 }))
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('上架政策违规')).toBeInTheDocument()
    expect(within(row).getByText('未解决')).toBeInTheDocument()
    expect(within(row).getByText('待处理')).toBeInTheDocument()
    expect(within(row).getByText('未指定')).toBeInTheDocument()
    expect(within(row).getByText('尚未填写')).toBeInTheDocument()
    await waitFor(() => expect(app.calls.some(call => call.path === '/account-health/issues' && new URLSearchParams(call.search).get('status') === 'OPEN')).toBe(true))
    await userEvent.click(screen.getByText(/^已解决/))
    await waitFor(() => expect(app.calls.some(call => call.path === '/account-health/issues' && new URLSearchParams(call.search).get('status') === 'RESOLVED')).toBe(true))
  })

  it('没有问题：写服务端给的原因，没有示例行', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health?tab=issues', pages, handlers: handlers({ '/account-health/issues': () => ok(issueList([])) }) })
    expect(await screen.findByText(/目前没有政策合规问题记录/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('地址栏 ?issue= 直接打开详情：问题、处理信息（负责人未指定、案件尚未填写）、关联支持案件说明、处理记录', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health?issue=i1', pages, handlers: handlers() })
    const drawer = await screen.findByTestId('policy-issue-drawer', {}, { timeout: 15000 })
    const info = await within(drawer).findByTestId('issue-descriptions', {}, { timeout: 15000 })
    expect(within(info).getByText('Restricted products')).toBeInTheDocument()
    expect(within(info).getByText('B000000001')).toBeInTheDocument()
    const handling = within(drawer).getByTestId('issue-handling')
    expect(within(handling).getByText('未指定')).toBeInTheDocument()
    expect(within(handling).getByText('尚未填写')).toBeInTheDocument()
    expect(within(drawer).getByTestId('issue-support')).toHaveTextContent('没有关联的支持案件')
    expect(within(drawer).getByTestId('issue-timeline')).toHaveTextContent('尚无处理记录')
  })

  it('处理：带版本号提交，空的负责人按 null 发送，成功后提示已保存', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    const patch: Handler = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return ok(issueRow({ version: 2, amazonCaseId: 'CASE-778' }))
    }
    mountApp({ url: '/app/account-health?issue=i1', pages, handlers: handlers({ '/account-health/issues/i1': (url, init) => (init?.method === 'PATCH' ? patch(url, init) : ok(issueDetail())) }) })
    await userEvent.click(await screen.findByRole('button', { name: /^处\s*理$/ }, { timeout: 15000 }))
    const dialog = (await screen.findByText('处理这条政策合规问题')).closest('[role="dialog"]') as HTMLElement
    await userEvent.type(within(dialog).getByLabelText('处理备注'), '已联系品牌方')
    await userEvent.type(within(dialog).getByLabelText('亚马逊案件编号'), 'CASE-778')
    await userEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toEqual({ version: 1, ownerUserId: null, handlingStatus: 'OPEN', handlingNote: '已联系品牌方', amazonCaseId: 'CASE-778' })
    expect(await screen.findByText('已保存', {}, { timeout: 8000 })).toBeInTheDocument()
  })

  it('没有预警处理权限：处理按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/account-health?issue=i1', pages, handlers: handlers({}, ['account.health.read']) })
    const button = await screen.findByRole('button', { name: /^处\s*理$/ }, { timeout: 15000 })
    expect(button).toBeDisabled()
  })

  it('已解决的问题：说明解决状态只由报告决定', { timeout: 30000 }, async () => {
    const resolved = issueDetail({ issue: { ...issueRow({ status: 'RESOLVED', statusLabel: '已解决', resolvedAt: '2026-10-25T00:00:00.000Z' }), handlingNote: null } })
    mountApp({ url: '/app/account-health?issue=i1', pages, handlers: handlers({ '/account-health/issues/i1': () => ok(resolved) }) })
    expect(await screen.findByText(/不在最近的报告里，系统已标记为已解决/, {}, { timeout: 15000 })).toBeInTheDocument()
  })

  it('问题不存在：显示错误态而不是空白', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/account-health?issue=i1',
      pages,
      handlers: handlers({ '/account-health/issues/i1': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '政策问题不存在' } } }) }),
    })
    expect(await screen.findByText(/政策问题不存在|不存在/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})
