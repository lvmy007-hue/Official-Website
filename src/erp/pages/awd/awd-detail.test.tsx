import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { orderDetail, ok, shipment, switchOff } from './awd-fixtures.test-helper'

// 入库订单详情（P2a-08）：状态、包装、货件、按状态给出的动作与守卫。

const pages: LivePages = {
  AwdPage: { load: () => import('./AwdPage') },
  AwdOrderDetailPage: { load: () => import('./AwdOrderDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/awd/orders/o1': () => ok(orderDetail()),
  ...over,
})

const lastDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}

describe('入库订单详情', () => {
  it('显示状态、包装与操作记录；没有货件时说明确认后才会生成', async () => {
    mountApp({ url: '/app/awd/orders/o1', pages, handlers: handlers() })
    expect(await screen.findByText('亚马逊草稿')).toBeInTheDocument()
    expect(screen.getByText(/SKU-A × 24/)).toBeInTheDocument()
    expect(screen.getByText('创建入库订单')).toBeInTheDocument()
    expect(screen.getByText(/确认订单后才会生成/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^编\s?辑$/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /提交亚马逊/ })).not.toBeInTheDocument()
  })

  it('确认订单：要勾选确认，提交时带上订单版本', async () => {
    let body: unknown
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({
        '/awd/orders/o1/confirm': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { order: orderDetail(), state: 'QUEUED', jobId: 'j1' } } }
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /确认订单/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /确认订单/ }))
    expect(await within(dialog).findByText('请先勾选确认')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: /确认订单/ }))
    await waitFor(() => expect(body).toEqual({ version: 3 }))
  })

  it('写入开关没打开：调用亚马逊的动作禁用并写明原因，取消本地草稿不受影响', async () => {
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({
        '/awd/orders/o1': () => ok(orderDetail({ status: 'LOCAL_DRAFT', statusLabel: '本地草稿', orderId: null, actions: ['EDIT', 'SUBMIT', 'CANCEL'], write: switchOff })),
      }),
    })
    expect(await screen.findByText('调用亚马逊的操作暂时不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /提交亚马逊/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /取消订单/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^编\s?辑$/ })).toBeEnabled()
  })

  it('取消订单：必须填原因，提交带版本与原因', async () => {
    let body: unknown
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({
        '/awd/orders/o1/cancel': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return { status: 201, body: { success: true, data: { order: orderDetail(), state: 'QUEUED', jobId: 'j1' } } }
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /取消订单/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /取消订单/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    await userEvent.type(within(dialog).getByRole('textbox'), '计划变更')
    await userEvent.click(within(dialog).getByRole('button', { name: /取消订单/ }))
    await waitFor(() => expect(body).toEqual({ version: 3, reason: '计划变更' }))
  })

  it('后台操作在途：显示处理中提示，不给任何动作；失败原因写在顶部', async () => {
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({ '/awd/orders/o1': () => ok(orderDetail({ pendingAction: 'CONFIRM', actions: [], lastErrorMessage: '亚马逊返回：库容不足' })) }),
    })
    expect(await screen.findByText('有操作正在由后台任务处理')).toBeInTheDocument()
    expect(screen.getByText('亚马逊返回：库容不足')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /确认订单|取消订单/ })).not.toBeInTheDocument()
  })

  it('已确认且有货件：可更新运输信息；货件标签已生成时可下载', async () => {
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({
        '/awd/orders/o1': () => ok(orderDetail({ status: 'CONFIRMED', statusLabel: '已确认', actions: ['CANCEL', 'TRANSPORT'], shipments: [shipment({ labelStatus: 'GENERATED' })] })),
      }),
    })
    expect(await screen.findByText('SHIP-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /更新运输信息/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /下载标签/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^编\s?辑$/ })).not.toBeInTheDocument()
  })

  it('补货建议生成的草稿：提示补全包装与地址后才能提交', async () => {
    mountApp({
      url: '/app/awd/orders/o1',
      pages,
      handlers: handlers({
        '/awd/orders/o1': () =>
          ok(
            orderDetail({
              status: 'LOCAL_DRAFT',
              statusLabel: '本地草稿',
              orderId: null,
              packages: [],
              originAddress: null,
              actions: ['EDIT', 'SUBMIT', 'CANCEL'],
              draft: { source: 'REPLENISHMENT', batchId: 'b1', items: [{ sku: 'SKU-A', qty: 240 }] },
            }),
          ),
      }),
    })
    expect(await screen.findByText('由补货建议生成的草稿')).toBeInTheDocument()
    expect(screen.getByText(/SKU-A × 240/)).toBeInTheDocument()
    expect(screen.getByText('还没有填写包装')).toBeInTheDocument()
    expect(screen.getByText('尚未填写')).toBeInTheDocument()
  })

  it('没有 awd.read 权限：显示无权限', async () => {
    mountApp({ url: '/app/awd/orders/o1', pages, handlers: handlers({ '/awd/orders/o1': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }) })
    expect((await screen.findAllByText(/awd\.read|FORBIDDEN|无权/)).length).toBeGreaterThan(0)
  })
})
