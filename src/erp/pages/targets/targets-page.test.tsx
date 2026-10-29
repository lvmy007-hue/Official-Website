import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, defaultScopeOptions, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 目标与预算（P2a-04）：选店铺与期间、整店目标网格、细化目标、编辑、变更历史。

const pages: LivePages = { TargetsPage: { load: () => import('./TargetsPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })
afterEach(() => vi.unstubAllGlobals())

const progress = (patch: Record<string, unknown> = {}) => ({
  state: 'NOT_SET',
  note: null,
  asOf: null,
  actualToDate: null,
  expectedToDate: null,
  achievementRatio: null,
  elapsedDays: null,
  totalDays: null,
  paceFallback: false,
  forecast: null,
  ...patch,
})

const row = (metric: string, patch: Record<string, unknown> = {}) => ({
  id: null,
  dimension: 'STORE',
  dimensionRef: 'ALL',
  metric,
  targetValue: null,
  paceMode: 'LINEAR',
  note: null,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  progress: progress(),
  ...patch,
})

const grid = (patch: Record<string, unknown> = {}) => ({
  sellerAccountId: 'st1',
  periodKind: 'MONTH',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  currency: 'USD',
  storeRows: [
    row('SALES', {
      id: 'bt-1',
      targetValue: 10000,
      version: 1,
      updatedAt: '2026-10-05T00:00:00Z',
      updatedBy: '林然',
      progress: progress({ state: 'OK', asOf: '2026-10-15', actualToDate: 3000, expectedToDate: 4838.7, achievementRatio: 0.3, elapsedDays: 15, totalDays: 31 }),
    }),
    row('ORDERS'),
    row('UNITS'),
    row('PROFIT'),
    row('ADS_SPEND'),
  ],
  customRows: [],
  metrics: [
    { key: 'SALES', label: '销售额' },
    { key: 'ORDERS', label: '订单数' },
    { key: 'UNITS', label: '件数' },
    { key: 'PROFIT', label: '净利润' },
    { key: 'ADS_SPEND', label: '广告花费' },
  ],
  ...patch,
})

const history = (items: unknown[] = []) => ok({ items })

const baseHandlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/targets': () => ok(grid()),
  '/targets/history': () => history(),
  ...over,
})

describe('目标与预算', () => {
  it('没有被授权的店铺：如实说明，不显示网格', async () => {
    mountApp({ url: '/app/targets', pages, scopeOptions: { ...defaultScopeOptions, stores: [] }, handlers: baseHandlers() })
    expect(await screen.findByText(/你还没有被授予任何店铺的数据访问范围/)).toBeInTheDocument()
  })

  it('默认选中第一个店铺与本月：显示整店目标网格，已设置的行有达成进度，没设置的行写“尚未设置”', async () => {
    const app = mountApp({ url: '/app/targets', pages, handlers: baseHandlers() })
    await screen.findByText('销售额')
    expect(app.calls.some(call => call.path === '/targets' && call.search.includes('sellerAccountId=st1'))).toBe(true)
    expect(within(screen.getByText('销售额').closest('tr, [role=row]')!).getByText('10,000')).toBeInTheDocument()
    expect(within(screen.getByText('销售额').closest('tr, [role=row]')!).getByText(/达成 30\.0%/)).toBeInTheDocument()
    expect(within(screen.getByText('订单数').closest('tr, [role=row]')!).getAllByText('尚未设置').length).toBeGreaterThan(0)
  })

  it('切换店铺：带新的 sellerAccountId 重新取数', async () => {
    const app = mountApp({ url: '/app/targets', pages, handlers: baseHandlers() })
    await screen.findByText('销售额')
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '目标店铺' }))
    fireEvent.click(await screen.findByText('Oak & Pine', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/targets' && call.search.includes('sellerAccountId=st2'))).toBe(true))
  })

  it('切换周期粒度为“季”：带 periodKind=QUARTER 与季度首月重新取数', async () => {
    const app = mountApp({ url: '/app/targets', pages, handlers: baseHandlers() })
    await screen.findByText('销售额')
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '周期粒度' }))
    fireEvent.click(await screen.findByText('季', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/targets' && call.search.includes('periodKind=QUARTER'))).toBe(true))
  })

  it('编辑目标：填写新值提交，成功后刷新网格', async () => {
    let putBody: unknown
    const app = mountApp({
      url: '/app/targets',
      pages,
      handlers: baseHandlers({
        '/targets': (_url, init) => {
          if (init?.method !== 'PUT') return ok(grid())
          putBody = JSON.parse(String(init.body))
          return ok({ row: row('SALES', { id: 'bt-1', targetValue: 12000, version: 2 }) })
        },
      }),
    })
    await screen.findByText('销售额')
    await userEvent.click(within(screen.getByText('销售额').closest('tr, [role=row]')!).getByRole('button', { name: '编辑目标' }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('目标值')
    await userEvent.clear(input)
    await userEvent.type(input, '12000')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(putBody).toMatchObject({ sellerAccountId: 'st1', periodKind: 'MONTH', periodStart: '2026-10-01', metric: 'SALES', targetValue: 12000, version: 1 }))
    expect(app.calls.filter(call => call.path === '/targets' && call.method === 'GET').length).toBeGreaterThanOrEqual(2)
  })

  it('新增细化目标：按 ASIN 组设置目标', async () => {
    let putBody: unknown
    mountApp({
      url: '/app/targets',
      pages,
      handlers: baseHandlers({
        '/targets': (_url, init) => {
          if (init?.method !== 'PUT') return ok(grid())
          putBody = JSON.parse(String(init.body))
          return ok({ row: row('SALES') })
        },
      }),
    })
    await screen.findByText('销售额')
    await userEvent.click(screen.getByRole('button', { name: '新增细化目标' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.mouseDown(within(dialog).getByLabelText('维度'))
    fireEvent.click(await screen.findByText('ASIN 组', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(within(dialog).getByLabelText('ASIN 组'), 'B0XXXXXXX1')
    fireEvent.mouseDown(within(dialog).getByLabelText('指标'))
    fireEvent.click(await screen.findByText('销售额', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(within(dialog).getByLabelText('目标值'), '500')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(putBody).toMatchObject({ dimension: 'ASIN', dimensionRef: 'B0XXXXXXX1', metric: 'SALES', targetValue: 500, version: 0 }))
  })

  it('变更历史：显示改预算事件', async () => {
    mountApp({
      url: '/app/targets',
      pages,
      handlers: baseHandlers({
        '/targets/history': () =>
          history([{ id: 'ev-1', at: '2026-10-05T00:00:00Z', dimension: 'STORE', dimensionRef: 'ALL', metric: 'SALES', title: '整店 · 新设 销售额目标：10000', actor: '林然' }]),
      }),
    })
    const section = await screen.findByTestId('targets-history')
    expect(await within(section).findByText('整店 · 新设 销售额目标：10000')).toBeInTheDocument()
  })

  it('没有 targets.write 权限：编辑与新增按钮禁用', async () => {
    mountApp({ url: '/app/targets', pages, me: { ...defaultMe, permissions: ['targets.read'] }, handlers: baseHandlers() })
    await screen.findByText('销售额')
    expect(within(screen.getByText('销售额').closest('tr, [role=row]')!).getByRole('button', { name: '编辑目标' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '新增细化目标' })).toBeDisabled()
  })
})
