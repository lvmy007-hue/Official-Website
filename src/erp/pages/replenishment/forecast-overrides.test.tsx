import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ForecastOverrideListResponse, ForecastOverrideRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { NO_VIEWS, rowText } from '../inventory/inventory-fixtures.test-helper'
import { forecastBody } from './forecast-form'
import { ok, recommendations, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 人工预测规则抽屉（P6-09）：列表、状态、权限禁用、新增/修改/删除的请求内容与服务端拒绝原因。

const pages: LivePages = { ReplenishmentPage: { load: () => import('./ReplenishmentPage') } }

const row = (over: Partial<ForecastOverrideRow> = {}): ForecastOverrideRow => ({
  id: 'f1',
  scopeType: 'SKU',
  scopeId: 'SKU-A',
  from: '2026-11-20',
  to: '2026-12-05',
  mode: 'FIXED',
  value: 30,
  note: '黑五备货',
  version: 2,
  status: 'UPCOMING',
  createdBy: '运营小王',
  createdAt: '2026-10-20T08:00:00Z',
  updatedAt: '2026-10-21T08:00:00Z',
  summary: '固定日销 30 件/天',
  ...over,
})

const list = (items: ForecastOverrideRow[], over: Partial<ForecastOverrideListResponse> = {}): ForecastOverrideListResponse => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  today: '2026-10-27',
  activeCount: items.length,
  activeLimit: 300,
  canManage: true,
  manageBlockedReason: null,
  priorityNote: '同一天里 SKU 规则优先于品类规则，两者都优先于模型预测。',
  ...over,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok(NO_VIEWS),
  '/replenishment/batches': () => ok({ items: [summary()], page: 1, pageSize: 20, total: 1 }),
  '/replenishment/recommendations': () => ok(recommendations()),
  '/replenishment/forecast-overrides': () => ok(list([row(), row({ id: 'f2', scopeType: 'CATEGORY', scopeId: '耳机', mode: 'YOY_FACTOR', value: 1.2, status: 'EXPIRED', summary: '去年同期 × 1.2' })])),
  ...over,
})

const openDrawer = async () => {
  await waitFor(() => expect(rowText('r1')).toContain('SKU-A'))
  await userEvent.click(screen.getByRole('button', { name: '人工预测规则' }))
  const dialog = await screen.findByRole('dialog', { name: '人工预测规则' })
  await waitFor(() => expect(within(dialog).getAllByText('SKU-A').length).toBeGreaterThan(0))
  return dialog
}
const topDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}
const ruleRowText = (id: string) => rowText(id)

describe('forecastBody', () => {
  it('新增带对象与日期（YYYY-MM-DD），备注为空写 null；修改只带可改字段和版本号', () => {
    const values = { scopeType: 'SKU' as const, scopeId: ' SKU-A ', mode: 'FIXED' as const, value: 12, note: ' ', from: undefined, to: undefined }
    expect(forecastBody(values, 'create')).toEqual({ scopeType: 'SKU', scopeId: 'SKU-A', from: '', to: '', mode: 'FIXED', value: 12, note: null })
    expect(forecastBody(values, 'update', 4)).toEqual({ version: 4, from: '', to: '', mode: 'FIXED', value: 12, note: null })
  })
})

describe('人工预测规则抽屉', () => {
  it('列出规则：对象、类型、规则内容与状态；写明未结束数量与优先级说明', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers() })
    const dialog = await openDrawer()
    expect(await within(dialog).findByText(/未结束的规则 2 \/ 300 条/)).toBeInTheDocument()
    expect(within(dialog).getByText(/同一天里 SKU 规则优先于品类规则/)).toBeInTheDocument()
    await waitFor(() => expect(ruleRowText('f1')).toContain('固定日销 30 件/天'))
    expect(ruleRowText('f1')).toContain('未开始')
    expect(ruleRowText('f2')).toContain('耳机')
    expect(ruleRowText('f2')).toContain('已结束')
  })

  it('没有“补货策略维护”权限：只能看，新增/编辑/删除都禁用，并写明原因', async () => {
    const blocked = '你没有补货策略维护权限'
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({ '/replenishment/forecast-overrides': () => ok(list([row()], { canManage: false, manageBlockedReason: blocked })) }, ['replenishment.read']),
    })
    const dialog = await openDrawer()
    expect(await within(dialog).findByText('你可以查看规则，但不能修改')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '新增规则' })).toBeDisabled()
    await waitFor(() => expect(ruleRowText('f1')).toContain('固定日销 30 件/天'))
    const edit = document.querySelector('[row-id="f1"] button[disabled]')
    expect(edit).not.toBeNull()
  })

  it('修改：带版本号与新日销提交；服务端的重叠拒绝原因原样显示', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/forecast-overrides/f1': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 409, body: { error: { code: 'CONFLICT', message: '时间段与已有规则重叠：SKU-A 2026-12-01 至 2026-12-31' } } }
        },
      }),
    })
    await openDrawer()
    await waitFor(() => expect(ruleRowText('f1')).toContain('固定日销 30 件/天'))
    const edit = Array.from(document.querySelectorAll('[row-id="f1"] button')).find(el => el.textContent?.replace(/\s/g, '') === '编辑') as HTMLElement
    await userEvent.click(edit)
    const form = await topDialog()
    const input = await within(form).findByRole('spinbutton', { name: '固定日销' })
    await userEvent.clear(input)
    await userEvent.type(input, '45')
    await userEvent.click(within(form).getByRole('button', { name: /保存修改/ }))
    await waitFor(() => expect(body).toMatchObject({ version: 2, from: '2026-11-20', to: '2026-12-05', mode: 'FIXED', value: 45, note: '黑五备货' }))
    expect((await screen.findAllByText(/时间段与已有规则重叠/)).length).toBeGreaterThan(0)
  })

  it('删除：确认后发 DELETE，并重新取数', async () => {
    let deleted = 0
    const app = mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/forecast-overrides/f1': (_url, init) => {
          if (init?.method === 'DELETE') deleted += 1
          return ok({ id: 'f1' })
        },
      }),
    })
    await openDrawer()
    await waitFor(() => expect(ruleRowText('f1')).toContain('固定日销 30 件/天'))
    const before = app.calls.filter(call => call.path === '/replenishment/forecast-overrides' && call.method === 'GET').length
    const remove = Array.from(document.querySelectorAll('[row-id="f1"] button')).find(el => el.textContent?.replace(/\s/g, '') === '删除') as HTMLElement
    await userEvent.click(remove)
    const form = await topDialog()
    await userEvent.click(within(form).getByRole('button', { name: /^删\s?除$/ }))
    await waitFor(() => expect(deleted).toBe(1))
    await waitFor(() => expect(app.calls.filter(call => call.path === '/replenishment/forecast-overrides' && call.method === 'GET').length).toBeGreaterThan(before))
  })

  it('新增：必填项为空不提交；填完后 POST 带对象、日期、方式与数值', async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/forecast-overrides': (_url, init) => {
          if (init?.method === 'POST') {
            bodies.push(JSON.parse(String(init.body)))
            return { status: 201, body: { success: true, data: row({ id: 'f9' }) } }
          }
          return ok(list([row()]))
        },
      }),
    })
    const dialog = await openDrawer()
    await userEvent.click(within(dialog).getByRole('button', { name: '新增规则' }))
    const form = await topDialog()
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    expect(await within(form).findByText('请填写 SKU 或商品类型')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.click(within(form).getByLabelText('SKU 或商品类型'))
    await userEvent.paste('SKU-B')
    await userEvent.type(within(form).getByLabelText('开始日期'), '2026-12-01{enter}')
    await userEvent.type(within(form).getByLabelText('结束日期'), '2026-12-31{enter}')
    await userEvent.click(within(form).getByRole('spinbutton', { name: '固定日销' }))
    await userEvent.paste('18')
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(bodies).toEqual([{ scopeType: 'SKU', scopeId: 'SKU-B', from: '2026-12-01', to: '2026-12-31', mode: 'FIXED', value: 18, note: null }]))
    // 整套流程（含两个日期选择器的逐字输入）在全量并行时偏慢，单独放宽超时
  }, 60_000)
})
