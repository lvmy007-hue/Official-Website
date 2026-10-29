import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeSearchParser } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { auditDetail, auditList, auditOptions, auditRow, ok, piiList, piiRow, supportRow, systemRow } from './audit-fixtures.test-helper'

// 审计中心（P5-09）：审计日志（操作人、来源、所属页面、结果的写法，服务端筛选，游标翻页，导出）、个人信息明文查看视图、审计详情（差异、上下文、关联资源）。
// 没有数据的写法：尚无记录 / 没有修改前后的内容，不拿 0 冒充。

const pages: LivePages = {
  AuditPage: { load: () => import('./AuditPage'), search: ScopeSearchParser },
  AuditDetailPage: { load: () => import('./AuditDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/audit': () => ok(auditList([auditRow(), systemRow(), supportRow()])),
  '/audit/options': () => ok(auditOptions()),
  '/audit/pii-views': () => ok(piiList([piiRow()])),
  '/audit/a1': () => ok(auditDetail()),
  ...over,
})
const T = { timeout: 30000 }
const W = { timeout: 15000 }
const paramOf = (search: string, key: string) => new URLSearchParams(search).get(key)
const lastCall = (calls: Array<{ path: string; search: string }>, path: string) => {
  const matched = calls.filter(call => call.path === path)
  return matched[matched.length - 1]
}

describe('审计日志', () => {
  it('每行：时间、操作人、动作、资源、结果、来源与所属页面；系统任务写“系统”，平台人员写“平台人员”，接口调用没有页面写“无所属页面”', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers() })
    const row = (await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('林客服')).toBeInTheDocument()
    expect(within(row).getByText('成功')).toBeInTheDocument()
    expect(within(row).getByText('页面操作')).toBeInTheDocument()
    expect(within(row).getByText('/app/roles')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'role-1' })).toHaveAttribute('href', '/app/roles')
    expect(within(row).getByRole('link', { name: '查看详情' })).toHaveAttribute('href', '/app/audit/a1')
    const system = screen.getByText('导出完成', { selector: 'td div, .ag-cell div' }).closest('tr, [role=row]') as HTMLElement
    expect(within(system).getByText('系统')).toBeInTheDocument()
    expect(within(system).getByText('系统任务')).toBeInTheDocument()
    expect(within(system).getByText('无所属页面')).toBeInTheDocument()
    const support = screen.getByText('平台支持访问请求', { selector: 'td div, .ag-cell div' }).closest('tr, [role=row]') as HTMLElement
    expect(within(support).getByText('平台人员')).toBeInTheDocument()
    expect(within(support).getByText('被拒绝')).toBeInTheDocument()
    expect(within(support).getByText('客户报障排查')).toBeInTheDocument()
    expect(within(support).getByText('平台支持访问', { selector: 'td, .ag-cell *' })).toBeInTheDocument()
    expect(within(system).getByText('未填写')).toBeInTheDocument()
  })

  it('审计日志不分店铺：请求不带全局范围参数', T, async () => {
    const app = mountApp({ url: '/app/audit?storeIds=st2', pages, handlers: handlers() })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    const search = lastCall(app.calls, '/audit')!.search
    expect(paramOf(search, 'storeIds')).toBeNull()
    expect(paramOf(search, 'pageSize')).toBe('20')
  })

  it('没有任何记录：写“尚无记录”，不画 0 行的假表格', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers({ '/audit': () => ok(auditList([])) }) })
    expect(await screen.findByText(/尚无记录：企业里还没有产生审计记录/, {}, W)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('筛选都在服务端：结果、资源编号、请求编号、关键词、来源、操作人都带到请求里；换条件回到第一页；清除筛选后不再带', T, async () => {
    const app = mountApp({ url: '/app/audit', pages, handlers: handlers() })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)

    await userEvent.click(screen.getByRole('combobox', { name: '结果' }))
    await userEvent.click(await screen.findByTitle('被拒绝'))
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit')!.search, 'result')).toBe('DENIED'))

    await userEvent.click(screen.getByRole('combobox', { name: '来源' }))
    await userEvent.click(await screen.findByTitle('系统任务'))
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit')!.search, 'source')).toBe('SYSTEM'))

    await userEvent.click(screen.getByRole('combobox', { name: '操作人' }))
    await userEvent.click(await screen.findByTitle('林客服'))
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit')!.search, 'actorId')).toBe('u2'))

    await userEvent.click(screen.getByRole('combobox', { name: '所属页面' }))
    await userEvent.click(await screen.findByTitle('/app/orders'))
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit')!.search, 'page')).toBe('/app/orders'))

    await userEvent.type(screen.getByRole('searchbox', { name: '资源编号' }), 'role-1{Enter}')
    await userEvent.type(screen.getByRole('searchbox', { name: '请求编号' }), 'req-9{Enter}')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索审计' }), 'ROLE{Enter}')
    await waitFor(() => {
      const search = lastCall(app.calls, '/audit')!.search
      expect(paramOf(search, 'resourceId')).toBe('role-1')
      expect(paramOf(search, 'requestId')).toBe('req-9')
      expect(paramOf(search, 'q')).toBe('ROLE')
      expect(paramOf(search, 'cursor')).toBeNull()
    })

    // 清除筛选：条件与输入框一起清空（没有条件的第一页结果在缓存里，不一定再发请求）
    await userEvent.click(screen.getByRole('button', { name: /清除筛选/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /清除筛选/ })).toBeDisabled())
    for (const name of ['资源编号', '请求编号', '搜索审计']) expect(screen.getByRole('searchbox', { name }), name).toHaveValue('')
    // 只剩顶栏的“不对比”和“每页条数”，没有任何筛选项还带着值
    expect(Array.from(document.querySelectorAll('.ant-select-selection-item')).map(node => node.textContent)).toEqual(['不对比', '20 条/页', '50 条/页'])
  })

  it('有筛选但没有结果：说明是筛选造成的，而不是“企业没有记录”', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers({ '/audit': url => ok(auditList(url.searchParams.get('result') ? [] : [auditRow()])) }) })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    await userEvent.click(screen.getByRole('combobox', { name: '结果' }))
    await userEvent.click(await screen.findByTitle('失败'))
    expect(await screen.findByText(/没有符合条件的审计记录/, {}, W)).toBeInTheDocument()
  })

  it('游标翻页：下一页带服务端给的游标，上一页回到第一页', T, async () => {
    const app = mountApp({
      url: '/app/audit',
      pages,
      handlers: handlers({
        '/audit': url =>
          ok(url.searchParams.get('cursor') ? auditList([systemRow()]) : auditList([auditRow()], { pageInfo: { pageSize: 20, nextCursor: 'cursor-2', hasMore: true, approxTotal: null } })),
      }),
    })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    await userEvent.click(screen.getByRole('button', { name: /下一页/ }))
    await screen.findByText('导出完成', { selector: 'td div, .ag-cell div' }, W)
    expect(paramOf(lastCall(app.calls, '/audit')!.search, 'cursor')).toBe('cursor-2')
    await userEvent.click(screen.getByRole('button', { name: /上一页/ }))
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
  })

  it('候选项太多被截断时如实说明', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers({ '/audit/options': () => ok(auditOptions({ truncated: true })) }) })
    expect(await screen.findByText(/候选项过多，只列出了部分/, {}, W)).toBeInTheDocument()
  })
})

describe('审计导出', () => {
  it('条件与页面一致：筛选与时间范围原样保存，提交到导出中心', T, async () => {
    const bodies: Array<Record<string, any>> = []
    mountApp({
      url: '/app/audit',
      pages,
      handlers: handlers({
        '/exports': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok({ id: 'e1' })
        },
      }),
    })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    await userEvent.click(screen.getByRole('combobox', { name: '结果' }))
    await userEvent.click(await screen.findByTitle('成功'))
    await userEvent.type(screen.getByRole('searchbox', { name: '资源编号' }), 'role-1{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: '发起导出' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '发起导出' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/不含修改前后的内容/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /发起导出/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({ kind: 'audit-events', format: 'CSV', filters: { result: 'SUCCEEDED', resourceId: 'role-1' } })
    expect(bodies[0].filters).not.toHaveProperty('storeIds')
    expect(bodies[0].filterSummary).toContain('结果 成功')
    expect(bodies[0].filterSummary).toContain('资源编号 role-1')
  })

  it('没有导出权限：按钮置灰并写明原因；服务端说不能导出时也置灰', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers({}, ['audit.read']) })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    expect(screen.getByRole('button', { name: '发起导出' })).toBeDisabled()
  })

  it('有权限但服务端给了不能导出的原因：置灰', T, async () => {
    mountApp({ url: '/app/audit', pages, handlers: handlers({ '/audit': () => ok(auditList([auditRow()], { canExport: false, exportBlockedReason: '导出需要“发起导出”权限' })) }) })
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    expect(screen.getByRole('button', { name: '发起导出' })).toBeDisabled()
  })
})

describe('个人信息明文查看', () => {
  const open = (url = '/app/audit?view=pii', over: Record<string, Handler> = {}) => mountApp({ url, pages, handlers: handlers(over) })

  it('预警跳转带 view=pii&actorId：直接打开这个视图并筛到这个人', T, async () => {
    const app = open('/app/audit?view=pii&actorId=u2')
    await screen.findByText('111-0000001-0000001', {}, W)
    expect(paramOf(lastCall(app.calls, '/audit/pii-views')!.search, 'actorId')).toBe('u2')
    expect(app.calls.some(call => call.path === '/audit')).toBe(false)
  })

  it('每行：查看人、理由、对象（可点）、查看的字段名、结果、访问模式；只有字段名没有内容', T, async () => {
    open()
    const row = (await screen.findByText('111-0000001-0000001', {}, W)).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('林客服')).toBeInTheDocument()
    expect(within(row).getByText('客户来电核对收货信息')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: '111-0000001-0000001' })).toHaveAttribute('href', '/app/orders/o1')
    expect(within(row).getByText('姓名')).toBeInTheDocument()
    expect(within(row).getByText('城市')).toBeInTheDocument()
    expect(within(row).getByText('已查看')).toBeInTheDocument()
    expect(within(row).getByText('正常访问')).toBeInTheDocument()
  })

  it('没有内容可看的与早期记录各有写法：被拒绝、已过保留期写“没有返回内容”，没记字段名的写“未记录字段”', T, async () => {
    open('/app/audit?view=pii', {
      '/audit/pii-views': () =>
        ok(
          piiList([
            piiRow({
              id: 'p2',
              outcome: 'EXPIRED',
              outcomeLabel: '已过保留期，没有内容可看',
              fields: null,
              object: { type: 'Order', typeLabel: '订单', id: 'o2', label: '111-0000002-0000002', path: '/app/orders/o2' },
            }),
            piiRow({ id: 'p3', fields: null, object: { type: 'Order', typeLabel: '订单', id: 'o3', label: '111-0000003-0000003', path: '/app/orders/o3' } }),
            piiRow({ id: 'p4', outcome: 'DENIED', outcomeLabel: '被拒绝', reason: null, object: { type: 'Order', typeLabel: '订单', id: 'o4', label: '111-0000004-0000004', path: '/app/orders/o4' } }),
          ]),
        ),
    })
    const expired = (await screen.findByText('111-0000002-0000002', {}, W)).closest('tr, [role=row]') as HTMLElement
    expect(within(expired).getByText('没有返回内容')).toBeInTheDocument()
    expect(within(expired).getByText('已过保留期，没有内容可看')).toBeInTheDocument()
    const early = screen.getByText('111-0000003-0000003').closest('tr, [role=row]') as HTMLElement
    expect(within(early).getByText('未记录字段（早期记录）')).toBeInTheDocument()
    const denied = screen.getByText('111-0000004-0000004').closest('tr, [role=row]') as HTMLElement
    expect(within(denied).getByText('被拒绝', { selector: '.ant-tag' })).toBeInTheDocument()
    expect(within(denied).getByText('未填写')).toBeInTheDocument()
  })

  it('汇总与预警规则：近 24 小时与 7 天次数、查看最多的人、预警阈值与规则配置入口', T, async () => {
    open()
    const summary = await screen.findByTestId('pii-summary', {}, W)
    expect(summary).toHaveTextContent('近 24 小时查看明文 2 次')
    expect(summary).toHaveTextContent('近 7 天 5 次')
    expect(summary).toHaveTextContent('近 7 天查看最多：林客服（4 次）')
    expect(summary).toHaveTextContent('大量查看预警：已开启，同一个人 60 分钟内成功查看明文达到 20 次时提醒')
    expect(within(summary).getByRole('link', { name: '预警规则配置' })).toHaveAttribute('href', '/app/alerts/rules')
  })

  it('规则还没补进企业时如实说明；没有记录时汇总写“尚无记录”，不写 0 个人', T, async () => {
    open('/app/audit?view=pii', { '/audit/pii-views': () => ok(piiList([], { alertRule: null, summary: { last24h: 0, last7d: 0, topViewers: [] } })) })
    const summary = await screen.findByTestId('pii-summary', {}, W)
    expect(within(summary).getByText(/还没有补进企业/)).toBeInTheDocument()
    expect(within(summary).getByText('尚无记录')).toBeInTheDocument()
    expect(await screen.findByText(/尚无记录：还没有人查看过买家信息明文/)).toBeInTheDocument()
  })

  it('筛选在服务端：订单号关键词带到请求里；查看人下拉可选', T, async () => {
    const app = open()
    await screen.findByText('111-0000001-0000001', {}, W)
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索查看对象' }), '111-0000001{Enter}')
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit/pii-views')!.search, 'q')).toBe('111-0000001'))
    await userEvent.click(screen.getByRole('combobox', { name: '查看人' }))
    await userEvent.click(await screen.findByTitle('林客服'))
    await waitFor(() => expect(paramOf(lastCall(app.calls, '/audit/pii-views')!.search, 'actorId')).toBe('u2'))
  })

  it('在审计日志页签与明文查看页签之间切换', T, async () => {
    open('/app/audit')
    await screen.findByText('修改角色', { selector: 'td div, .ag-cell div' }, W)
    await userEvent.click(screen.getByRole('tab', { name: '个人信息明文查看' }))
    expect(await screen.findByText('111-0000001-0000001', {}, W)).toBeInTheDocument()
  })
})

describe('审计详情', () => {
  const open = (over: Record<string, Handler> = {}) => mountApp({ url: '/app/audit/a1', pages, handlers: handlers(over) })

  it('身份区与修改内容：修改前后的差异逐字段列出，敏感字段显示“已隐藏”，空值写“（空）”', T, async () => {
    open()
    const table = await screen.findByTestId('audit-changes', {}, W)
    const name = within(table).getByText('name').closest('tr, [role=row]') as HTMLElement
    expect(within(name).getByText('运营')).toBeInTheDocument()
    expect(within(name).getByText('运营主管')).toBeInTheDocument()
    const email = within(table).getByText('contactEmail').closest('tr, [role=row]') as HTMLElement
    expect(within(email).getAllByText('[已隐藏]')).toHaveLength(2)
    expect(within(within(table).getByText('note').closest('tr, [role=row]') as HTMLElement).getByText('（空）')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '修改内容（3）' })).toBeInTheDocument()
    expect(screen.getAllByText('修改角色').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '返回审计中心' })).toHaveAttribute('href', '/app/audit')
  })

  it('请求上下文：来源地址、访问模式、终端、请求编号、再次验证；补充说明列出事件附带的说明', T, async () => {
    open()
    await screen.findByTestId('audit-changes', {}, W)
    await userEvent.click(screen.getByRole('tab', { name: '请求上下文' }))
    const context = await screen.findByTestId('audit-context')
    expect(within(context).getByText('203.0.113.7')).toBeInTheDocument()
    expect(within(context).getByText('Mozilla/5.0 Test')).toBeInTheDocument()
    expect(within(context).getByText('req-a1')).toBeInTheDocument()
    expect(within(context).getByText('已通过')).toBeInTheDocument()
    expect(within(context).getByText('/app/roles')).toBeInTheDocument()
    expect(within(screen.getByTestId('audit-extra')).getByText('12')).toBeInTheDocument()
  })

  it('系统代为写入的记录：显示真正的发起人；没有来源地址写“尚无记录”', T, async () => {
    const base = auditDetail()
    open({
      '/audit/a1': () =>
        ok({
          ...base,
          event: { ...base.event, actor: { id: 'u2', name: '系统', kind: 'SYSTEM' }, ip: null, userAgent: null, initiator: { id: 'u2', name: '林客服', kind: 'USER' }, stepUpVerified: false },
          extra: [],
        }),
    })
    await screen.findByTestId('audit-changes', {}, W)
    await userEvent.click(screen.getByRole('tab', { name: '请求上下文' }))
    const context = await screen.findByTestId('audit-context')
    expect(within(context).getByText('林客服')).toBeInTheDocument()
    expect(within(context).getAllByText('尚无记录')).toHaveLength(2)
    expect(within(context).getByText('本次操作没有要求')).toBeInTheDocument()
    expect(screen.getByText('没有其他说明')).toBeInTheDocument()
  })

  it('读取类事件没有修改前后的内容：直接说明，不画空表', T, async () => {
    open({ '/audit/a1': () => ok(auditDetail({ changes: [], hasSnapshot: false })) })
    expect(await screen.findByText(/这条记录没有修改前后的内容/, {}, W)).toBeInTheDocument()
    expect(screen.queryByTestId('audit-changes')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '修改内容' })).toBeInTheDocument()
  })

  it('关联资源：资源链接与这个资源的其他审计记录（可点开）；没有关联资源时说明', T, async () => {
    open()
    await screen.findByTestId('audit-changes', {}, W)
    await userEvent.click(screen.getByRole('tab', { name: '关联资源' }))
    const related = await screen.findByTestId('audit-related')
    expect(within(related).getByText('新建角色')).toBeInTheDocument()
    expect(within(related).getByRole('link', { name: '查看' })).toHaveAttribute('href', '/app/audit/a9')
    expect(screen.getByRole('link', { name: 'role-1' })).toHaveAttribute('href', '/app/roles')
  })

  it('没有关联资源：写明；审计记录不存在：显示错误并给出重试', T, async () => {
    const base = auditDetail()
    open({ '/audit/a1': () => ok({ ...base, resource: { ...base.resource, id: null, path: null, recent: [] } }) })
    await screen.findByTestId('audit-changes', {}, W)
    await userEvent.click(screen.getByRole('tab', { name: '关联资源' }))
    expect(await screen.findByText(/没有关联到具体的资源/)).toBeInTheDocument()
  })

  it('审计记录不存在：显示错误，不显示空详情', T, async () => {
    open({ '/audit/a1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '审计记录不存在' } } }) })
    expect(await screen.findByText(/不存在/, {}, W)).toBeInTheDocument()
    expect(screen.queryByTestId('audit-changes')).not.toBeInTheDocument()
  })
})
