import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeSearchParser, buildAlertTemplates, type AlertTemplatesResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { alertDetail, alertList, alertRow, ok, rowText, ruleView, rulesResponse } from './alerts-fixtures.test-helper'

// 预警两套状态、批量动作、规则模板页与“从模板新建”（P6-15）：
// 已读按人记录（蓝点、批量标为已读、打开详情自动已读）、批量标为已处理、模板页用 PagedGrid 骨架并按分组筛选、模板带参数打开规则配置。

const pages: LivePages = {
  AlertsPage: { load: () => import('./AlertsPage'), search: ScopeSearchParser },
  AlertDetailPage: { load: () => import('./AlertDetailPage') },
  AlertRulesPage: { load: () => import('./AlertRulesPage'), search: ScopeSearchParser },
  AlertTemplatesPage: { load: () => import('./AlertTemplatesPage'), search: ScopeSearchParser },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const templatesResponse = (over: Partial<AlertTemplatesResponse> = {}): AlertTemplatesResponse => ({
  state: 'OK',
  note: null,
  items: buildAlertTemplates().map(item => ({ ...item, ruleCount: item.code === 'INV_STOCKOUT_RISK' ? 2 : 0, enabledCount: item.code === 'INV_STOCKOUT_RISK' ? 1 : 0 })),
  can: { create: true },
  ...over,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/alerts': () => ok(alertList()),
  '/alerts/a1': () => ok(alertDetail()),
  '/alerts/read': () => ok({ marked: 1, missing: [], unreadCount: 0 }),
  '/alerts/handled': () => ok({ handled: 1, skipped: [], unreadCount: 0 }),
  '/alerts/templates': () => ok(templatesResponse()),
  '/alerts/rules': () => ok(rulesResponse([ruleView({ id: 'r9', code: 'ADS_CPC_SURGE', name: '单次点击成本突增', type: 'ads.cpc-surge' })])),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const selectFirstRow = async () => {
  await screen.findByRole('link', { name: /春季促销.*花费高/ }, { timeout: 15000 })
  await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
}

describe('预警列表的批量动作', () => {
  it('勾选后标为已读：只发我选中的未读预警编号', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: '/app/alerts', pages, handlers: handlers({ '/alerts/read': (_url, init) => (bodies.push(bodyOf(init)), ok({ marked: 1, missing: [], unreadCount: 0 })) }) })
    await selectFirstRow()
    await userEvent.click(await screen.findByRole('button', { name: /标为已读（1）/ }))
    await waitFor(() => expect(bodies).toEqual([{ ids: ['a1'] }]))
  })

  it('选中的预警都已读：标为已读按钮禁用并写原因', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts', pages, handlers: handlers({ '/alerts': () => ok(alertList([alertRow({ read: true })])) }) })
    await selectFirstRow()
    expect(await screen.findByRole('button', { name: /标为已读（0）/ })).toBeDisabled()
  })

  it('批量标为已处理：只处理待处理的，备注可选，成功后列表重取', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let listCalls = 0
    const app = mountApp({
      url: '/app/alerts',
      pages,
      handlers: handlers({
        '/alerts': () => (listCalls++, ok(alertList())),
        '/alerts/handled': (_url, init) => (bodies.push(bodyOf(init)), ok({ handled: 1, skipped: [], unreadCount: 0 })),
      }),
    })
    await selectFirstRow()
    await userEvent.click(await screen.findByRole('button', { name: /标为已处理（1）/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('批量处理备注'), '已核实')
    await userEvent.click(within(dialog).getByRole('button', { name: /标为已处理/ }))
    await waitFor(() => expect(bodies).toEqual([{ ids: ['a1'], note: '已核实' }]))
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(app.calls.some(call => call.path === '/alerts/handled')).toBe(true)
  })

  it('已结束的预警不计入“标为已处理”的条数；没有处理权限时按钮禁用', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/alerts',
      pages,
      handlers: handlers({ '/alerts': () => ok(alertList([alertRow({ status: 'HANDLED', statusLabel: '已处理' })])) }, ['alerts.read']),
    })
    await selectFirstRow()
    expect(await screen.findByRole('button', { name: /标为已处理（0）/ })).toBeDisabled()
  })
})

describe('预警详情的已读', () => {
  it('打开未读的预警自动标为已读，只标一次', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/read': (_url, init) => (bodies.push(bodyOf(init)), ok({ marked: 1, missing: [], unreadCount: 0 })) }) })
    await screen.findByText('广告活动“春季促销”花费高、产出低', {}, { timeout: 15000 })
    await waitFor(() => expect(bodies).toEqual([{ ids: ['a1'] }]))
  })

  it('已读的预警打开时不再请求', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1': () => ok(alertDetail({ alert: alertRow({ read: true }) })) }) })
    await screen.findByText('广告活动“春季促销”花费高、产出低', {}, { timeout: 15000 })
    expect(app.calls.some(call => call.path === '/alerts/read')).toBe(false)
  })
})

describe('预警规则模板页', () => {
  it('按库存、广告、销售、流量、店铺分组；一句话条件、适用维度、已有规则数；用 PagedGrid 骨架', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/templates', pages, handlers: handlers() })
    expect(await screen.findByText('断货风险', {}, { timeout: 15000 })).toBeInTheDocument()
    const text = rowText('INV_STOCKOUT_RISK')
    for (const part of ['库存', '预计断货日早于最快补货到仓日', 'SKU（按店铺）', '严重', '2 条（启用 1）']) expect(text).toContain(part)
    expect(rowText('ADS_CPC_SURGE')).toContain('尚无')
    expect(rowText('ADS_CPC_SURGE')).toContain('广告')
    expect(screen.getByTestId('paged-grid')).toBeInTheDocument()
    expect(document.querySelector('.ant-table')).toBeNull()
    const link = within(document.querySelector('[row-id="INV_STOCKOUT_RISK"]') as HTMLElement).getByRole('link', { name: /从模板新建/ })
    expect(link.getAttribute('href')).toContain('/app/alerts/rules')
    expect(link.getAttribute('href')).toContain('template=INV_STOCKOUT_RISK')
  })

  it('分组筛选：只显示所选分组；搜索按名称、条件、维度匹配', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/templates?group=ADS', pages, handlers: handlers() })
    expect(await screen.findByText('单次点击成本突增', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelector('[row-id="INV_STOCKOUT_RISK"]')).toBeNull()
    expect(document.querySelectorAll('[row-id]').length).toBeGreaterThan(0)
    for (const el of Array.from(document.querySelectorAll('[row-id]'))) expect(el.getAttribute('row-id')).toMatch(/^ADS_/)
  })

  it('没有预警管理权限：从模板新建按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/templates', pages, handlers: handlers({ '/alerts/templates': () => ok(templatesResponse({ can: { create: false } })) }, ['alerts.read']) })
    await screen.findByText('断货风险', {}, { timeout: 15000 })
    const button = within(document.querySelector('[row-id="INV_STOCKOUT_RISK"]') as HTMLElement).getByRole('button', { name: /从模板新建/ })
    expect(button).toBeDisabled()
  })

  it('没有模板：写“尚无规则模板”，不显示示例行', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/templates', pages, handlers: handlers({ '/alerts/templates': () => ok(templatesResponse({ state: 'NO_DATA', items: [] })) }) })
    expect(await screen.findByText(/尚无规则模板/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
  })
})

describe('从模板新建规则', () => {
  it('地址带 template：自动打开新建弹窗，带入模板的名称、严重度、冷却与默认阈值；创建请求带评估逻辑与阈值；之后清掉地址参数', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    const app = mountApp({
      url: '/app/alerts/rules?template=ADS_CPC_SURGE',
      pages,
      handlers: handlers({
        '/alerts/rules': (url, init) =>
          init?.method === 'POST'
            ? (bodies.push(bodyOf(init)), ok({ id: 'r10', code: 'CUSTOM_1', currentVersion: 1, version: 1 }))
            : ok(rulesResponse([ruleView({ id: 'r9', code: 'ADS_CPC_SURGE', name: '单次点击成本突增', type: 'ads.cpc-surge' })])),
      }),
    })
    const dialog = await screen.findByRole('dialog', {}, { timeout: 15000 })
    expect(within(dialog).getByText('从模板新建：单次点击成本突增')).toBeInTheDocument()
    expect(within(dialog).getByTestId('template-hint')).toHaveTextContent('适用维度：广告活动')
    expect(within(dialog).getByTestId('template-hint')).toHaveTextContent(/带入模板的默认阈值：/)
    expect(within(dialog).getByLabelText('规则名称')).toHaveValue('单次点击成本突增（自定义）')
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      type: 'ads.cpc-surge',
      name: '单次点击成本突增（自定义）',
      severity: 'WARNING',
      cooldownMinutes: 4320,
      params: { recentDays: 3, baselineDays: 14, ratio: 1.5, minClicks: 30, minBaselineClicks: 100 },
    })
    await waitFor(() => expect(app.router.state.location.search).not.toHaveProperty('template'))
  })

  it('取消也清掉地址参数；模板代码不存在时不弹窗', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/alerts/rules?template=ADS_CPC_SURGE', pages, handlers: handlers() })
    const dialog = await screen.findByRole('dialog', {}, { timeout: 15000 })
    await userEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }))
    await waitFor(() => expect(app.router.state.location.search).not.toHaveProperty('template'))
    app.unmount()
    mountApp({ url: '/app/alerts/rules?template=NOPE', pages, handlers: handlers() })
    await screen.findByRole('button', { name: '新建自定义规则' }, { timeout: 15000 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('没有预警管理权限：带 template 也不弹窗，按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/rules?template=ADS_CPC_SURGE', pages, handlers: handlers({ '/alerts/rules': () => ok(rulesResponse([ruleView()], { can: { manage: false } })) }) })
    expect(await screen.findByRole('button', { name: '新建自定义规则' }, { timeout: 15000 })).toBeDisabled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
