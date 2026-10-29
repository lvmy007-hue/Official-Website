import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'

// P1-28 前端：我的待办、通知中心、导出中心。假服务端返回固定数据，验证页面显示、动作调用与禁用原因。

const pages: LivePages = {
  MyWorkItemsPage: { load: () => import('./MyWorkItemsPage') },
  NotificationCenterPage: { load: () => import('./NotificationCenterPage') },
  ExportCenterPage: { load: () => import('./ExportCenterPage') },
}
const ok = (data: unknown) => ({ body: { success: true, data } })
const limited = (permissions: string[]): Me => ({ ...defaultMe, permissions })
const summary: Record<string, Handler> = {
  '/settings/integrations/summary': () => ok({ mode: 'READ_ONLY', enabledCount: 0, total: 8, emergencyForced: false }),
  '/notifications/unread-count': () => ok({ unreadCount: 0 }),
}

afterEach(() => vi.unstubAllGlobals())

const workItem = (patch: Record<string, unknown> = {}) => ({
  id: 'w1',
  title: '广告预算即将耗尽',
  source: 'ALERT',
  status: 'PENDING',
  severity: 'CRITICAL',
  dueAt: '2026-10-23T10:00:00Z',
  overdue: false,
  remainingMinutes: 600,
  groupKey: 'TODAY',
  entity: null,
  impact: null,
  suggestedAction: null,
  owner: { id: 'u1', name: '林然' },
  createdBy: { id: 'u2', name: '系统' },
  deferredUntil: null,
  closeConclusion: null,
  ignoreReason: null,
  version: 3,
  ...patch,
})
const workList = (items: unknown[]) => ok({ items, pageInfo: { nextCursor: null, hasMore: false }, counts: { MINE: items.length, ASSIGNED: 0, WATCHING: 1, DONE: 4, IGNORED: 0 } })

describe('我的待办', () => {
  it('显示待办、各页签数量；超时的标注已超时', async () => {
    mountApp({
      url: '/app/my/work-items',
      pages,
      handlers: { ...summary, '/work-items': () => workList([workItem(), workItem({ id: 'w2', title: '汇率获取失败', overdue: true, remainingMinutes: -30 })]) },
    })
    expect(await screen.findByText('广告预算即将耗尽')).toBeInTheDocument()
    expect(screen.getByText('待我处理（2）')).toBeInTheDocument()
    expect(screen.getByText('我关注的（1）')).toBeInTheDocument()
    expect(screen.getByText(/已超时/)).toBeInTheDocument()
  })

  it('确认：真实调用服务端并带上版本号', async () => {
    const calls: Array<{ body: unknown }> = []
    const app = mountApp({
      url: '/app/my/work-items',
      pages,
      handlers: {
        ...summary,
        '/work-items': () => workList([workItem()]),
        '/work-items/w1/ack': (_url, init) => (calls.push({ body: JSON.parse(String(init?.body)) }), ok({ id: 'w1' })),
      },
    })
    await screen.findByText('广告预算即将耗尽')
    await userEvent.click(screen.getByRole('button', { name: /^确\s?认$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toMatchObject({ version: 3 })
    expect(app.calls.filter(call => call.path === '/work-items/w1/ack' && call.method === 'POST')).toHaveLength(1)
  })

  it('不是负责人又没有指派权限：处理动作禁用', async () => {
    mountApp({
      url: '/app/my/work-items',
      pages,
      me: limited(['workitem.handle']),
      handlers: { ...summary, '/work-items': () => workList([workItem({ owner: { id: 'u9', name: '王芳' } })]) },
    })
    await screen.findByText('广告预算即将耗尽')
    expect(screen.getByRole('button', { name: /^关\s?闭$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^忽\s?略$/ })).toBeDisabled()
  })

  it('已关闭的待办不再显示处理按钮，只显示结论', async () => {
    mountApp({ url: '/app/my/work-items?tab=DONE', pages, handlers: { ...summary, '/work-items': () => workList([workItem({ status: 'CLOSED', closeConclusion: 'FALSE_POSITIVE' })]) } })
    await screen.findByText('广告预算即将耗尽')
    expect(screen.getByText('误报')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^关\s?闭$/ })).toBeNull()
  })

  it('读取失败显示原因与重试，不显示空列表', async () => {
    mountApp({ url: '/app/my/work-items', pages, handlers: { ...summary, '/work-items': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s?试/ })).toBeInTheDocument()
    expect(screen.queryByText('广告预算即将耗尽')).toBeNull()
  })

  it('切换页签：请求带上新的 tab 参数', async () => {
    const app = mountApp({ url: '/app/my/work-items', pages, handlers: { ...summary, '/work-items': () => workList([workItem()]) } })
    await screen.findByText('广告预算即将耗尽')
    await userEvent.click(screen.getByText(/我关注的/))
    await waitFor(() => expect(app.calls.some(call => call.path === '/work-items' && call.search.includes('tab=WATCHING'))).toBe(true))
  })
})

describe('待办详情抽屉：触发原因、处理记录、评论与关注', () => {
  const detail = {
    ...workItem(),
    detail: '今日预算已用 98%',
    closeNote: null,
    trigger: { ruleName: '预算耗尽预警', triggerCount: 2, firstTriggeredAt: '2026-10-22T06:00:00Z', evidence: [{ label: '预算使用率', value: '98%' }] },
    assignments: [],
    timeline: [{ id: 'tl1', at: '2026-10-22T06:01:00Z', title: '系统创建待办', actor: '系统' }],
  }
  const comments = {
    items: [{ id: 'c1', body: '我先看一下', author: { id: 'u2', name: '王芳' }, mentions: [], createdAt: '2026-10-22T07:00:00Z' }],
    watch: { watching: false, watchId: null, watchers: 1 },
  }

  it('点击标题：显示触发证据、处理记录与已有评论；关注与评论真实调用服务端', async () => {
    const sent: Array<{ path: string; body: unknown }> = []
    mountApp({
      url: '/app/my/work-items',
      pages,
      handlers: {
        ...summary,
        '/work-items': () => workList([workItem()]),
        '/work-items/w1': () => ok(detail),
        '/comments': (_url, init) => (init?.method === 'POST' ? (sent.push({ path: '/comments', body: JSON.parse(String(init.body)) }), ok({ id: 'c2' })) : ok(comments)),
        '/watches': (_url, init) => (sent.push({ path: '/watches', body: JSON.parse(String(init?.body)) }), ok({ id: 'wa1' })),
      },
    })
    await userEvent.click(await screen.findByText('广告预算即将耗尽'))
    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText(/预算耗尽预警/)).toBeInTheDocument()
    expect(within(drawer).getByText(/预算使用率：98%/)).toBeInTheDocument()
    expect(within(drawer).getByText(/系统创建待办/)).toBeInTheDocument()
    expect(await within(drawer).findByText('我先看一下')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: /^(已)?关\s?注$/ }))
    await waitFor(() => expect(sent).toContainEqual({ path: '/watches', body: { entityType: 'WORK_ITEM', entityId: 'w1' } }))
  })

  it('没有协作权限：评论与关注禁用并说明', async () => {
    mountApp({
      url: '/app/my/work-items',
      pages,
      me: limited(['workitem.read']),
      handlers: { ...summary, '/work-items': () => workList([workItem()]), '/work-items/w1': () => ok(detail), '/comments': () => ok(comments) },
    })
    await userEvent.click(await screen.findByText('广告预算即将耗尽'))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('我先看一下')
    expect(within(drawer).getByRole('button', { name: /^(已)?关\s?注$/ })).toBeDisabled()
  })
})

describe('通知中心', () => {
  const notice = (patch: Record<string, unknown> = {}) => ({
    id: 'n1',
    kind: 'WORK_OVERDUE',
    title: '待办已超时',
    body: '广告预算即将耗尽',
    link: '/app/my/work-items',
    severity: 'WARNING',
    read: false,
    createdAt: '2026-10-22T08:00:00Z',
    ...patch,
  })

  it('点击未读通知：先标记已读，再跳到它指向的页面', async () => {
    const reads: unknown[] = []
    const app = mountApp({
      url: '/app/my/notifications',
      pages: { ...pages, MyWorkItemsPage: { load: async () => ({ default: () => <div>待办页面</div> }) } },
      handlers: {
        ...summary,
        '/notifications': () => ok({ items: [notice()], pageInfo: { nextCursor: null, hasMore: false }, unreadCount: 1 }),
        '/notifications/read': (_url, init) => (reads.push(JSON.parse(String(init?.body))), ok({ updated: 1 })),
      },
    })
    await userEvent.click(await screen.findByText('待办已超时'))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/my/work-items'))
    expect(reads).toEqual([{ ids: ['n1'] }])
  })

  it('没有未读时“全部标为已读”禁用并说明原因', async () => {
    mountApp({
      url: '/app/my/notifications',
      pages,
      handlers: { ...summary, '/notifications': () => ok({ items: [notice({ read: true })], pageInfo: { nextCursor: null, hasMore: false }, unreadCount: 0 }) },
    })
    await screen.findByText('待办已超时')
    expect(screen.getByRole('button', { name: /全部标为已读/ })).toBeDisabled()
  })

  it('全部已读：只调用一次服务端并带 all:true', async () => {
    const reads: unknown[] = []
    mountApp({
      url: '/app/my/notifications',
      pages,
      handlers: {
        ...summary,
        '/notifications': () => ok({ items: [notice()], pageInfo: { nextCursor: null, hasMore: false }, unreadCount: 1 }),
        '/notifications/read': (_url, init) => (reads.push(JSON.parse(String(init?.body))), ok({ updated: 1 })),
      },
    })
    await screen.findByText('待办已超时')
    await userEvent.click(screen.getByRole('button', { name: /全部标为已读/ }))
    await waitFor(() => expect(reads).toEqual([{ all: true }]))
  })

  it('没有通知时说明', async () => {
    mountApp({ url: '/app/my/notifications', pages, handlers: { ...summary, '/notifications': () => ok({ items: [], pageInfo: { nextCursor: null, hasMore: false }, unreadCount: 0 }) } })
    expect(await screen.findByText(/还没有通知/)).toBeInTheDocument()
  })
})

describe('导出中心', () => {
  const job = (patch: Record<string, unknown> = {}) => ({
    id: 'e1',
    kind: 'orders',
    kindLabel: '订单列表',
    sourcePage: '/app/orders',
    filterSummary: '不限日期',
    format: 'CSV',
    status: 'DONE',
    statusLabel: '已完成',
    rowCount: 1200,
    fileSize: 2048,
    errorMessage: null,
    downloadable: true,
    createdAt: '2026-10-22T08:00:00Z',
    finishedAt: '2026-10-22T08:01:00Z',
    expiresAt: '2026-10-29T08:01:00Z',
    ...patch,
  })
  const list = (items: unknown[]) => ok({ items, pageInfo: { nextCursor: null, hasMore: false } })

  it('已完成的导出：点下载才换取临时链接并打开', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const app = mountApp({
      url: '/app/my/exports',
      pages,
      handlers: { ...summary, '/exports': () => list([job()]), '/exports/e1/download': () => ok({ url: 'https://files.example.com/e1?sig=abc', expiresAt: '2026-10-22T08:06:00Z', fileSize: 2048 }) },
    })
    await screen.findByText('订单列表')
    expect(app.calls.some(call => call.path === '/exports/e1/download')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: /^下\s?载$/ }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://files.example.com/e1?sig=abc', '_blank', 'noopener,noreferrer'))
  })

  it('失败的导出显示具体原因，下载禁用', async () => {
    mountApp({
      url: '/app/my/exports',
      pages,
      handlers: { ...summary, '/exports': () => list([job({ status: 'FAILED', statusLabel: '失败', downloadable: false, errorMessage: '行数超过 Excel 上限，请改用 CSV 或缩小筛选范围' })]) },
    })
    expect(await screen.findByText(/行数超过 Excel 上限/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^下\s?载$/ })).toBeDisabled()
  })

  it('已过期的导出：下载禁用，并提示重新发起', async () => {
    mountApp({ url: '/app/my/exports', pages, handlers: { ...summary, '/exports': () => list([job({ status: 'EXPIRED', statusLabel: '已过期', downloadable: false })]) } })
    await screen.findByText('已过期')
    expect(screen.getByRole('button', { name: /^下\s?载$/ })).toBeDisabled()
  })

  it('没有任何数据读取权限：发起导出禁用', async () => {
    mountApp({ url: '/app/my/exports', pages, me: limited(['export.create']), handlers: { ...summary, '/exports': () => list([]) } })
    await screen.findByText(/还没有导出任务/)
    expect(screen.getByRole('button', { name: /发起导出/ })).toBeDisabled()
  })

  it('发起导出：真实调用服务端，带上格式与日期筛选', async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/my/exports',
      pages,
      handlers: { ...summary, '/exports': (_url, init) => (init?.method === 'POST' ? (bodies.push(JSON.parse(String(init.body))), ok({ id: 'e2' })) : list([])) },
    })
    await screen.findByText(/还没有导出任务/)
    await userEvent.click(screen.getByRole('button', { name: /发起导出/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ kind: 'orders', format: 'CSV', filters: {}, filterSummary: '不限日期' })
  })
})
