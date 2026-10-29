import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { allowed, future, ok, planList, planRow, switchOff } from './inbound-fixtures.test-helper'

// 入仓计划列表页（P2a-12）：状态看板、异常队列、倒计时、新建草稿。

const pages: LivePages = {
  InboundPlansPage: { load: () => import('./InboundPlansPage') },
  InboundPlanDetailPage: { load: () => import('./InboundPlanDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/inbound/plans': () => ok(planList()),
  ...over,
})

describe('入仓计划列表', () => {
  it('看板列出十三个阶段与各自数量；计划名可点进详情', async () => {
    mountApp({
      url: '/app/supply-chain',
      pages,
      handlers: handlers({ '/inbound/plans': () => ok(planList([planRow(), planRow({ id: 'p2', name: '11 月补货', stage: 'CREATED', stageLabel: '入仓计划已创建' })])) }),
    })
    const link = await screen.findByRole('link', { name: '10 月补货' })
    expect(link).toHaveAttribute('href', '/app/supply-chain/p1')
    const board = screen.getByTestId('inbound-board')
    expect(within(board).getAllByRole('button')).toHaveLength(14)
    expect(within(board).getByRole('button', { name: /草稿 1/ })).toBeInTheDocument()
    expect(within(board).getByRole('button', { name: /入仓计划已创建 1/ })).toBeInTheDocument()
  })

  it('处理中的计划显示“处理中：某某操作”；有截止时间的显示倒计时', async () => {
    const row = planRow({ id: 'p2', name: '处理中计划', stage: 'CREATED', pendingOp: 'GENERATE_PACKING', stageLabel: '入仓计划已创建', nextDeadline: { kind: 'PACKING_EXPIRES', at: future() } })
    mountApp({ url: '/app/supply-chain', pages, handlers: handlers({ '/inbound/plans': () => ok(planList([row])) }) })
    expect(await screen.findByText('处理中：生成装箱方案')).toBeInTheDocument()
    expect(screen.getByText(/装箱方案有效期/)).toBeInTheDocument()
    expect(screen.getByTestId('countdown')).toHaveTextContent('剩余')
  })

  it('异常队列：列出操作失败与即将过期的计划', async () => {
    const exceptions = [
      { kind: 'OP_FAILED' as const, planId: 'p1', planName: '10 月补货', message: '创建入仓计划失败', at: null },
      { kind: 'EXPIRING' as const, planId: 'p1', planName: '10 月补货', message: '分仓方案即将过期', at: future() },
    ]
    mountApp({ url: '/app/supply-chain', pages, handlers: handlers({ '/inbound/plans': () => ok(planList([planRow()], allowed, { exceptions })) }) })
    const box = await screen.findByTestId('inbound-exceptions')
    expect(box).toHaveTextContent('异常队列（2）')
    expect(box).toHaveTextContent('创建入仓计划失败')
    expect(box).toHaveTextContent('分仓方案即将过期')
  })

  it('没有 inbound.read 权限：显示无权限而不是空表', async () => {
    mountApp({ url: '/app/supply-chain', pages, handlers: handlers({ '/inbound/plans': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }) })
    expect((await screen.findAllByText(/inbound\.read|FORBIDDEN|无权/)).length).toBeGreaterThan(0)
  })

  it('没有 inbound.plan.write 权限时新建按钮禁用', async () => {
    mountApp({ url: '/app/supply-chain', pages, handlers: handlers({}, ['inbound.read']) })
    await screen.findByRole('link', { name: '10 月补货' })
    expect(screen.getByRole('button', { name: /新建入仓计划/ })).toBeDisabled()
  })

  it('新建草稿不受写入开关限制；表单里没有预处理或贴标由谁负责的选项', async () => {
    mountApp({ url: '/app/supply-chain', pages, handlers: handlers({ '/inbound/plans': () => ok(planList([], switchOff)) }) })
    await userEvent.click(await screen.findByRole('button', { name: /新建入仓计划/ }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('button', { name: /保存草稿/ })).toBeEnabled()
    expect(within(drawer).getAllByText(/卖家负责/).length).toBeGreaterThan(0)
    expect(within(drawer).queryByText(/由亚马逊(预处理|贴标)/)).not.toBeInTheDocument()
  })

  it('新建草稿：必填项校验后提交，只带店铺、名称、地址与商品，不调用亚马逊', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/supply-chain',
      pages,
      handlers: handlers({
        '/inbound/plans': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: { plan: planRow({ id: 'p-new' }), state: 'SAVED', jobId: null, operationId: null } } }
          }
          return ok(planList([], allowed))
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /新建入仓计划/ }))
    const drawer = await screen.findByRole('dialog')
    await userEvent.click(within(drawer).getByRole('button', { name: /保存草稿/ }))
    expect(await within(drawer).findByText('请选择店铺')).toBeInTheDocument()
    expect(within(drawer).getByText('请填写计划名称')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.click(within(drawer).getByRole('combobox', { name: '店铺' }))
    await userEvent.click(await screen.findByTitle('Northstar US'))
    await userEvent.type(within(drawer).getByRole('textbox', { name: '计划名称' }), '10 月补货')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '联系人或公司名' }), '深圳仓')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '地址' }), '1 Road')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '城市' }), 'Shenzhen')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '州或省代码' }), 'GD')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '邮编' }), '518000')
    await userEvent.type(within(drawer).getByRole('textbox', { name: '电话' }), '123456')
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'SKU 1' }), 'SKU-A')
    await userEvent.type(within(drawer).getByRole('spinbutton', { name: '数量 1' }), '10')
    await userEvent.click(within(drawer).getByRole('button', { name: /保存草稿/ }))
    await waitFor(() => expect(body).toBeDefined())
    expect(body).toEqual({
      sellerAccountId: 'st1',
      name: '10 月补货',
      sourceAddress: { name: '深圳仓', addressLine1: '1 Road', city: 'Shenzhen', stateOrProvinceCode: 'GD', postalCode: '518000', countryCode: 'CN', phoneNumber: '123456' },
      items: [{ sku: 'SKU-A', quantity: 10 }],
    })
  })
})
