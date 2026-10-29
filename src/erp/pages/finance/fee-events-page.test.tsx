import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { rowTextOf } from '../../test/grid-rows'
import { feeDetail, feeList, feeRow, feeSummary, ok } from './fee-fixtures.test-helper'

// 费用事件页（P2b-05）：9 个页签与笔数、范围参数与新鲜度、没有数据与没有交易状态的写法、筛选与游标翻页、
// 标记差异与对账备注（必填、版本号、权限置灰）、查看证据、发起导出（条件与页面一致）。

const pages: LivePages = { FeeEventsPage: { load: () => import('./FeeEventsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/finance/events': () => ok(feeList()),
  '/finance/events/summary': () => ok(feeSummary()),
  '/finance/events/fe1': () => ok(feeDetail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})
// AG Grid 把固定列与滚动列放在不同容器里，一行的按钮和文字分处两个容器；这些用例每页只有一行，所以等第一行出来后在整页里找。
const loadedRows = async (label: string): Promise<HTMLElement> => {
  await screen.findByText(label, {}, { timeout: 15000 })
  return document.body
}
const TAB_LABELS = ['配送费', '佣金', '仓储费', '库龄附加费', '入仓配置费', '移除与弃置费', '退款', '赔付', '其他调整']

describe('费用事件列表', () => {
  it('9 个页签带笔数；请求带范围参数与默认页签；默认范围提示与新鲜度', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/finance?storeIds=st1&from=2026-10-01&to=2026-10-07', pages, handlers: handlers() })
    expect(await screen.findByText('FBA Per Unit Fulfillment Fee', {}, { timeout: 15000 })).toBeInTheDocument()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs).toHaveLength(9)
    expect(tabs[0].textContent).toBe('配送费（3）')
    expect(tabs[2].textContent).toBe('仓储费（1）')
    expect(tabs[1].textContent).toBe('佣金（0）')
    for (const label of TAB_LABELS) expect(screen.getByRole('tab', { name: new RegExp(label) })).toBeInTheDocument()
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/finance/events')!
    const params = new URLSearchParams(call.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('from')).toBe('2026-10-01')
    expect(params.get('category')).toBe('FULFILLMENT')
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-24 至 2026-10-23 的费用（最近 30 天）/)).toBeInTheDocument()
    expect(screen.getByText(/标记有差异/)).toBeInTheDocument()
  })

  it('金额带符号；没有交易状态、没有订单、没有结算单都写明白，不留空白；订单号链到订单详情', async () => {
    const report = feeRow({
      id: 'fe2',
      category: 'STORAGE',
      categoryLabel: '仓储费',
      subtype: 'STORAGE_FEE',
      subtypeLabel: 'STORAGE FEE',
      transactionStatus: null,
      transactionStatusLabel: null,
      amazonOrderId: null,
      shipmentId: null,
      source: 'STORAGE_REPORT',
      sourceLabel: '月度仓储费报告',
    })
    mountApp({ url: '/app/finance', pages, handlers: handlers({ '/finance/events': () => ok(feeList([feeRow(), report])) }) })
    const link = await screen.findByRole('link', { name: /111-0000001-0000001/ }, { timeout: 15000 })
    expect(link.getAttribute('href')).toMatch(/^\/app\/orders\/111-0000001-0000001(\?|$)/)
    expect(document.body.textContent).toContain('-$3.50')
    const second = rowTextOf(screen.getByText('STORAGE FEE'))
    expect(second).toContain('无交易状态')
    expect(second).toContain('无订单')
    expect(second).toContain('月度仓储费报告')
  })

  it('没有订单读取权限时订单号不是链接', async () => {
    mountApp({ url: '/app/finance', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByText('FBA Per Unit Fulfillment Fee', {}, { timeout: 15000 })
    expect(screen.queryByRole('link', { name: /111-0000001-0000001/ })).not.toBeInTheDocument()
    expect(screen.getByText('111-0000001-0000001')).toBeInTheDocument()
  })

  it('没有数据：只写原因，没有示例行；这一类尚无记录；不出现 0 元', async () => {
    mountApp({
      url: '/app/finance',
      pages,
      handlers: handlers({ '/finance/events': () => ok(feeList([])), '/finance/events/summary': () => ok(feeSummary({ FULFILLMENT: { count: 0, totals: [], discrepancyCount: 0 } })) }),
    })
    expect(await screen.findByText(/所选日期范围内尚无费用事件记录/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByText('所选范围内这一类尚无记录')).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('切换页签：换类别请求并从第一块重新取；搜索把关键字发给服务端；每块 100 行不带页码', async () => {
    const seen: Array<{ category: string | null; q: string | null; cursor: string | null; pageSize: string | null; page: string | null }> = []
    mountApp({
      url: '/app/finance',
      pages,
      handlers: handlers({
        '/finance/events': url => {
          const get = (key: string) => url.searchParams.get(key)
          seen.push({ category: get('category'), q: get('q'), cursor: get('cursor'), pageSize: get('pageSize'), page: get('page') })
          return ok(feeList([feeRow()]))
        },
      }),
    })
    await screen.findByText('FBA Per Unit Fulfillment Fee', {}, { timeout: 15000 })
    expect(seen[0]).toMatchObject({ category: 'FULFILLMENT', cursor: null, pageSize: '100', page: null })
    await userEvent.click(screen.getByRole('tab', { name: /仓储费/ }))
    await waitFor(() => expect(seen.some(item => item.category === 'STORAGE')).toBe(true))
    expect(seen.filter(item => item.category === 'STORAGE')[0].cursor).toBeNull()
    expect(screen.getByText(/月度仓储费、超限费/)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索费用事件' }), '111-000{Enter}')
    await waitFor(() => expect(seen.some(item => item.q === '111-000')).toBe(true))
  })
})

describe('标记差异与对账备注', () => {
  const patchHandlers = (bodies: unknown[], over: Record<string, Handler> = {}) =>
    handlers({
      '/finance/events/fe1/reconciliation': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ id: 'fe1', version: 2, reconciliationStatus: 'DISCREPANCY' })
      },
      ...over,
    })

  it('标记差异：必须写差异说明；请求带版本号、状态与说明', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    mountApp({ url: '/app/finance', pages, handlers: patchHandlers(bodies) })
    const row = await loadedRows('FBA Per Unit Fulfillment Fee')
    await userEvent.click(within(row).getByRole('button', { name: '标记差异' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /标\s*记/ }))
    expect(await within(dialog).findByText('请写明差在哪里')).toBeInTheDocument()
    expect(bodies.length).toBe(0)
    await userEvent.type(within(dialog).getByRole('textbox', { name: '差异说明' }), '与结算单不符')
    await userEvent.click(within(dialog).getByRole('button', { name: /标\s*记/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toEqual({ version: 1, status: 'DISCREPANCY', note: '与结算单不符' })
  })

  it('已标记差异的行显示“取消差异标记”，请求把状态改回未对账', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    const marked = feeRow({ reconciliationStatus: 'DISCREPANCY', reconciliationLabel: '有差异', reconciliationNote: '金额不符', version: 4 })
    mountApp({ url: '/app/finance', pages, handlers: patchHandlers(bodies, { '/finance/events': () => ok(feeList([marked])) }) })
    const row = await loadedRows('FBA Per Unit Fulfillment Fee')
    expect(within(row).getByText('有差异')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '标记差异' })).not.toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '取消差异标记' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /取消标记/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toEqual({ version: 4, status: 'UNRECONCILED' })
  })

  it('对账备注：只发备注，不带状态', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    mountApp({ url: '/app/finance', pages, handlers: patchHandlers(bodies) })
    const row = await loadedRows('FBA Per Unit Fulfillment Fee')
    await userEvent.click(within(row).getByRole('button', { name: '对账备注' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '备注' }), '等结算单')
    await userEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toEqual({ version: 1, note: '等结算单' })
  })
})

describe('权限置灰', () => {
  it('只有 finance.read：标记差异与对账备注按钮不可点；查看证据可点', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/finance', pages, handlers: handlers({}, ['finance.read']) })
    const row = await loadedRows('FBA Per Unit Fulfillment Fee')
    expect(within(row).getByRole('button', { name: '标记差异' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: '对账备注' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: '查看证据' })).toBeEnabled()
  })
})

describe('查看证据', () => {
  it('抽屉显示费用明细、来源交易与关联标识、同一笔交易的其他明细、对账变更记录；订单号链到订单', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/finance', pages, handlers: handlers() })
    const row = await loadedRows('FBA Per Unit Fulfillment Fee')
    await userEvent.click(within(row).getByRole('button', { name: '查看证据' }))
    const drawer = await screen.findByRole('dialog', {}, { timeout: 15000 })
    expect(await within(drawer).findByText('TX-ABC-1')).toBeInTheDocument()
    expect(within(drawer).getByText('SHIPMENT_ID：FBA15ABCDE')).toBeInTheDocument()
    expect(within(drawer).getByText(/Commission/)).toBeInTheDocument()
    expect(within(drawer).getByText(/对账状态：未对账 → 有差异/)).toBeInTheDocument()
    expect(within(drawer).getByText(/王运营/)).toBeInTheDocument()
    expect(
      within(drawer)
        .getByRole('link', { name: /111-0000001-0000001/ })
        .getAttribute('href'),
    ).toMatch(/^\/app\/orders\/o1(\?|$)/)
    expect(app.calls.some(call => call.path === '/finance/events/fe1')).toBe(true)
  })

  it('报告类费用没有来源交易：说明来源，不显示空白', { timeout: 30000 }, async () => {
    const report = feeRow({
      id: 'fe2',
      category: 'STORAGE',
      categoryLabel: '仓储费',
      subtypeLabel: 'STORAGE FEE',
      source: 'STORAGE_REPORT',
      sourceLabel: '月度仓储费报告',
      transactionStatus: null,
      transactionStatusLabel: null,
      amazonOrderId: null,
    })
    mountApp({
      url: '/app/finance',
      pages,
      handlers: handlers({
        '/finance/events': () => ok(feeList([report])),
        '/finance/events/fe2': () => ok(feeDetail({ event: report, transaction: null, siblings: [], history: [], orderId: null })),
      }),
    })
    const row = await loadedRows('STORAGE FEE')
    await userEvent.click(within(row).getByRole('button', { name: '查看证据' }))
    const drawer = await screen.findByRole('dialog', {}, { timeout: 15000 })
    expect(await within(drawer).findByText(/没有对应的交易流水/)).toBeInTheDocument()
    expect(within(drawer).getByText('还没有对账变更')).toBeInTheDocument()
  })
})

describe('发起导出', () => {
  it('条件与页面一致：页签、筛选、时间范围用列表返回的起止时刻；提交到导出中心', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, any>> = []
    mountApp({
      url: '/app/finance?storeIds=st1',
      pages,
      handlers: handlers({
        '/exports': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok({ id: 'e1' })
        },
      }),
    })
    await screen.findByText('FBA Per Unit Fulfillment Fee', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('button', { name: '发起导出' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/不含销售收入与税/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /发起导出/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      kind: 'fee-events',
      format: 'CSV',
      filters: { storeIds: ['st1'], category: 'FULFILLMENT', fromAt: '2026-09-24T07:00:00.000Z', toAt: '2026-10-24T07:00:00.000Z' },
    })
    expect(bodies[0].filterSummary).toContain('配送费')
  })

  it('没有导出权限：按钮置灰', async () => {
    mountApp({ url: '/app/finance', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByText('FBA Per Unit Fulfillment Fee', {}, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '发起导出' })).toBeDisabled()
  })
})
