import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { alertDetail, alertList, alertRow, ok, rowText, ruleView, rulesResponse } from './alerts-fixtures.test-helper'

// 风险预警中心三页（P5-01）：列表的视图与筛选参数、没有数据的写法；详情的阈值快照与规则版本提示、处理动作的必填项与请求内容；规则页的统计写法、编辑提交与尚未接入清单。

const pages: LivePages = {
  AlertsPage: { load: () => import('./AlertsPage') },
  AlertDetailPage: { load: () => import('./AlertDetailPage') },
  AlertRulesPage: { load: () => import('./AlertRulesPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/alerts': () => ok(alertList()),
  '/alerts/a1': () => ok(alertDetail()),
  '/alerts/read': () => ok({ marked: 1, missing: [], unreadCount: 0 }),
  '/alerts/rules': () => ok(rulesResponse()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('预警列表', () => {
  it('列出预警：严重度、对象、影响区间、负责人、状态、触发次数；标题链到详情；页签带条数与未读数；用表格骨架而不是旧表格', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: /春季促销.*花费高/ }, { timeout: 15000 })
    expect(link.getAttribute('href')).toMatch(/^\/app\/alerts\/a1(\?|$)/)
    const text = rowText('a1')
    for (const part of ['警告', '新预警', '甲', '$30 ~ $60', '触发 2 次', '美国主店']) expect(text).toContain(part)
    expect(
      within(document.querySelector('[row-id="a1"]') as HTMLElement)
        .getByRole('link', { name: '春季促销' })
        .getAttribute('href'),
    ).toMatch(/^\/app\/advertising\/campaigns\/c1/)
    expect(screen.getByRole('tab', { name: '待处理（1）' })).toBeInTheDocument()
    expect(screen.getByTestId('alerts-page').querySelector('.ag-root-wrapper')).not.toBeNull()
    expect(document.querySelector('.ant-table')).toBeNull()
    // 未读的带蓝点，读过的没有
    expect(within(document.querySelector('[row-id="a1"]') as HTMLElement).getByLabelText('未读')).toBeInTheDocument()
  })

  it('已读的预警没有未读蓝点；只触发一次的写“触发 1 次”，不加警示色', { timeout: 30000 }, async () => {
    const item = alertRow({ read: true, triggerCount: 1 })
    mountApp({ url: '/app/alerts', pages, handlers: handlers({ '/alerts': () => ok(alertList([item])) }) })
    await screen.findByRole('link', { name: /春季促销.*花费高/ }, { timeout: 15000 })
    expect(rowText('a1')).toContain('触发 1 次')
    expect(within(document.querySelector('[row-id="a1"]') as HTMLElement).queryByLabelText('未读')).toBeNull()
  })

  it('没有影响依据写“尚无依据估算”，没有负责人写“尚未分派”，没有详情页的对象写“尚无详情页”，企业级预警店铺写“企业级”', { timeout: 30000 }, async () => {
    const item = alertRow({ impact: null, owner: null, storeName: null, entity: { type: 'FX_SOURCE', id: 'x', label: '汇率来源', path: null } })
    mountApp({ url: '/app/alerts', pages, handlers: handlers({ '/alerts': () => ok(alertList([item])) }) })
    await screen.findByText('汇率来源', {}, { timeout: 15000 })
    const text = rowText('a1')
    for (const part of ['尚无依据估算', '尚未分派', '（尚无详情页）', '企业级']) expect(text).toContain(part)
  })

  it('没有预警：写服务端给的原因，没有示例行', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts', pages, handlers: handlers({ '/alerts': () => ok(alertList([])) }) })
    expect(await screen.findByText(/尚无预警：系统每 15 分钟/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
  })

  it('切换处理状态页签带 handleState；地址栏里的已读与业务域筛选原样发给服务端；规则配置与规则模板入口按权限显示', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/alerts?readState=unread&domain=ADS', pages, handlers: handlers() })
    await screen.findByRole('tab', { name: '待处理（1）' }, { timeout: 15000 })
    expect(screen.getByRole('link', { name: '预警规则配置' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '规则模板' }).getAttribute('href')).toMatch(/^\/app\/alerts\/templates/)
    const first = new URLSearchParams(app.calls.find(call => call.path === '/alerts')!.search)
    expect(first.get('handleState')).toBe('open')
    expect(first.get('readState')).toBe('unread')
    expect(first.get('domain')).toBe('ADS')
    await userEvent.click(screen.getByRole('tab', { name: /已处理/ }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/alerts' && new URLSearchParams(call.search).get('handleState') === 'handled')).toBe(true))
  })

  it('没有管理权限看不到规则配置入口，但能看到规则模板', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts', pages, handlers: handlers({}, ['alerts.read']) })
    await screen.findByRole('tab', { name: '待处理（1）' }, { timeout: 15000 })
    expect(screen.queryByRole('link', { name: '预警规则配置' })).toBeNull()
    expect(screen.getByRole('link', { name: '规则模板' })).toBeInTheDocument()
  })
})

describe('预警详情', () => {
  it('身份区、证据、触发时的阈值、历史触发、处理记录、关联待办', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers() })
    expect(await screen.findByText('广告活动“春季促销”花费高、产出低', {}, { timeout: 15000 })).toBeInTheDocument()
    const evidence = screen.getByTestId('alert-evidence')
    expect(within(evidence).getByText('USD 45.50')).toBeInTheDocument()
    expect(within(screen.getByTestId('alert-thresholds')).getByText('20 美元')).toBeInTheDocument()
    expect(screen.queryByTestId('alert-version-note')).toBeNull()
    expect(screen.getByTestId('suggestions')).toBeInTheDocument()
    const rail = screen.getByTestId('alert-rail')
    expect(
      within(rail)
        .getByRole('link', { name: /查看待办/ })
        .getAttribute('href'),
    ).toMatch(/\/app\/my\/work-items\?item=w1/)
    await userEvent.click(screen.getByRole('tab', { name: /历史触发/ }))
    expect(await screen.findByText(/（本条）/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '处理记录' }))
    expect(within(await screen.findByTestId('alert-timeline')).getByText(/首次触发/)).toBeInTheDocument()
  })

  it('规则之后被改过：说明阈值是触发时的版本，不是现在的', { timeout: 30000 }, async () => {
    const detail = alertDetail()
    detail.rule.currentVersion = 5
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1': () => ok(detail) }) })
    expect(await screen.findByTestId('alert-version-note', {}, { timeout: 15000 })).toHaveTextContent('第 2 版，现在是第 5 版')
  })

  it('没有负责人与待办：写“尚未分派”', { timeout: 30000 }, async () => {
    const detail = alertDetail({ alert: alertRow({ owner: null }), workItem: null })
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1': () => ok(detail) }) })
    await screen.findByTestId('alert-rail', {}, { timeout: 15000 })
    expect(screen.getAllByText('尚未分派').length).toBeGreaterThan(0)
    expect(within(screen.getByTestId('alert-rail')).getByText('尚未分派，没有待办')).toBeInTheDocument()
  })

  it('忽略必须填原因，请求带原因', { timeout: 30000 }, async () => {
    const bodies: Array<{ path: string; body: unknown }> = []
    const record =
      (path: string): Handler =>
      (_url, init) => {
        bodies.push({ path, body: JSON.parse(String(init?.body ?? '{}')) })
        return ok({ id: 'a1', status: 'IGNORED', statusLabel: '已忽略' })
      }
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1/ignore': record('ignore'), '/alerts/a1/ack': record('ack') }) })
    await userEvent.click(await screen.findByRole('button', { name: /忽\s*略/ }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /忽\s*略/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies.length).toBe(0)
    await userEvent.type(within(dialog).getByRole('textbox'), '促销期间的预期花费')
    await userEvent.click(within(dialog).getByRole('button', { name: /忽\s*略/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({ path: 'ignore', body: { reason: '促销期间的预期花费' } })
  })

  it('预警已结束：处理按钮禁用，关联栏显示结论与备注', { timeout: 30000 }, async () => {
    const ended = alertDetail({
      alert: alertRow({ status: 'HANDLED', statusLabel: '已处理' }),
      closeInfo: { conclusionLabel: '误报', note: '数据延迟', closedByName: '甲', closedAt: '2026-10-22T00:00:00.000Z' },
    })
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1': () => ok(ended) }) })
    const ignore = await screen.findByRole('button', { name: /忽\s*略/ }, { timeout: 15000 })
    expect(ignore).toBeDisabled()
    expect(within(screen.getByTestId('alert-rail')).getByText('误报')).toBeInTheDocument()
    expect(within(screen.getByTestId('alert-rail')).getByText('数据延迟')).toBeInTheDocument()
  })

  it('预警不存在：显示错误态而不是空白', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/a1', pages, handlers: handlers({ '/alerts/a1': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '预警不存在' } } }) }) })
    expect(await screen.findByText(/预警不存在|不存在/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('预警规则', () => {
  it('规则行：阈值、范围、统计；没有被处理的预警写“尚无记录”，不写 0%；尚未接入清单', { timeout: 30000 }, async () => {
    const empty = ruleView({
      id: 'r2',
      code: 'ADS_CPC_SURGE',
      name: '点击成本突增',
      type: 'ads.cpc-surge',
      params: { recentDays: 3, baselineDays: 14, ratio: 1.5, minClicks: 50, minBaselineClicks: 200 },
      stats: { windowDays: 90, hits: 0, open: 0, handled: 0, falsePositive: 0, falsePositiveRate: null, avgHandleHours: null, truncated: false },
    })
    mountApp({ url: '/app/alerts/rules', pages, handlers: handlers({ '/alerts/rules': () => ok(rulesResponse([ruleView(), empty])) }) })
    // 规则表是 PagedGrid（虚拟化的 AG Grid），按行编号取整行文字
    await waitFor(() => expect(rowText('r1')).toMatch(/高花费低产出/), { timeout: 15000 })
    const row = rowText('r1')
    expect(row).toMatch(/花费下限 20 美元/)
    expect(row).toMatch(/25（2\/8）|25%（2\/8）/)
    expect(row).toContain('6.5 小时')
    expect(row).toContain('不限制（全部店铺与商品）')
    expect(row).toContain('立即通知')
    expect(row).toContain('不升级')
    expect(rowText('r2').match(/尚无记录/g)?.length).toBe(2)
    const unconnected = screen.getByTestId('unconnected-alerts')
    expect(within(unconnected).getByText('实时断货')).toBeInTheDocument()
    expect(within(unconnected).getByText(/尚未接入：/)).toBeInTheDocument()
  })

  it('没有管理权限：编辑与新建按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/rules', pages, handlers: handlers({ '/alerts/rules': () => ok(rulesResponse([ruleView()], { can: { manage: false } })) }) })
    const edit = await screen.findByRole('button', { name: /编\s*辑/ }, { timeout: 15000 })
    expect(edit).toBeDisabled()
    expect(screen.getByRole('button', { name: '新建自定义规则' })).toBeDisabled()
  })

  it('编辑：必须填变更原因；提交带版本号、阈值（百分比换回比例）、范围', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    const rule = ruleView({
      type: 'returns.abnormal-rate',
      params: { windowDays: 30, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 20 },
      scope: { sellerAccountIds: ['st1'], quiet: { start: '22:00', end: '07:00' } },
    })
    mountApp({
      url: '/app/alerts/rules',
      pages,
      handlers: handlers({
        '/alerts/rules': () => ok(rulesResponse([rule])),
        '/alerts/rules/r1': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok({ id: 'r1', code: rule.code, currentVersion: 3, version: 5 })
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /编\s*辑/ }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('退货率阈值')).toHaveValue('15')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存为新版本/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies.length).toBe(0)
    const threshold = within(dialog).getByLabelText('退货率阈值')
    await userEvent.clear(threshold)
    await userEvent.type(threshold, '20')
    await userEvent.type(within(dialog).getByPlaceholderText('例如：大促期间放宽花费下限'), '旺季放宽')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存为新版本/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      version: 4,
      changeReason: '旺季放宽',
      enabled: true,
      params: { windowDays: 30, rateThreshold: 0.2, minReturnedUnits: 5, minSoldUnits: 20 },
      scope: { sellerAccountIds: ['st1'], quiet: { start: '22:00', end: '07:00' } },
    })
  })

  it('版本记录：旧版本没有留存的项写“当时未留存”', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/rules', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('button', { name: '版本记录' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/大促期间放宽/)).toBeInTheDocument()
    expect(within(dialog).getByText(/系统预置规则/)).toBeInTheDocument()
    expect(within(dialog).getAllByText(/当时未留存/).length).toBeGreaterThanOrEqual(2)
  })

  it('没有任何规则：写服务端给的原因', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/alerts/rules', pages, handlers: handlers({ '/alerts/rules': () => ok(rulesResponse([], { note: '尚无预警规则：后台任务在下一轮评估前会自动补齐' })) }) })
    expect(await screen.findByText(/尚无预警规则/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})
