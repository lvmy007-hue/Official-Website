import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { inviteResult, memberDetail, memberList, ok } from './members-fixtures.test-helper'

// 成员列表与详情（P5-08）：从未登录、范围与待接受邀请的写法；邀请链接只展示一次；停用、改角色、改范围都先再次验证身份；无权限时写明缺哪个权限点。

const pages: LivePages = {
  MembersPage: { load: () => import('./MembersPage') },
  MemberDetailPage: { load: () => import('./MemberDetailPage') },
}
const T = { timeout: 30000 }
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/members': () => ok(memberList()),
  '/members/m2': () => ok(memberDetail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})
const stepUp = (order: string[]): Record<string, Handler> => ({ '/auth/step-up': (_url, init) => (order.push(`step-up:${String(bodyOf(init).action)}`), ok({ expiresAt: '2026-10-25T12:00:00Z' })) })

describe('成员列表', () => {
  it('显示汇总；从未登录写“尚未登录”；自己带“（我）”；待接受的邀请单独列出', T, async () => {
    mountApp({ url: '/app/members', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: '小王' })
    expect(link).toHaveAttribute('href', '/app/members/m2')
    expect(screen.getByText(/共 3 人：使用中 2，已停用 1；待接受的邀请 1/)).toBeInTheDocument()
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('尚未登录')).toBeInTheDocument()
    expect(within(row).getByText('指定主体：深圳跨境科技')).toBeInTheDocument()
    expect(screen.getByText('（我）')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    // 待接受邀请是页内第二张表，行数据晚于成员表一拍才画进文档
    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '管理角色与权限' })).toHaveAttribute('href', '/app/roles')
  })

  it('没有角色管理权限：不显示进入角色页的入口', T, async () => {
    mountApp({ url: '/app/members', pages, handlers: handlers({}, ['member.read']) })
    await screen.findByRole('link', { name: '小王' })
    expect(screen.queryByRole('link', { name: '管理角色与权限' })).not.toBeInTheDocument()
  })

  it('不能邀请：按钮置灰，说明原因与只能查看', T, async () => {
    const data = memberList({
      canInvite: false,
      inviteBlockedReason: '没有“邀请成员”权限（企业所有者与管理员有）',
      canManage: false,
      manageBlockedReason: '管理成员会影响企业全部数据，需要“全部店铺”数据范围',
    })
    mountApp({ url: '/app/members', pages, handlers: handlers({ '/members': () => ok(data) }) })
    await screen.findByRole('link', { name: '小王' })
    expect(screen.getByRole('button', { name: /邀请成员/ })).toBeDisabled()
    expect(screen.getByText(/当前账号只能查看成员：管理成员会影响企业全部数据/)).toBeInTheDocument()
  })

  it('没有符合条件的成员：说明怎么调整', T, async () => {
    mountApp({ url: '/app/members', pages, handlers: handlers({ '/members': () => ok(memberList({ items: [], total: 0, invitations: [] })) }) })
    expect(await screen.findByText(/企业里还没有成员/)).toBeInTheDocument()
  })

  it('邀请：邮箱与角色必填；发出全部范围；邮件通道未配置时链接只在结果里出现一次，并带出提示', T, async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/members',
      pages,
      handlers: handlers({
        '/members/invite': (_url, init) => {
          body = bodyOf(init)
          return { status: 201, body: { success: true, data: inviteResult() } }
        },
      }),
    })
    await screen.findByRole('link', { name: '小王' })
    await userEvent.click(screen.getByRole('button', { name: /邀请成员/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^发\s*送\s*邀\s*请$/ }))
    expect(await within(dialog).findByText('请填写邮箱')).toBeInTheDocument()
    expect(within(dialog).getByText('请选择角色')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '邮箱' }), 'new@example.com')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '角色' }))
    await userEvent.click(await screen.findByTitle('运营'))
    await userEvent.click(within(dialog).getByRole('button', { name: /^发\s*送\s*邀\s*请$/ }))
    await waitFor(() => expect(body).toEqual({ email: 'new@example.com', roleId: 'r-ops', scope: { all: true, legalEntityIds: [], sellerAccountIds: [] } }))
    const result = await screen.findByText('邀请已创建')
    const modal = result.closest('.ant-modal') as HTMLElement
    expect(within(modal).getByText(/邮件通道尚未配置，邀请邮件没有发出/)).toBeInTheDocument()
    expect(within(modal).getByText('https://erp.example.com/invite/abc123')).toBeInTheDocument()
    expect(within(modal).getByText(/之前未接受的 1 封邀请已作废/)).toBeInTheDocument()
    expect(within(modal).getByText('成员数将超过报价约定的 5 人')).toBeInTheDocument()
  })

  it('邀请：选“指定主体与店铺”却一个都没选，当场提示', T, async () => {
    let called = 0
    mountApp({ url: '/app/members', pages, handlers: handlers({ '/members/invite': () => (called++, { status: 201, body: { success: true, data: inviteResult() } }) }) })
    await screen.findByRole('link', { name: '小王' })
    await userEvent.click(screen.getByRole('button', { name: /邀请成员/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '邮箱' }), 'new@example.com')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '角色' }))
    await userEvent.click(await screen.findByTitle('运营'))
    await userEvent.click(within(dialog).getByRole('radio', { name: '指定主体与店铺' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^发\s*送\s*邀\s*请$/ }))
    expect(await within(dialog).findByText(/至少选一个主体或店铺/)).toBeInTheDocument()
    expect(called).toBe(0)
  })

  it('加载失败：显示错误与重试', T, async () => {
    mountApp({ url: '/app/members', pages, handlers: handlers({ '/members': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务异常' } } }) }) })
    expect(await screen.findByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })

  it('没有权限：写明缺哪个权限点，并指向角色编辑器（以服务端报告的权限点为准）', T, async () => {
    mountApp({
      url: '/app/members',
      pages,
      handlers: handlers({ '/members': () => ({ status: 403, body: { success: false, error: { code: 'PERMISSION_DENIED', message: '没有权限', details: { permission: 'member.read' } } } }) }),
    })
    expect(await screen.findByText(/member\.read/)).toBeInTheDocument()
    expect(screen.getByText(/角色编辑器里为你的角色开通该权限点/)).toBeInTheDocument()
  })
})

describe('成员详情', () => {
  it('指标与四个页签：角色权限摘要、范围明细、登录记录、操作审计', T, async () => {
    mountApp({ url: '/app/members/m2', pages, handlers: handlers() })
    expect((await screen.findAllByText('小王')).length).toBeGreaterThan(0)
    expect(screen.getByText('尚未登录')).toBeInTheDocument()
    expect(screen.getByText('日常运营')).toBeInTheDocument()
    expect(screen.getByText(/成本：不可见；利润：不可见；买家信息：不可见/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '数据范围' }))
    expect(await screen.findByText('深圳跨境科技', { selector: 'td, .ag-cell *' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '登录与会话' }))
    expect(await screen.findByText('203.0.113.*')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '操作审计' }))
    expect(await screen.findByText('转岗到运营')).toBeInTheDocument()
  })

  it('没有审计查看权限：写“无权查看”和缺的权限点，不显示空列表', T, async () => {
    mountApp({ url: '/app/members/m2', pages, handlers: handlers({ '/members/m2': () => ok(memberDetail({ audit: { state: 'RESTRICTED', items: [], truncated: false } })) }) })
    await screen.findAllByText('小王')
    await userEvent.click(screen.getByRole('tab', { name: '操作审计' }))
    expect(await screen.findByText(/无权查看：缺少权限点 audit\.read/)).toBeInTheDocument()
  })

  it('自己的账号：四个动作按钮都置灰，悬停原因由服务端给出', T, async () => {
    const self = memberDetail({
      member: { ...memberDetail().member, isSelf: true },
      canManage: false,
      actions: { disable: '不能修改自己的账号', enable: '不能修改自己的账号', role: '不能修改自己的账号', scopes: '不能修改自己的账号' },
    })
    mountApp({ url: '/app/members/m2', pages, handlers: handlers({ '/members/m2': () => ok(self) }) })
    await screen.findAllByText('小王')
    for (const name of [/修改角色/, /修改数据范围/, /^停\s*用$/]) expect(screen.getByRole('button', { name })).toBeDisabled()
  })

  it('停用：原因必填；先再次验证身份再提交，请求体只有原因', T, async () => {
    const order: string[] = []
    mountApp({
      url: '/app/members/m2',
      pages,
      handlers: handlers({
        ...stepUp(order),
        '/members/m2/disable': (_url, init) => (order.push(`disable:${JSON.stringify(bodyOf(init))}`), ok({ member: memberDetail().member, changed: true })),
      }),
    })
    await screen.findAllByText('小王')
    await userEvent.click(screen.getByRole('button', { name: /^停\s*用$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^停\s*用$/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.type(within(dialog).getByRole('textbox', { name: /停用原因/ }), '已离职')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^停\s*用$/ }))
    await waitFor(() => expect(order).toEqual(['step-up:member.manage', 'disable:{"reason":"已离职"}']))
  })

  it('已停用的成员显示“恢复”，没有“停用”', T, async () => {
    const disabled = memberDetail({
      member: { ...memberDetail().member, status: 'DISABLED', disabledAt: '2026-10-20T00:00:00.000Z', disabledReason: '已离职' },
      actions: { disable: '已停用', enable: null, role: null, scopes: null },
    })
    mountApp({ url: '/app/members/m2', pages, handlers: handlers({ '/members/m2': () => ok(disabled) }) })
    expect(await screen.findByRole('button', { name: /^恢\s*复$/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^停\s*用$/ })).not.toBeInTheDocument()
  })

  it('修改角色：选新角色、写原因、先验证身份，请求体带角色与原因', T, async () => {
    const order: string[] = []
    mountApp({
      url: '/app/members/m2',
      pages,
      handlers: handlers({
        ...stepUp(order),
        '/members/m2/role': (_url, init) => (order.push(`role:${JSON.stringify(bodyOf(init))}`), ok({ member: memberDetail().member, changed: true })),
      }),
    })
    await screen.findAllByText('小王')
    await userEvent.click(screen.getByRole('button', { name: /修改角色/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '角色' }))
    await userEvent.click(await screen.findByTitle('所有者'))
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '升为负责人')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(order).toEqual(['step-up:member.manage', 'role:{"roleId":"r-owner","reason":"升为负责人"}']))
  })

  it('修改数据范围：用现有授权回填；改为“全部”时不带具体主体与店铺', T, async () => {
    const order: string[] = []
    mountApp({
      url: '/app/members/m2',
      pages,
      handlers: handlers({
        ...stepUp(order),
        '/members/m2/scopes': (_url, init) => (order.push(`scopes:${JSON.stringify(bodyOf(init))}`), ok({ member: memberDetail().member, changed: true })),
      }),
    })
    await screen.findAllByText('小王')
    await userEvent.click(screen.getByRole('button', { name: /修改数据范围/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: '指定主体与店铺' })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('radio', { name: '全部主体与店铺' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '负责全部店铺')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(order).toEqual(['step-up:member.manage', 'scopes:{"scope":{"all":true,"legalEntityIds":[],"sellerAccountIds":[]},"reason":"负责全部店铺"}']))
  })
})
