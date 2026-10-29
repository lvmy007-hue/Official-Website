import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, roleView, rolesResponse } from '../members/members-fixtures.test-helper'

// 角色与权限（P5-08）：预设只读、复制后再改；权限矩阵整组勾选与影响范围；职责分离当场提示；创建与修改先再次验证身份并带版本号。

const pages: LivePages = { RolesPage: { load: () => import('./RolesPage') } }
const T = { timeout: 30000 }
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/roles': () => ok(rolesResponse()),
  ...over,
})
const stepUp = (order: string[]): Record<string, Handler> => ({ '/auth/step-up': (_url, init) => (order.push(`step-up:${String(bodyOf(init).action)}`), ok({ expiresAt: '2026-10-25T12:00:00Z' })) })
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr, [role=row]') as HTMLElement

describe('角色列表', () => {
  it('预设与自定义分别标注；所有者写“全部”；成员数与待接受邀请数', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers() })
    const owner = await rowOf('所有者')
    expect(within(owner).getByText('预设')).toBeInTheDocument()
    expect(within(owner).getByText('全部')).toBeInTheDocument()
    const custom = await rowOf('采购专员')
    expect(within(custom).getByText('自定义')).toBeInTheDocument()
    expect(within(custom).getByText('2 个')).toBeInTheDocument()
    expect(within(custom).getByText(/成本：仅负责人可见；利润：不可见；买家信息：不可见/)).toBeInTheDocument()
    expect(screen.getByText(/共 3 个角色，自定义 1 \/ 50/)).toBeInTheDocument()
  })

  it('预设角色：编辑置灰；自定义角色可编辑', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers() })
    const preset = await rowOf('运营')
    expect(within(preset).getByRole('button', { name: /^编\s*辑$/ })).toBeDisabled()
    const custom = await rowOf('采购专员')
    expect(within(custom).getByRole('button', { name: /^编\s*辑$/ })).toBeEnabled()
  })

  it('没有管理权限：新建按钮置灰，说明只能查看', T, async () => {
    const data = rolesResponse({ canManage: false, manageBlockedReason: '没有“创建、编辑角色”权限（企业所有者与管理员有）' })
    mountApp({ url: '/app/roles', pages, handlers: handlers({ '/roles': () => ok(data) }, ['role.manage']) })
    await rowOf('采购专员')
    expect(screen.getByRole('button', { name: /新建角色/ })).toBeDisabled()
    expect(screen.getByText(/当前账号只能查看角色：没有“创建、编辑角色”权限/)).toBeInTheDocument()
  })

  it('自定义角色已达上限：新建置灰', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers({ '/roles': () => ok(rolesResponse({ customCount: 50 })) }) })
    await rowOf('采购专员')
    expect(screen.getByRole('button', { name: /新建角色/ })).toBeDisabled()
  })

  it('展开一行：按模块与页面写出拥有的权限', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers() })
    const custom = await rowOf('采购专员')
    await userEvent.click(custom)
    expect(await screen.findByText('采购订单')).toBeInTheDocument()
  })
})

describe('角色编辑', () => {
  it('新建：至少选一个权限点；勾选页面整组选中；先验证身份，请求体带权限与字段权限', T, async () => {
    const order: string[] = []
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/roles',
      pages,
      handlers: handlers({
        ...stepUp(order),
        '/roles': (_url, init) => {
          if (init?.method === 'POST') {
            order.push('create')
            body = bodyOf(init)
            return { status: 201, body: { success: true, data: { role: roleView({ id: 'r-new', system: false }), changed: true } } }
          }
          return ok(rolesResponse())
        },
      }),
    })
    await rowOf('采购专员')
    await userEvent.click(screen.getByRole('button', { name: /新建角色/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '角色名称' }), '客服')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    expect(await within(dialog).findByText('至少选择一个权限点；没有任何权限的角色没有意义')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '页面 经营控制台与今日实时' }))
    expect(within(dialog).getByText(/已选 1 个权限点/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    await waitFor(() => expect(order).toEqual(['step-up:role.manage', 'create']))
    expect(body).toEqual({ name: '客服', permissions: ['overview.read'], fields: { cost: 'HIDDEN', profit: 'HIDDEN', buyer: 'HIDDEN' } })
  })

  it('复制所有者：通配权限展开成全部权限点，职责分离冲突当场提示', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers() })
    const owner = await rowOf('所有者')
    await userEvent.click(within(owner).getByRole('button', { name: /复制为自定义角色/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: '角色名称' })).toHaveValue('所有者 副本')
    expect(within(dialog).getByText(/职责分离：.*不能放在同一个角色里/)).toBeInTheDocument()
    expect(within(dialog).getByText(/已选 \d+ 个权限点/)).toBeInTheDocument()
  })

  it('编辑：带着看到的版本号与原因，先验证身份；清空说明传 null', T, async () => {
    const order: string[] = []
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/roles',
      pages,
      handlers: handlers({
        ...stepUp(order),
        '/roles/r-custom': (_url, init) => {
          order.push('patch')
          body = bodyOf(init)
          return ok({ role: roleView({ id: 'r-custom', system: false }), changed: true })
        },
      }),
    })
    const custom = await rowOf('采购专员')
    await userEvent.click(within(custom).getByRole('button', { name: /^编\s*辑$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/已选 2 个权限点/)).toBeInTheDocument()
    const name = within(dialog).getByRole('textbox', { name: '角色名称' })
    await userEvent.clear(name)
    await userEvent.type(name, '采购主管')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '改名')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(order).toEqual(['step-up:role.manage', 'patch']))
    expect(body).toMatchObject({ version: 4, name: '采购主管', description: null, reason: '改名', fields: { cost: 'OWNER_ONLY', profit: 'HIDDEN', buyer: 'HIDDEN' } })
    expect([...(body?.permissions as string[])].sort()).toEqual(['purchase.order.write', 'purchase.read'])
  })

  it('同时勾选创建与审批：当场提示职责分离冲突', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers() })
    const custom = await rowOf('采购专员')
    await userEvent.click(within(custom).getByRole('button', { name: /^编\s*辑$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/职责分离/)).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /^审批采购单/ }))
    expect(await within(dialog).findByText(/职责分离：“.*”与“.*”不能放在同一个角色里/)).toBeInTheDocument()
  })

  it('自己没有的权限点：灰掉，自己有的可以勾选', T, async () => {
    mountApp({ url: '/app/roles', pages, handlers: handlers({}, ['role.manage', 'overview.read']) })
    await rowOf('采购专员')
    await userEvent.click(screen.getByRole('button', { name: /新建角色/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('checkbox', { name: /^审批采购单/ })).toBeDisabled()
    expect(within(dialog).getByRole('checkbox', { name: /^经营控制台、今日实时/ })).toBeEnabled()
  })
})
