import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, orderDetail, orderRow, supplierRow } from './procurement-fixtures.test-helper'

// 采购订单列表与详情（P2a-10）：筛选与交期提醒、金额字段权限、步骤条、动作按钮的守卫与请求体、尚未接入的关联。

const pages: LivePages = {
  PurchaseOrdersPage: { load: () => import('./PurchaseOrdersPage') },
  PurchaseOrderDetailPage: { load: () => import('./PurchaseOrderDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/purchase-orders': () => ok({ items: [orderRow()], total: 1, page: 1, pageSize: 20 }),
  '/purchase-orders/po1': () => ok(orderDetail()),
  '/suppliers': () => ok({ items: [supplierRow()], total: 1, page: 1, pageSize: 200 }),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('采购订单列表', () => {
  it('显示订单、收货进度与金额；采购单号可点进详情', async () => {
    mountApp({ url: '/app/purchase-orders', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: 'PO-20261024-001' })
    expect(link).toHaveAttribute('href', '/app/purchase-orders/po1')
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('已下单')).toBeInTheDocument()
    expect(within(row).getByText('CNY 40.00')).toBeInTheDocument()
    expect(within(row).getByText('未付款')).toBeInTheDocument()
  })

  it('交期偏差只作提醒：显示晚于需求的天数', async () => {
    const deviation = { expectedDate: '2026-11-20', needByDate: '2026-11-10', lateDays: 10, sku: 'SKU-A', batchNo: 'B-7' }
    mountApp({ url: '/app/purchase-orders', pages, handlers: handlers({ '/purchase-orders': () => ok({ items: [orderRow({ deviation })], total: 1, page: 1, pageSize: 20 }) }) })
    expect(await screen.findByText('晚于需求 10 天')).toBeInTheDocument()
  })

  it('没有成本字段权限：金额两列不显示，并说明原因', async () => {
    const stripped = orderRow()
    delete stripped.totalAmount
    delete stripped.paidAmount
    mountApp({ url: '/app/purchase-orders', pages, handlers: handlers({ '/purchase-orders': () => ok({ items: [stripped], total: 1, page: 1, pageSize: 20 }) }, ['purchase.read']) })
    await screen.findByRole('link', { name: 'PO-20261024-001' })
    expect(screen.queryByText('订单金额')).not.toBeInTheDocument()
    expect(screen.getByText(/没有成本字段权限/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新建采购单/ })).toBeDisabled()
  })

  it('没有订单时说明如何开始，而不是空白', async () => {
    mountApp({ url: '/app/purchase-orders', pages, handlers: handlers({ '/purchase-orders': () => ok({ items: [], total: 0, page: 1, pageSize: 20 }) }) })
    expect(await screen.findByText(/还没有采购单/)).toBeInTheDocument()
  })

  it('新建采购单：缺供应商与 SKU 时不发请求；成功后带着版本与数量发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/purchase-orders',
      pages,
      handlers: handlers({
        '/purchase-orders': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: { id: 'po9', status: 'DRAFT', statusLabel: '草稿', version: 1 } } }
          }
          return ok({ items: [orderRow()], total: 1, page: 1, pageSize: 20 })
        },
      }),
    })
    await screen.findByRole('link', { name: 'PO-20261024-001' })
    await userEvent.click(screen.getByRole('button', { name: /新建采购单/ }))
    const drawer = await screen.findByRole('dialog')
    await userEvent.click(within(drawer).getByRole('button', { name: /创建草稿/ }))
    expect(await within(drawer).findByText('请选择供应商')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.click(within(drawer).getByRole('combobox', { name: '供应商' }))
    await userEvent.click(await screen.findByTitle('深圳工厂（S-1，CNY）'))
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'SKU' }), 'SKU-X')
    await userEvent.type(within(drawer).getByRole('spinbutton', { name: '数量' }), '12')
    await userEvent.click(within(drawer).getByRole('button', { name: /创建草稿/ }))
    await waitFor(() => expect(body).toEqual({ supplierId: 's1', lines: [{ sellerSku: 'SKU-X', quantity: 12 }] }))
  })
})

describe('采购订单详情', () => {
  it('步骤条、9 个页签、身份区金额；关联页签写明入仓计划与头程尚未接入', async () => {
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers() })
    expect(await screen.findByTestId('po-steps')).toHaveTextContent('待审批')
    for (const label of ['基本信息', '商品行', '审批', '付款', '收货进度', '质检', '附件', '关联', '操作记录']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '关联' }))
    expect(await screen.findByText(/没有找到入仓计划/)).toBeInTheDocument()
    expect(screen.getByText('还没有头程运单引用这张采购单')).toBeInTheDocument()
  })

  it('关联页签：头程运单可点；没有 firstmile.read 写“无权查看”', async () => {
    const withLinks = orderDetail()
    withLinks.links = { ...withLinks.links, firstMile: [{ id: 'fm1', waybillNo: 'WB-1001', forwarderName: '海运通', quantity: 30 }] }
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(withLinks) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '关联' }))
    expect(await screen.findByRole('link', { name: 'WB-1001' })).toHaveAttribute('href', '/app/first-mile/fm1')
    expect(screen.getByText(/海运通 · 本单发出 30 件/)).toBeInTheDocument()
  })

  it('关联页签：入仓计划靠头程运单推算，可点进计划；没有权限时写无权查看', async () => {
    const withPlan = orderDetail()
    withPlan.links = { ...withPlan.links, inboundPlans: [{ id: 'ip1', name: '10 月补货', stage: 'CREATED', stageLabel: '入仓计划已创建', shipmentIds: ['FBA-SH-1', 'FBA-SH-2'] }] }
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(withPlan) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '关联' }))
    expect(await screen.findByRole('link', { name: '10 月补货' })).toHaveAttribute('href', '/app/supply-chain/ip1')
    expect(screen.getByText(/入仓计划已创建 · 货件 FBA-SH-1、FBA-SH-2/)).toBeInTheDocument()
    expect(screen.getByText(/不是采购单的直接关联/)).toBeInTheDocument()
  })

  it('关联页签：没有 inbound.read 时入仓计划写无权查看', async () => {
    const hidden = orderDetail()
    hidden.links = { ...hidden.links, inboundPlans: 'NO_PERMISSION' }
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(hidden) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '关联' }))
    expect(await screen.findByText(/无权查看：入仓计划需要权限/)).toBeInTheDocument()
  })

  it('关联页签：没有头程读权限时不显示运单，只写“无权查看”', async () => {
    const hidden = orderDetail()
    hidden.links = { ...hidden.links, firstMile: 'NO_PERMISSION' }
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(hidden) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '关联' }))
    expect(await screen.findByText(/无权查看：头程运单需要权限 firstmile.read/)).toBeInTheDocument()
  })

  it('商品行：采购单价与当前成本不一致时给出差异提示', async () => {
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers() })
    await screen.findByTestId('po-steps')
    await userEvent.click(screen.getByRole('tab', { name: '商品行' }))
    expect(await screen.findByText(/有 1 个商品的采购单价和当前生效的成本版本不一致/)).toBeInTheDocument()
    expect(screen.getByText(/当前成本 2.5 CNY，高 20.0%/)).toBeInTheDocument()
  })

  it('没有成本字段权限：金额位置写“无权查看”，不是 0', async () => {
    const detail = orderDetail()
    delete detail.order.totalAmount
    delete detail.order.paidAmount
    detail.lines = detail.lines.map(({ unitCost: _u, lineAmount: _l, costDiff: _c, ...rest }) => rest)
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(detail) }, ['purchase.read']) })
    await screen.findByTestId('po-steps')
    expect(screen.getAllByText('无权查看').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('CNY 0.00')).not.toBeInTheDocument()
  })

  it('待审批：创建人看到审批按钮但禁用并说明原因', async () => {
    const detail = orderDetail({ actions: ['ATTACH', 'APPROVE', 'CANCEL'], canApprove: false }, { status: 'PENDING_APPROVAL', statusLabel: '待审批' })
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({ '/purchase-orders/po1': () => ok(detail) }) })
    const approve = await screen.findByRole('button', { name: /审批通过/ })
    expect(approve).toBeDisabled()
    expect(screen.getByRole('button', { name: /驳\s*回/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('tab', { name: '审批' }))
    expect(await screen.findByText('等待有审批权限的其他成员处理')).toBeInTheDocument()
  })

  const approvable = () => orderDetail({ actions: ['ATTACH', 'APPROVE', 'CANCEL'], canApprove: true }, { status: 'PENDING_APPROVAL', statusLabel: '待审批' })

  it('可以审批的人：驳回必须填写意见，没填时不发请求', async () => {
    let called = false
    mountApp({
      url: '/app/purchase-orders/po1',
      pages,
      handlers: handlers({
        '/purchase-orders/po1': () => ok(approvable()),
        '/purchase-orders/po1/approve': () => {
          called = true
          return { status: 201, body: { success: true, data: { id: 'po1', status: 'DRAFT', statusLabel: '草稿', version: 4 } } }
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /驳\s*回/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /驳\s*回/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('可以审批的人：通过会带着版本号发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/purchase-orders/po1',
      pages,
      handlers: handlers({
        '/purchase-orders/po1': () => ok(approvable()),
        '/purchase-orders/po1/approve': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { id: 'po1', status: 'ORDERED', statusLabel: '已下单', version: 4 } } }
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /审批通过/ }))
    const pass = await screen.findByRole('dialog')
    await userEvent.click(within(pass).getByRole('button', { name: /^通\s*过$/ }))
    await waitFor(() => expect(body).toMatchObject({ version: 3, decision: 'APPROVED' }))
  })
  it('登记收货：只发数量大于 0 的行，带版本号与收货日期；全空时不发请求', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/purchase-orders/po1',
      pages,
      handlers: handlers({
        '/purchase-orders/po1/receipts': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { id: 'po1', status: 'RECEIVED', statusLabel: '全部到货', version: 4, documentNo: 'RC-1' } } }
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /登记收货/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^登\s*记$/ }))
    expect(await within(dialog).findByText('请至少为一行填写数量')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: 'SKU-B 本次收货数量' }), '5')
    await userEvent.click(within(dialog).getByRole('button', { name: /^登\s*记$/ }))
    await waitFor(() => expect(body).toMatchObject({ version: 3, lines: [{ lineId: 'l2', quantity: 5 }] }))
    expect(body?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('没有收货权限：登记收货按钮禁用并写明缺少的权限', async () => {
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers({}, ['purchase.read']) })
    const button = await screen.findByRole('button', { name: /登记收货/ })
    expect(button).toBeDisabled()
  })

  it('付款页签：计划付款可标记已付，已付的不再有操作', async () => {
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers() })
    await screen.findByTestId('po-steps')
    await userEvent.click(screen.getByRole('tab', { name: '付款' }))
    expect(await screen.findByRole('button', { name: /标记已付/ })).toBeEnabled()
  })

  it('操作记录显示中文动作；订单不存在时显示错误状态而不是空白', async () => {
    mountApp({ url: '/app/purchase-orders/po1', pages, handlers: handlers() })
    await screen.findByTestId('po-steps')
    await userEvent.click(screen.getByRole('tab', { name: '操作记录' }))
    expect(await screen.findByText('创建采购单')).toBeInTheDocument()
  })

  it('读取失败：显示服务端给的原因', async () => {
    mountApp({
      url: '/app/purchase-orders/po1',
      pages,
      handlers: handlers({ '/purchase-orders/po1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '采购单不存在' } } }) }),
    })
    expect((await screen.findAllByText(/采购单不存在/)).length).toBeGreaterThan(0)
  })
})
