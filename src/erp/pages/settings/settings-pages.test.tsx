import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'

// P1-28 前端：接口与写入开关、汇率、指标口径。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  IntegrationSwitchesPage: { load: () => import('./IntegrationSwitchesPage') },
  FxSettingsPage: { load: () => import('./FxSettingsPage') },
  MetricDefinitionsPage: { load: () => import('./MetricDefinitionsPage') },
}
const ok = (data: unknown) => ({ body: { success: true, data } })
const limited = (permissions: string[]): Me => ({ ...defaultMe, permissions })
const base: Record<string, Handler> = {
  '/settings/integrations/summary': () => ok({ mode: 'READ_ONLY', enabledCount: 0, total: 2, emergencyForced: false }),
  '/notifications/unread-count': () => ok({ unreadCount: 0 }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
}
const okText = /^(确\s?认|开\s?启|关\s?闭|全部只读)$/

afterEach(() => vi.unstubAllGlobals())

const check = (patch: Record<string, unknown> = {}) => ({ code: 'APP_CREDENTIALS', label: '应用凭据已配置', passed: true, ...patch })
const sw = (patch: Record<string, unknown> = {}) => ({
  key: 'pricing',
  label: '价格写入',
  group: 'listings',
  groupLabel: '商品与价格',
  enabled: false,
  forcedOffReason: null,
  enabledAt: null,
  enabledBy: null,
  reason: null,
  autoDisabledReason: null,
  calls7d: 0,
  failures7d: 0,
  consecutiveFailures: 0,
  prerequisites: [check()],
  canEnable: true,
  history: [],
  ...patch,
})
const overview = (items: unknown[], patch: Record<string, unknown> = {}) => ok({ mode: 'READ_ONLY', enabledCount: 0, total: items.length, statsDays: 7, emergencyForced: false, items, ...patch })

describe('接口与写入开关', () => {
  it('前置条件不满足：开启禁用，并显示默认关闭状态', async () => {
    mountApp({
      url: '/app/settings/integrations',
      pages,
      handlers: { ...base, '/settings/integrations': () => overview([sw({ canEnable: false, prerequisites: [check({ passed: false, hint: '尚未授权' })] })]) },
    })
    expect(await screen.findByText('价格写入')).toBeInTheDocument()
    expect(screen.getByText('已关闭')).toBeInTheDocument()
    expect(screen.getByText('0/1 项满足')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^开\s?启$/ })).toBeDisabled()
  })

  it('没有写入权限：开启禁用', async () => {
    mountApp({ url: '/app/settings/integrations', pages, me: limited(['settings.read']), handlers: { ...base, '/settings/integrations': () => overview([sw()]) } })
    await screen.findByText('价格写入')
    expect(screen.getByRole('button', { name: /^开\s?启$/ })).toBeDisabled()
  })

  it('开启：先填原因、勾选确认、输入密码再次验证，然后才调用开启接口', async () => {
    const order: string[] = []
    let enableBody: unknown
    mountApp({
      url: '/app/settings/integrations',
      pages,
      handlers: {
        ...base,
        '/settings/integrations': () => overview([sw()]),
        '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-22T12:00:00Z' })),
        '/settings/integrations/pricing/enable': (_url, init) => (order.push('enable'), (enableBody = JSON.parse(String(init?.body))), ok({ key: 'pricing' })),
      },
    })
    await screen.findByText('价格写入')
    await userEvent.click(screen.getByRole('button', { name: /^开\s?启$/ }))
    const dialog = await screen.findByRole('dialog')
    // 什么都不填直接确认：被前端拦下，不调用任何接口
    await userEvent.click(within(dialog).getByRole('button', { name: okText }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.type(within(dialog).getByLabelText('开启原因'), '本月起由运营统一调价')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: okText }))
    await waitFor(() => expect(order).toEqual(['step-up', 'enable']))
    expect(enableBody).toEqual({ reason: '本月起由运营统一调价', confirm: true })
  })

  it('服务端拒绝时，在弹窗里显示原因，不假装成功', async () => {
    mountApp({
      url: '/app/settings/integrations',
      pages,
      handlers: {
        ...base,
        '/settings/integrations': () => overview([sw()]),
        '/auth/step-up': () => ({ status: 401, body: { error: { code: 'STEP_UP_FAILED', message: '密码不正确' } } }),
      },
    })
    await screen.findByText('价格写入')
    await userEvent.click(screen.getByRole('button', { name: /^开\s?启$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('开启原因'), '本月起由运营统一调价')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'bad')
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: okText }))
    expect(await within(dialog).findByText(/密码不正确/)).toBeInTheDocument()
    expect(screen.queryByText(/已开启“价格写入”/)).toBeNull()
  })

  it('平台强制关闭：显示原因和横幅，不能开启', async () => {
    mountApp({
      url: '/app/settings/integrations',
      pages,
      handlers: { ...base, '/settings/integrations': () => overview([sw({ forcedOffReason: '平台已紧急强制关闭写入' })], { emergencyForced: true }) },
    })
    expect((await screen.findAllByText(/平台已紧急强制关闭写入/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^开\s?启$/ })).toBeDisabled()
  })

  it('已开启：可以关闭；“一键全部只读”在没有开启项时禁用', async () => {
    mountApp({
      url: '/app/settings/integrations',
      pages,
      handlers: { ...base, '/settings/integrations': () => overview([sw({ enabled: true, enabledBy: '林然', enabledAt: '2026-10-20T10:00:00Z' })], { mode: 'ALL', enabledCount: 1 }) },
    })
    await screen.findByText('价格写入')
    expect(screen.getByText('已开启')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^关\s?闭$/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /一键全部只读/ })).toBeEnabled()
  })

  it('读取失败：显示原因，不显示开关', async () => {
    mountApp({ url: '/app/settings/integrations', pages, handlers: { ...base, '/settings/integrations': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('价格写入')).toBeNull()
  })
})

const fx = (patch: Record<string, unknown> = {}) =>
  ok({
    baseCurrency: 'USD',
    currencies: ['CNY', 'EUR'],
    extraCurrencies: [],
    quote: 'CNY',
    days: 90,
    latest: [
      { currency: 'CNY', rateDate: '2026-10-22', rate: 7.12, source: 'frankfurter', isFallback: false, isManualOverride: false },
      { currency: 'EUR', rateDate: '2026-10-20', rate: null, source: null, isFallback: true, isManualOverride: false },
    ],
    curve: [],
    sources: [
      {
        role: 'PRIMARY',
        provider: 'frankfurter',
        providerLabel: 'Frankfurter',
        pathTemplate: 'https://api.frankfurter.app/latest?from={base}',
        configured: true,
        lastAttemptAt: '2026-10-22T06:00:00Z',
        lastSuccessAt: null,
        lastStatus: 'FAILED',
        lastErrorCode: 'TIMEOUT',
        consecutiveFailures: 3,
      },
      {
        role: 'BACKUP',
        provider: 'ecb',
        providerLabel: '欧洲央行',
        pathTemplate: 'https://example.org/ecb',
        configured: true,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastStatus: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
      },
    ],
    providers: [
      { key: 'frankfurter', label: 'Frankfurter', template: '' },
      { key: 'ecb', label: '欧洲央行', template: '' },
    ],
    overrides: [],
    ...patch,
  })

describe('汇率', () => {
  it('显示最新汇率；缺失的显示“尚无汇率”；来源失败时显示中文原因', async () => {
    mountApp({ url: '/app/settings/fx', pages, handlers: { ...base, '/settings/fx': () => fx() } })
    expect(await screen.findByText('7.12')).toBeInTheDocument()
    expect(screen.getByText('尚无汇率')).toBeInTheDocument()
    expect(screen.getByText(/失败原因：请求超时（已连续失败 3 次）/)).toBeInTheDocument()
    expect(screen.getByText('尚未获取')).toBeInTheDocument()
  })

  it('立即获取：真实调用服务端；没有权限时禁用', async () => {
    let refreshed = 0
    mountApp({ url: '/app/settings/fx', pages, handlers: { ...base, '/settings/fx': () => fx(), '/settings/fx/refresh': () => (refreshed++, ok({ queued: true })) } })
    await screen.findByText('7.12')
    await userEvent.click(screen.getByRole('button', { name: /立即获取/ }))
    await waitFor(() => expect(refreshed).toBe(1))
  })

  it('没有汇率写入权限：所有改动入口禁用', async () => {
    mountApp({ url: '/app/settings/fx', pages, me: limited(['settings.read']), handlers: { ...base, '/settings/fx': () => fx() } })
    await screen.findByText('7.12')
    for (const name of [/立即获取/, /手工覆盖汇率/, /调整来源/, /管理币种/]) expect(screen.getByRole('button', { name })).toBeDisabled()
  })

  it('读取失败：显示原因', async () => {
    mountApp({ url: '/app/settings/fx', pages, handlers: { ...base, '/settings/fx': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
  })
})

describe('指标口径', () => {
  const metric = (patch: Record<string, unknown> = {}) => ({
    id: 'M-001',
    name: '销售额',
    type: '我方计算',
    group: '全局与经营',
    definition: '已付款订单的商品金额之和',
    source: '订单',
    refresh: '每 15 分钟',
    version: 1,
    pages: ['订单列表'],
    reconcileWith: [{ label: '订单列表', route: '/app/orders' }],
    mismatchReasons: ['订单取消与退款的入账时间不同'],
    configurableAt: { label: '汇率设置', route: '/app/settings/fx' },
    history: [],
    ...patch,
  })
  const defs = (items: unknown[]) => ok({ items, total: items.length, page: 1, pageSize: 30, groups: ['全局与经营'], types: ['官方', '我方计算'] })

  it('显示口径、来源、刷新、版本与使用页面；没有变更记录时如实说明', async () => {
    mountApp({
      url: '/app/help/metrics',
      pages,
      handlers: {
        ...base,
        '/metrics/definitions': () => defs([metric(), metric({ id: 'M-900', name: '广告归因', type: '无官方来源', definition: '亚马逊不提供官方口径，不设指标', version: null, pages: [] })]),
      },
    })
    expect(await screen.findByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('已付款订单的商品金额之和')).toBeInTheDocument()
    expect(screen.getByText('第 1 版（暂无变更记录）')).toBeInTheDocument()
    expect(screen.getByText('不设指标')).toBeInTheDocument()
    expect(screen.getByText('共 2 个指标')).toBeInTheDocument()
  })

  it('对账页面是站内链接，可能对不上的原因与在哪里配置如实显示；没有的写“—”', async () => {
    mountApp({
      url: '/app/help/metrics',
      pages,
      handlers: { ...base, '/metrics/definitions': () => defs([metric(), metric({ id: 'M-901', name: '估算费用', reconcileWith: [], mismatchReasons: [], configurableAt: null })]) },
    })
    await screen.findByText('销售额')
    const link = await screen.findByRole('link', { name: '订单列表' })
    expect(link).toHaveAttribute('href', expect.stringContaining('/app/orders'))
    expect(screen.getByText('订单取消与退款的入账时间不同')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '汇率设置' })).toBeInTheDocument()
    const cells = Array.from(document.querySelectorAll('[row-id="M-901"]'))
    expect(cells.map(el => el.textContent).join(' ')).toContain('—')
  })

  it('搜索：请求带上关键字并回到第一页', async () => {
    const app = mountApp({ url: '/app/help/metrics', pages, handlers: { ...base, '/metrics/definitions': () => defs([metric()]) } })
    await screen.findByText('销售额')
    await userEvent.type(screen.getByPlaceholderText(/搜索指标/), '销售{enter}')
    await waitFor(() => expect(app.calls.some(call => call.path === '/metrics/definitions' && call.search.includes('q=%E9%94%80%E5%94%AE'))).toBe(true))
  })

  it('没有匹配时说明，而不是空白', async () => {
    mountApp({ url: '/app/help/metrics', pages, handlers: { ...base, '/metrics/definitions': () => defs([]) } })
    expect(await screen.findByText(/没有符合条件的指标/)).toBeInTheDocument()
  })
})
