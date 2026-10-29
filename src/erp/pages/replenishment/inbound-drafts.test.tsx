import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { InboundDraftGroup, ToInboundDraftsPreview, ToInboundDraftsResult } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, recommendations, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 补货批次转入仓计划草稿（P6-08）：先预览、再确认；缺地址、已转过都在预览里说清楚，不能确认；以前只登记的意向可以补建。

const pages: LivePages = {
  ReplenishmentPage: { load: () => import('./ReplenishmentPage') },
  ReplenishmentBatchDetailPage: { load: () => import('./ReplenishmentBatchDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const address = { id: 'sf1', name: '深圳仓', summary: '龙岗区 1 号，深圳，GD 518000，CN', isDefault: true }
const group = (patch: Partial<InboundDraftGroup> = {}): InboundDraftGroup => ({
  key: 'st1:sf1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  address,
  addressOptions: [address, { id: 'sf2', name: '东莞仓', summary: '长安镇 2 号，东莞，GD 523000，CN', isDefault: false }],
  items: [{ recommendationId: 'r1', sku: 'SKU-A', asin: 'B000000001', title: '示例商品 A', recommendedQty: 120, quantity: 120, edited: false }],
  skuCount: 1,
  totalUnits: 120,
  planName: '补货批次 RB-20261022-001 · Northstar US',
  ...patch,
})
const preview = (patch: Partial<ToInboundDraftsPreview> = {}): ToInboundDraftsPreview => ({
  dryRun: true,
  batchId: 'b1',
  batchNo: 'RB-20261022-001',
  groups: [group()],
  converted: [],
  canConfirm: true,
  blockers: [],
  remedy: null,
  ...patch,
})
const created: ToInboundDraftsResult = {
  dryRun: false,
  batchId: 'b1',
  batchNo: 'RB-20261022-001',
  plans: [
    {
      planId: 'p1',
      name: '补货批次 RB-20261022-001 · Northstar US',
      sellerAccountId: 'st1',
      storeName: 'Northstar US',
      skuCount: 1,
      totalUnits: 120,
      shipFromAddressId: 'sf1',
      shipFromAddressName: '深圳仓',
    },
  ],
  actions: 1,
}

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/replenishment/batches': () => ok({ items: [summary()], page: 1, pageSize: 20, total: 1 }),
  '/replenishment/recommendations': () => ok(recommendations()),
  ...over,
})

const lastDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}
/** 勾选列表里的第一行（P6-09 起列表是 PagedGrid，勾选后才出现批量操作条）。 */
const selectFirstRow = async () => {
  await screen.findByText('SKU-A')
  await userEvent.click(document.querySelector('[row-id="r1"] .ag-selection-checkbox input') as HTMLElement)
  return screen.findByRole('toolbar', { name: '批量操作' })
}
const openPreview = async () => {
  const bar = await selectFirstRow()
  await userEvent.click(within(bar).getByRole('button', { name: '生成入仓计划草稿' }))
  return lastDialog()
}
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as { dryRun: boolean; items: Array<Record<string, unknown>> }

describe('补货转入仓计划草稿', () => {
  it('先预览：按店铺和地址分组、数量取建议量、明确写出不调用亚马逊；预览不创建任何东西', async () => {
    const bodies: Array<{ dryRun: boolean; items: Array<Record<string, unknown>> }> = []
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/to-inbound-drafts': (_url, init) => {
          bodies.push(requestBody(init))
          return ok(preview())
        },
      }),
    })
    const dialog = await openPreview()
    expect(await within(dialog).findByText('补货批次 RB-20261022-001 · Northstar US')).toBeInTheDocument()
    expect(within(dialog).getByText('只生成本地草稿，不会调用亚马逊')).toBeInTheDocument()
    expect(within(dialog).getByText('龙岗区 1 号，深圳，GD 518000，CN')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('SKU-A 数量')).toHaveValue('120')
    expect(bodies).toEqual([{ dryRun: true, items: [{ recommendationId: 'r1' }] }])
    expect(within(dialog).getByRole('button', { name: /确认生成 1 份草稿/ })).toBeEnabled()
  })

  it('改数量：带着新数量重新取预览；确认时用 dryRun:false 提交同样的内容，成功后列出新草稿', async () => {
    const bodies: Array<{ dryRun: boolean; items: Array<Record<string, unknown>> }> = []
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/to-inbound-drafts': (_url, init) => {
          const body = requestBody(init)
          bodies.push(body)
          if (!body.dryRun) return ok(created)
          const qty = body.items[0]?.qty
          return ok(
            preview(
              typeof qty === 'number'
                ? { groups: [group({ items: [{ recommendationId: 'r1', sku: 'SKU-A', asin: 'B000000001', title: '示例商品 A', recommendedQty: 120, quantity: qty, edited: true }], totalUnits: qty })] }
                : {},
            ),
          )
        },
      }),
    })
    const dialog = await openPreview()
    const input = await within(dialog).findByLabelText('SKU-A 数量')
    await userEvent.clear(input)
    await userEvent.type(input, '55')
    await waitFor(() => expect(bodies.some(body => body.dryRun && body.items[0]?.qty === 55)).toBe(true))
    expect(await within(dialog).findByText('已改')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /确认生成/ }))
    expect(await screen.findByText(/已转入 1 份草稿/)).toBeInTheDocument()
    const commit = bodies.filter(body => !body.dryRun)
    expect(commit).toEqual([{ dryRun: false, items: [{ recommendationId: 'r1', qty: 55 }] }])
    expect(screen.getByRole('link', { name: '补货批次 RB-20261022-001 · Northstar US' })).toHaveAttribute('href', '/app/supply-chain/p1')
  })

  it('店铺没有发货地址：逐条写原因并指到“发货地址”设置页，确认按钮禁用', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/to-inbound-drafts': () =>
          ok(
            preview({
              groups: [group({ address: null, addressOptions: [] })],
              canConfirm: false,
              blockers: ['店铺 Northstar US 还没有发货地址，请先到“发货地址”设置里添加'],
              remedy: { label: '去设置发货地址', path: '/app/settings/ship-from' },
            }),
          ),
      }),
    })
    const dialog = await openPreview()
    expect(await within(dialog).findByText('现在还不能生成')).toBeInTheDocument()
    expect(within(dialog).getByText(/还没有发货地址，请先到/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '去设置发货地址' })).toHaveAttribute('href', '/app/settings/ship-from')
    expect(within(dialog).getByRole('button', { name: /确认生成/ })).toBeDisabled()
  })

  it('已经转过草稿的建议：指出在哪份草稿里，不重复生成', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/to-inbound-drafts': () =>
          ok(
            preview({
              groups: [],
              converted: [{ recommendationId: 'r1', sku: 'SKU-A', planId: 'p9', planName: '补货批次 RB-20261022-001 · Northstar US', planStage: 'DRAFT' }],
              canConfirm: false,
              blockers: ['SKU-A 已转过入仓计划草稿'],
            }),
          ),
      }),
    })
    const dialog = await openPreview()
    expect(await within(dialog).findByText('这些建议已经转过草稿，默认不重复生成')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /补货批次 RB-20261022-001 · Northstar US/ })).toHaveAttribute('href', '/app/supply-chain/p9')
    expect(within(dialog).getByRole('button', { name: /确认生成/ })).toBeDisabled()
  })

  it('服务端拒绝：显示原因，不假装成功', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({ '/replenishment/batches/b1/to-inbound-drafts': () => ({ status: 409, body: { error: { code: 'CONFLICT', message: '补货批次正在被别人转换，请稍后重试' } } }) }),
    })
    const dialog = await openPreview()
    expect(await within(dialog).findByText(/补货批次正在被别人转换/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /确认生成/ })).toBeDisabled()
  })

  it('没有入仓计划写权限：按钮禁用', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({}, ['replenishment.read', 'replenishment.plan.create']) })
    const bar = await selectFirstRow()
    expect(within(bar).getByRole('button', { name: '生成入仓计划草稿' })).toBeDisabled()
  })
})

describe('补建入仓草稿（以前只登记了意向）', () => {
  const intent = {
    actionId: 'a1',
    batchId: 'b1',
    batchNo: 'RB-20261022-001',
    recommendationId: 'r1',
    sellerAccountId: 'st1',
    storeName: 'Northstar US',
    sku: 'SKU-A',
    asin: 'B000000001',
    title: '示例商品 A',
    qty: 80,
    registeredAt: '2026-12-05T08:00:00Z',
  }

  it('没有待补建的意向：不显示入口', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/intents': () => ok({ items: [], page: 1, pageSize: 20, total: 0 }) }) })
    await screen.findByText('SKU-A')
    expect(screen.queryByRole('button', { name: /补建入仓草稿/ })).not.toBeInTheDocument()
  })

  it('有待补建的意向：入口带数量；勾选后补建，数量预填为当时登记的 80', async () => {
    const bodies: Array<{ dryRun: boolean; items: Array<Record<string, unknown>> }> = []
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/intents': () => ok({ items: [intent], page: 1, pageSize: 20, total: 1 }),
        '/replenishment/batches/b1/to-inbound-drafts': (_url, init) => {
          bodies.push(requestBody(init))
          return ok(
            preview({
              groups: [group({ items: [{ recommendationId: 'r1', sku: 'SKU-A', asin: 'B000000001', title: '示例商品 A', recommendedQty: 120, quantity: 80, edited: true }], totalUnits: 80 })],
            }),
          )
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '补建入仓草稿（1）' }))
    const drawer = (await screen.findByText(/这些建议以前点过/)).closest('.ant-drawer-content') as HTMLElement
    expect(await within(drawer).findByText('RB-20261022-001')).toBeInTheDocument()
    await userEvent.click(drawer.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = await within(drawer).findByRole('toolbar', { name: '批量操作' })
    await userEvent.click(within(bar).getByRole('button', { name: '补建入仓计划草稿' }))
    const dialog = await lastDialog()
    expect(await within(dialog).findByLabelText('SKU-A 数量')).toHaveValue('80')
    expect(bodies[0]).toEqual({ dryRun: true, items: [{ recommendationId: 'r1', qty: 80 }] })
  })
})
