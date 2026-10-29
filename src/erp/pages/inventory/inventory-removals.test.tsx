import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, recommended, removalDetail, removalRow, removals } from './inventory-stock-fixtures.test-helper'

// 移除与弃置（P2a-09）：订单列表与收货核对状态、推荐移除清单、订单详情、登记退回件收货。

const pages: LivePages = {
  RemovalsPage: { load: () => import('./RemovalsPage') },
  RemovalDetailPage: { load: () => import('./RemovalDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const DETAIL_PATH = '/inventory/removals/st1%3ARO-1'
const DETAIL_URL = '/app/inventory/removals/st1%3ARO-1'

// AG Grid 把固定列与滚动列放在不同容器里，同一行用 row-id 对应；这里取一行所有单元格的文字。
const rowText = (node: HTMLElement) => {
  const id = (node.closest('[row-id]') as HTMLElement).getAttribute('row-id') as string
  return Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(item => item.textContent ?? '')
    .join('|')
}

const handlers = (over: Record<string, Handler> = {}, permissions = ['inventory.read', 'inventory.removal.receive']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/inventory/removals': () => ok(removals()),
  '/inventory/removals/recommended': () => ok(recommended()),
  [DETAIL_PATH]: () => ok(removalDetail()),
  ...over,
})

describe('移除与弃置列表页', () => {
  it('订单号链到详情；费用没有记录写“尚无记录”；收货核对状态；顶部给卖家后台创建指引', async () => {
    const disposal = removalRow({
      id: 'st1:RO-2',
      orderId: 'RO-2',
      type: 'DISPOSAL',
      typeLabel: '弃置',
      fee: null,
      currency: null,
      carriers: [],
      trackingNumbers: [],
      receiptState: 'NOT_APPLICABLE',
      shippedQty: 0,
    })
    mountApp({ url: '/app/inventory/removals', pages, handlers: handlers({ '/inventory/removals': () => ok(removals({ items: [removalRow(), disposal], total: 2 })) }) })
    const link = await screen.findByRole('link', { name: 'RO-1' })
    expect(link).toHaveAttribute('href', '/app/inventory/removals/st1%3ARO-1')
    expect(screen.getByText('移除订单只能在亚马逊卖家后台创建')).toBeInTheDocument()
    const first = rowText(link)
    expect(first).toContain('待收货登记')
    expect(first).toContain('$2.00')
    const second = rowText(screen.getByRole('link', { name: 'RO-2' }))
    expect(second).toContain('无需核对')
    expect(second.split('尚无记录').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('没有任何移除订单：显示“尚无记录”与原因', async () => {
    mountApp({ url: '/app/inventory/removals', pages, handlers: handlers({ '/inventory/removals': () => ok(removals({ state: 'NO_DATA', note: '范围内没有移除订单记录', items: [], total: 0 })) }) })
    expect(await screen.findByText('范围内没有移除订单记录')).toBeInTheDocument()
  })

  it('地址栏带搜索词与类型时，请求带参数并从第一页开始', async () => {
    const app = mountApp({ url: '/app/inventory/removals?q=SKU-B&type=RETURN', pages, handlers: handlers() })
    await screen.findByRole('link', { name: 'RO-1' })
    await waitFor(() =>
      expect(app.calls.some(call => call.path === '/inventory/removals' && call.search.includes('q=SKU-B') && call.search.includes('type=RETURN') && call.search.includes('page=1'))).toBe(true),
    )
  })

  it('推荐移除清单：预计节省没有接入写“尚未接入”，原因与数量照实显示', async () => {
    mountApp({ url: '/app/inventory/removals', pages, handlers: handlers() })
    await screen.findByRole('link', { name: 'RO-1' })
    await userEvent.click(screen.getByRole('tab', { name: '推荐移除清单' }))
    const row = rowText(await screen.findByText('SKU-A'))
    expect(row).toContain('库龄过长')
    expect(row).toContain('20')
    expect(row).toContain('尚未接入')
  })
})

describe('移除订单详情页', () => {
  it('退回地址写“尚未接入”；逐 SKU 核对写“待收货登记”；没有费用的行写“尚无记录”；没有收货登记也写明', async () => {
    mountApp({ url: DETAIL_URL, pages, handlers: handlers() })
    expect(await screen.findByText('移除订单 RO-1')).toBeInTheDocument()
    expect(screen.getByText('尚未接入')).toBeInTheDocument()
    expect(screen.getByText(/不含退回地址/)).toBeInTheDocument()
    expect(screen.getAllByText('待收货登记').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('尚无收货登记')).toBeInTheDocument()
    const skuB = screen
      .getAllByText('SKU-B')
      .map(node => node.closest('tr, [role=row]'))
      .find(row => row && within(row as HTMLElement).queryByText('已取消') === null && row.textContent?.includes('Sellable'))
    expect(within(skuB as HTMLElement).getAllByText('尚无记录').length).toBeGreaterThan(0)
    expect(screen.getByText('发货 10 件')).toBeInTheDocument()
  })

  it('弃置订单：登记按钮禁用并写明原因', async () => {
    const disposal = removalDetail({ canReceive: { allowed: false, reason: '弃置订单没有退回件，无需登记收货' } })
    mountApp({ url: DETAIL_URL, pages, handlers: handlers({ [DETAIL_PATH]: () => ok(disposal) }) })
    await screen.findByText('移除订单 RO-1')
    expect(screen.getByRole('button', { name: /登记收货/ })).toBeDisabled()
  })

  it('没有 inventory.removal.receive 权限：登记按钮禁用', async () => {
    mountApp({ url: DETAIL_URL, pages, handlers: handlers({}, ['inventory.read']) })
    await screen.findByText('移除订单 RO-1')
    expect(screen.getByRole('button', { name: /登记收货/ })).toBeDisabled()
  })

  it('登记收货：只提交填写的字段，良品与损坏之和超过实收由服务端拒绝并回填到表单', async () => {
    let body: Record<string, unknown> | undefined
    let reject = true
    mountApp({
      url: DETAIL_URL,
      pages,
      handlers: handlers({
        [`${DETAIL_PATH}/receipt`]: (_url, init) => {
          body = JSON.parse(String(init?.body))
          if (reject) return { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '参数不正确', fieldErrors: { receivedQty: ['良品与损坏之和不能超过实收数量'] } } } }
          return { status: 201, body: { success: true, data: { receipt: {}, reconciliation: {} } } }
        },
      }),
    })
    await screen.findByText('移除订单 RO-1')
    await userEvent.click(screen.getByRole('button', { name: /登记收货/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '收货 SKU' }))
    await userEvent.click(await screen.findByTitle('SKU-A（应收 10）'))
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: '实收数量' }), '9')
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: '良品数量' }), '8')
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: '损坏数量' }))
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: '损坏数量' }), '5')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存登记/ }))
    expect(await within(dialog).findByText('良品与损坏之和不能超过实收数量')).toBeInTheDocument()
    expect(body).toEqual({ sku: 'SKU-A', receivedQty: 9, sellableQty: 8, damagedQty: 5 })

    reject = false
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: '损坏数量' }))
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: '损坏数量' }), '1')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '收货备注' }), '  一箱破损 ')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存登记/ }))
    await waitFor(() => expect(body).toEqual({ sku: 'SKU-A', receivedQty: 9, sellableQty: 8, damagedQty: 1, note: '一箱破损' }))
    expect(await screen.findByText('已登记收货')).toBeInTheDocument()
  })

  it('订单不存在：显示错误状态而不是空白', async () => {
    mountApp({ url: DETAIL_URL, pages, handlers: handlers({ [DETAIL_PATH]: () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '移除订单不存在' } } }) }) })
    expect((await screen.findAllByText(/不存在|NOT_FOUND/)).length).toBeGreaterThan(0)
  })
})
