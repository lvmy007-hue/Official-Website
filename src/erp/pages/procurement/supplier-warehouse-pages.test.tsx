import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { count, movement, ok, orderRow, stock, supplierDetail, supplierRow } from './procurement-fixtures.test-helper'

// 供应商列表与详情、国内仓库存/流水/盘点（P2a-10）：样本不足的写法、成本权限、盘点审批的守卫。

const pages: LivePages = {
  SuppliersPage: { load: () => import('./SuppliersPage') },
  SupplierDetailPage: { load: () => import('./SupplierDetailPage') },
  DomesticWarehousePage: { load: () => import('./DomesticWarehousePage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/suppliers': () => ok({ items: [supplierRow()], total: 1, page: 1, pageSize: 20 }),
  '/suppliers/s1': () => ok(supplierDetail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  '/domestic-warehouse/stock': () => ok(stock()),
  '/domestic-warehouse/movements': () => ok({ items: [movement()], total: 1, page: 1, pageSize: 20 }),
  '/stock-counts': () => ok({ items: [count()], total: 1, page: 1, pageSize: 20 }),
  ...over,
})

describe('供应商', () => {
  it('列表：评级与准时率样本不足时写“样本不足”，不是 0%', async () => {
    mountApp({ url: '/app/suppliers', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: '深圳工厂' })
    expect(link).toHaveAttribute('href', '/app/suppliers/s1')
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('样本不足').length).toBeGreaterThanOrEqual(1)
    expect(within(row).queryByText('0%')).not.toBeInTheDocument()
  })

  it('新建供应商：名称必填；成功后按填写内容发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/suppliers',
      pages,
      handlers: handlers({
        '/suppliers': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: { id: 's2', version: 1 } } }
          }
          return ok({ items: [supplierRow()], total: 1, page: 1, pageSize: 20 })
        },
      }),
    })
    await screen.findByRole('link', { name: '深圳工厂' })
    await userEvent.click(screen.getByRole('button', { name: /新增供应商/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    expect(await within(dialog).findByText('请填写名称')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '编码' }), 'S-9')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名称' }), '东莞包装厂')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    await waitFor(() => expect(body).toMatchObject({ code: 'S-9', name: '东莞包装厂' }))
  })

  it('详情：商品与历史报价、采购单可看；评级写明样本不足的依据', async () => {
    mountApp({ url: '/app/suppliers/s1', pages, handlers: handlers() })
    expect((await screen.findAllByText('深圳工厂')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: '合作商品与报价' }))
    expect(await screen.findByText('SKU-A')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '采购历史' }))
    expect(await screen.findByRole('link', { name: 'PO-20261024-001' })).toBeInTheDocument()
  })

  it('详情：没有成本权限时报价位置不出现单价', async () => {
    const detail = supplierDetail()
    detail.products = detail.products.map(p => ({ ...p, quotes: [] }))
    detail.purchaseOrders = [orderRow()]
    mountApp({ url: '/app/suppliers/s1', pages, handlers: handlers({ '/suppliers/s1': () => ok(detail) }, ['supplier.read']) })
    await screen.findAllByText('深圳工厂')
    await userEvent.click(screen.getByRole('tab', { name: '合作商品与报价' }))
    expect(await screen.findByText('SKU-A')).toBeInTheDocument()
    expect(screen.queryByText(/CNY 3/)).not.toBeInTheDocument()
  })

  it('停用供应商需要填原因；已停用的显示恢复按钮', async () => {
    const detail = supplierDetail()
    detail.supplier.status = 'INACTIVE'
    mountApp({ url: '/app/suppliers/s1', pages, handlers: handlers({ '/suppliers/s1': () => ok(detail) }) })
    expect(await screen.findByRole('button', { name: /恢复合作/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /停用/ })).not.toBeInTheDocument()
  })
})

describe('国内仓', () => {
  it('库存：显示可用、锁定与来自头程运单的待出库数量', async () => {
    mountApp({ url: '/app/domestic-warehouse', pages, handlers: handlers() })
    const row = (await screen.findByText('SKU-A')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('CNY 18.00')).toBeInTheDocument()
    expect(within(row).getByText('4')).toBeInTheDocument()
    expect(within(row).queryByText('尚未接入')).not.toBeInTheDocument()
  })

  it('库存：没有成本权限时库存价值不显示，且说明原因', async () => {
    const hidden = stock()
    hidden.items = hidden.items.map(({ value: _v, valueCurrency: _c, ...rest }) => rest)
    mountApp({ url: '/app/domestic-warehouse', pages, handlers: handlers({ '/domestic-warehouse/stock': () => ok(hidden) }, ['warehouse.read']) })
    const row = (await screen.findByText('SKU-A')).closest('tr, [role=row]') as HTMLElement
    expect(screen.queryByText('货值')).not.toBeInTheDocument()
    expect(within(row).queryByText(/CNY/)).not.toBeInTheDocument()
  })

  it('没有任何库存：说明收货后才会出现，而不是空表', async () => {
    mountApp({ url: '/app/domestic-warehouse', pages, handlers: handlers({ '/domestic-warehouse/stock': () => ok(stock({ items: [], total: 0, totals: { onHand: 0, locked: 0, available: 0 } })) }) })
    expect(await screen.findByText(/国内仓才有库存/)).toBeInTheDocument()
  })

  it('流水：来源单号可点，类型用中文', async () => {
    mountApp({ url: '/app/domestic-warehouse', pages, handlers: handlers() })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '流水' }))
    expect(await screen.findByText('采购收货')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'PO-20261024-001' })).toHaveAttribute('href', '/app/purchase-orders/po1')
  })

  it('盘点：自己提交的盘点不能自己审批，按钮禁用；别人可审批时按钮可用', async () => {
    mountApp({ url: '/app/domestic-warehouse', pages, handlers: handlers() })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '盘点' }))
    expect(await screen.findByRole('button', { name: /^通\s*过$/ })).toBeDisabled()
  })

  it('盘点：可审批时通过会带着盘点单版本发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/domestic-warehouse',
      pages,
      handlers: handlers({
        '/stock-counts': () => ok({ items: [count({ canApprove: true })], total: 1, page: 1, pageSize: 20 }),
        '/stock-counts/c1/approve': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { id: 'c1', status: 'APPROVED', statusLabel: '已通过' } } }
        },
      }),
    })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '盘点' }))
    await userEvent.click(await screen.findByRole('button', { name: /^通\s*过$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^通\s*过$/ }))
    await waitFor(() => expect(body).toMatchObject({ decision: 'APPROVED' }))
  })
})
