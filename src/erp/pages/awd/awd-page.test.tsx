import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { allowed, inventory, ok, orderList, orderRow, shipment, switchOff } from './awd-fixtures.test-helper'

// 亚马逊仓储分销页（P2a-08）：库存、入库订单、入库货件三个页签。

const pages: LivePages = {
  AwdPage: { load: () => import('./AwdPage') },
  AwdOrderDetailPage: { load: () => import('./AwdOrderDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

// AG Grid 把固定列与滚动列放在不同容器里，同一行用 row-id 对应；这里把一行所有单元格收进一个容器，便于 within 查询。
const rowOf = (node: HTMLElement) => {
  const id = (node.closest('[row-id]') as HTMLElement).getAttribute('row-id') as string
  const holder = document.createElement('div')
  document.querySelectorAll(`[row-id="${id}"]`).forEach(item => holder.append(item.cloneNode(true)))
  return holder
}
const rowText = (node: HTMLElement) => rowOf(node).textContent ?? ''
const rowButton = (node: HTMLElement, name: RegExp) => {
  const id = (node.closest('[row-id]') as HTMLElement).getAttribute('row-id') as string
  const buttons = Array.from(document.querySelectorAll(`[row-id="${id}"] button`)) as HTMLButtonElement[]
  return buttons.find(button => name.test(button.textContent?.replace(/\s+/g, ' ') ?? '')) as HTMLButtonElement
}

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/awd/inventory': () => ok(inventory()),
  '/awd/orders': () => ok(orderList()),
  '/awd/shipments': () => ok({ state: 'OK', note: null, items: [shipment()], total: 1, page: 1, pageSize: 20, freshness: null }),
  ...over,
})

describe('亚马逊仓储分销页', () => {
  it('库存：显示合计与快照日期；没有数字的列写“尚无记录”，不写 0', async () => {
    mountApp({ url: '/app/awd', pages, handlers: handlers() })
    expect(await screen.findByText('SKU-A')).toBeInTheDocument()
    const totals = screen.getByTestId('awd-totals')
    expect(totals).toHaveTextContent('可用合计 100')
    expect(totals).toHaveTextContent('发往亚马逊物流在途 尚无记录')
    expect(rowText(screen.getByText('SKU-A')).split('尚无记录').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('店铺没有开通上游仓储：只显示说明，不显示合计', async () => {
    mountApp({
      url: '/app/awd',
      pages,
      handlers: handlers({ '/awd/inventory': () => ok(inventory({ state: 'NOT_APPLICABLE', note: '这个店铺没有开通亚马逊仓储分销', items: [], total: 0, snapshotDate: null })) }),
    })
    expect(await screen.findByText('未开通亚马逊仓储分销')).toBeInTheDocument()
    expect(screen.getByText('这个店铺没有开通亚马逊仓储分销')).toBeInTheDocument()
    expect(screen.queryByTestId('awd-totals')).not.toBeInTheDocument()
  })

  it('没有 awd.read 权限：显示无权限而不是空表', async () => {
    mountApp({ url: '/app/awd', pages, handlers: handlers({ '/awd/inventory': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }) })
    expect((await screen.findAllByText(/awd\.read|FORBIDDEN|无权/)).length).toBeGreaterThan(0)
  })

  it('入库订单：订单号可点进详情；处理中的订单显示提示', async () => {
    mountApp({
      url: '/app/awd',
      pages,
      handlers: handlers({
        '/awd/orders': () =>
          ok(orderList([orderRow(), orderRow({ id: 'o2', orderId: null, externalReferenceId: 'NOVA-BBBB', status: 'LOCAL_DRAFT', statusLabel: '本地草稿', pendingAction: 'CREATE' })])),
      }),
    })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '入库订单' }))
    const link = await screen.findByRole('link', { name: 'AWD-1001' })
    expect(link).toHaveAttribute('href', '/app/awd/orders/o1')
    expect(screen.getByText('提交中')).toBeInTheDocument()
  })

  it('入库订单：写入开关没打开时，新建草稿仍可用，提交亚马逊按钮禁用并写明原因', async () => {
    mountApp({ url: '/app/awd', pages, handlers: handlers({ '/awd/orders': () => ok(orderList([], switchOff)) }) })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '入库订单' }))
    const create = await screen.findByRole('button', { name: /新建入库订单/ })
    expect(create).toBeEnabled()
    await userEvent.click(create)
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('button', { name: /保存草稿/ })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: /保存并提交亚马逊/ })).toBeDisabled()
  })

  it('入库订单：没有 awd.order.write 权限时新建按钮禁用', async () => {
    mountApp({ url: '/app/awd', pages, handlers: handlers({}, ['awd.read']) })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '入库订单' }))
    expect(await screen.findByRole('button', { name: /新建入库订单/ })).toBeDisabled()
  })

  it('新建本地草稿：只带店铺与包装，submit 为 false，不调用亚马逊', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/awd',
      pages,
      handlers: handlers({
        '/awd/orders': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: { order: orderRow(), state: 'SAVED', jobId: null } } }
          }
          return ok(orderList([], allowed))
        },
      }),
    })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '入库订单' }))
    await userEvent.click(await screen.findByRole('button', { name: /新建入库订单/ }))
    const drawer = await screen.findByRole('dialog')
    await userEvent.click(within(drawer).getByRole('button', { name: /保存草稿/ }))
    expect(await within(drawer).findByText('请选择店铺')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.click(within(drawer).getByRole('combobox', { name: '店铺' }))
    await userEvent.click(await screen.findByTitle('Northstar US'))
    await userEvent.click(within(drawer).getByRole('button', { name: /保存草稿/ }))
    await waitFor(() => expect(body).toEqual({ sellerAccountId: 'st1', packages: [], submit: false }))
  })

  it('入库货件：运单号没有时写“尚无记录”；已取消的货件不能获取标签', async () => {
    mountApp({
      url: '/app/awd',
      pages,
      handlers: handlers({
        '/awd/shipments': () =>
          ok({
            state: 'OK',
            note: null,
            items: [shipment(), shipment({ id: 'sh2', shipmentId: 'SHIP-2', status: 'CANCELLED', statusLabel: '已取消' })],
            total: 2,
            page: 1,
            pageSize: 20,
            freshness: null,
          }),
      }),
    })
    await screen.findByText('SKU-A')
    await userEvent.click(screen.getByRole('tab', { name: '入库货件' }))
    const first = await screen.findByText('SHIP-1')
    expect(rowText(first)).toContain('尚无记录')
    expect(rowButton(first, /获取标签/)).toBeEnabled()
    expect(rowButton(screen.getByText('SHIP-2'), /获取标签/)).toBeDisabled()
  })
})
