import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiQueryKey } from '../query/api-query'
import { defaultMe, mountApp, type Handler } from '../test/app-harness'
import type { LivePages } from '../routes/live-pages'
import { setDensity } from '../theme/density'
import { UNREAD_POLL_MS } from './NoticeEntry'
import { tabsStorageKey } from './tab-state'

// 外壳（P6-01）：多页签、收藏、顶栏消息与预警浮层、密度。

const pages: LivePages = {
  OrdersPage: { load: async () => ({ default: () => <div>订单页内容</div> }) },
  FeeEventsPage: { load: async () => ({ default: () => <div>费用页内容</div> }) },
  ProfilePage: { load: async () => ({ default: () => <div>个人账号内容</div> }) },
  NotificationCenterPage: { load: async () => ({ default: () => <div>通知中心内容</div> }) },
  AlertsPage: { load: async () => ({ default: () => <div>预警中心内容</div> }) },
  InventoryDetailPage: { load: async () => ({ default: () => <div>库存详情内容</div> }) },
}

const ok = (data: unknown) => ({ body: { success: true, data } })
const prefs = (patch: Record<string, unknown> = {}) => ({
  notify: { kinds: {}, quiet: null },
  favorites: [] as string[],
  density: 'STANDARD',
  version: 0,
  updatedAt: null,
  zone: 'America/Los_Angeles',
  ...patch,
})
/** 页签条里的各个页签（按钮，不含关闭按钮与页签操作）。 */
const tabsOf = (bar: HTMLElement) => Array.from(bar.querySelectorAll<HTMLElement>('.erp-tab-title'))
const STORAGE = tabsStorageKey(defaultMe.activeTenantId, defaultMe.user.id)

/** 带状态的偏好接口：PUT 记录请求体并返回新版本。 */
function prefsHandlers(initial: Record<string, unknown> = {}, onPut?: (body: Record<string, unknown>) => { status?: number; body: unknown } | void) {
  let state = prefs(initial)
  const puts: Array<Record<string, unknown>> = []
  const handler: Handler = (_url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      puts.push(body)
      const override = onPut?.(body)
      if (override) return override
      state = { ...state, ...body, version: Number(state.version) + 1 }
      return ok(state)
    }
    return ok(state)
  }
  return { handlers: { '/me/preferences': handler }, puts }
}

beforeEach(() => {
  localStorage.clear()
  setDensity('STANDARD')
})
afterEach(() => vi.unstubAllGlobals())

describe('多页签', () => {
  it('打开的页面自动成为页签；点页签切换，关闭当前回到相邻页签；状态写进按企业与成员区分的本机存储', async () => {
    const user = userEvent.setup()
    const app = mountApp({ url: '/app/orders', pages })
    const bar = await screen.findByTestId('tab-bar')
    await app.router.navigate({ to: '/app/finance' as never })
    await waitFor(() => expect(tabsOf(bar)).toHaveLength(2))
    const tabs = tabsOf(bar)
    expect(tabs.map(item => item.textContent)).toEqual(['订单', '费用事件'])
    expect(tabs[1]).toHaveAttribute('aria-current', 'page')

    await user.click(tabs[0])
    await screen.findByText('订单页内容')
    expect(app.router.state.location.pathname).toBe('/app/orders')

    await user.click(within(bar).getByRole('button', { name: '关闭页签 订单' }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/finance'))
    expect(tabsOf(bar)).toHaveLength(1)
    // 只剩一个页签时不显示关闭按钮
    expect(within(bar).queryByRole('button', { name: /关闭页签/ })).toBeNull()
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE) ?? '[]').map((item: { path: string }) => item.path)).toEqual(['/app/finance']))
  })

  it('切回页签用查询串还原筛选条件', async () => {
    const user = userEvent.setup()
    const app = mountApp({ url: '/app/orders?storeIds=st1', pages })
    const bar = await screen.findByTestId('tab-bar')
    await app.router.navigate({ to: '/app/finance' as never })
    await waitFor(() => expect(tabsOf(bar)).toHaveLength(2))
    await user.click(within(bar).getByRole('button', { name: '订单' }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/orders'))
    expect(app.router.state.location.searchStr).toContain('storeIds=st1')
  })

  it('刷新后从本机存储还原；不在清单、没权限、被篡改的项不还原', async () => {
    localStorage.setItem(
      STORAGE,
      JSON.stringify([
        { path: '/app/finance', search: '', title: '费用事件', usedAt: 1, scrollY: 0 },
        { path: '/app/not-a-page', search: '', title: '不存在', usedAt: 1, scrollY: 0 },
        { path: '/app/audit', search: '', title: '审计', usedAt: 1, scrollY: 0 },
        { path: '/app/profile', search: 'bad', title: '查询串坏了', usedAt: 1, scrollY: 0 },
      ]),
    )
    mountApp({ url: '/app/orders', pages, me: { ...defaultMe, permissions: ['orders.read', 'finance.read'] } })
    const bar = await screen.findByTestId('tab-bar')
    await waitFor(() => expect(tabsOf(bar).map(item => item.textContent)).toEqual(['费用事件', '订单']))
  })

  it('换成员：看不到别人的页签', async () => {
    localStorage.setItem(tabsStorageKey(defaultMe.activeTenantId, 'someone-else'), JSON.stringify([{ path: '/app/finance', search: '', title: '费用事件', usedAt: 1, scrollY: 0 }]))
    mountApp({ url: '/app/orders', pages })
    const bar = await screen.findByTestId('tab-bar')
    await waitFor(() => expect(tabsOf(bar)).toHaveLength(1))
  })

  it('详情页每个对象一个页签，没有对象名时用编号末 6 位区分', async () => {
    const app = mountApp({ url: '/app/inventory/abcdef123456', pages })
    const bar = await screen.findByTestId('tab-bar')
    await app.router.navigate({ to: '/app/inventory/zzzzzz654321' as never })
    await waitFor(() => expect(tabsOf(bar).map(item => item.textContent)).toEqual(['库存详情 · #123456', '库存详情 · #654321']))
  })

  it('右键菜单：关闭其他、关闭右侧', async () => {
    const user = userEvent.setup()
    const app = mountApp({ url: '/app/orders', pages })
    const bar = await screen.findByTestId('tab-bar')
    await app.router.navigate({ to: '/app/finance' as never })
    await app.router.navigate({ to: '/app/profile' as never })
    await waitFor(() => expect(tabsOf(bar)).toHaveLength(3))
    await user.click(within(bar).getByRole('button', { name: '页签操作' }))
    await user.click(await screen.findByText('关闭其他'))
    await waitFor(() => expect(tabsOf(bar)).toHaveLength(1))
    expect(app.router.state.location.pathname).toBe('/app/profile')
  })
})

describe('收藏', () => {
  it('点星标：只提交收藏与读到的版本号；侧边出现“收藏”分组；再点取消', async () => {
    const user = userEvent.setup()
    const { handlers, puts } = prefsHandlers()
    mountApp({ url: '/app/orders', pages, handlers })
    const star = await screen.findByRole('button', { name: '加入收藏' })
    await waitFor(() => expect(star).toBeEnabled())
    await user.click(star)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ favorites: ['/app/orders'], version: 0 })
    const nav = screen.getByRole('navigation', { name: '主导航' })
    await waitFor(() => expect(within(nav).getByText('收藏')).toBeInTheDocument())
    expect(await screen.findByRole('button', { name: '取消收藏' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '取消收藏' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual({ favorites: [], version: 1 })
  })

  it('收藏里有已下线或无权限的页面：不显示也不报错', async () => {
    const { handlers } = prefsHandlers({ favorites: ['/app/orders', '/app/offline-page', '/app/audit'] })
    mountApp({ url: '/app/orders', pages, handlers, me: { ...defaultMe, permissions: ['orders.read'] } })
    const nav = await screen.findByRole('navigation', { name: '主导航' })
    await waitFor(() => expect(within(nav).getByText('收藏')).toBeInTheDocument())
    expect(within(nav).queryByText('点击页面标题旁的星标添加收藏')).toBeNull()
    expect(within(nav).queryByText('审计')).toBeNull()
  })

  it('没有收藏：侧边写明怎么添加', async () => {
    const { handlers } = prefsHandlers()
    mountApp({ url: '/app/orders', pages, handlers })
    expect(await screen.findByText('点击页面标题旁的星标添加收藏')).toBeInTheDocument()
  })

  it('读取偏好失败：不显示成“没有收藏”，星标禁用', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { '/me/preferences': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) } })
    expect(await screen.findByText('收藏暂时读不到，刷新页面重试')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加入收藏' })).toBeDisabled()
  })

  it('另一台设备刚改过（409）：重新读取后在最新内容上重算，不丢对方的收藏', async () => {
    const user = userEvent.setup()
    let conflicted = false
    const { handlers, puts } = prefsHandlers({}, body => {
      if (conflicted) return undefined
      conflicted = true
      return { status: 409, body: { error: { code: 'CONFLICT', message: '偏好已被修改，请刷新后再试', details: { currentVersion: 1, expectedVersion: body.version } } } }
    })
    mountApp({ url: '/app/orders', pages, handlers })
    const star = await screen.findByRole('button', { name: '加入收藏' })
    await waitFor(() => expect(star).toBeEnabled())
    await user.click(star)
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toMatchObject({ favorites: ['/app/orders'] })
  })

  it('收藏已满 30 个：星标禁用并说明原因', async () => {
    const full = Array.from({ length: 30 }, (_, index) => `/app/p${index}`)
    const { handlers } = prefsHandlers({ favorites: full })
    mountApp({ url: '/app/orders', pages, handlers })
    const star = await screen.findByRole('button', { name: '加入收藏' })
    await waitFor(() => expect(star).toBeDisabled())
  })

  it('详情页不显示可用的收藏星标（只能收藏列表页）', async () => {
    const { handlers } = prefsHandlers()
    mountApp({ url: '/app/inventory/abc', pages, handlers })
    const star = await screen.findByTestId('favorite-star')
    expect(star).toBeDisabled()
  })
})

describe('消息与预警', () => {
  const unread = (data: Record<string, unknown>) => ({ '/notifications/unread-count': () => ok(data) })

  it('铃铛显示消息未读与预警未读之和；预警未接入（null）时只算消息', async () => {
    mountApp({ url: '/app/orders', pages, handlers: unread({ unreadCount: 3, messages: 3, alerts: null }) })
    expect(await screen.findByRole('button', { name: '消息与预警（3 条未读）' })).toBeInTheDocument()
  })

  it('两类都有未读：相加；0 条时不带数字', async () => {
    mountApp({ url: '/app/orders', pages, handlers: unread({ unreadCount: 3, messages: 3, alerts: 4 }) })
    expect(await screen.findByRole('button', { name: '消息与预警（7 条未读）' })).toBeInTheDocument()
  })

  it('读不到未读数：不显示数字，也不假装是 0 条未读', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { '/notifications/unread-count': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂不可用' } } }) } })
    expect(await screen.findByRole('button', { name: '消息与预警' })).toBeInTheDocument()
  })

  it('每 60 秒轮询，且只在页面处于前台时轮询', async () => {
    const app = mountApp({ url: '/app/orders', pages, handlers: unread({ unreadCount: 0, messages: 0, alerts: null }) })
    await screen.findByRole('button', { name: '消息与预警' })
    await waitFor(() => expect(app.calls.some(call => call.path === '/notifications/unread-count')).toBe(true))
    const query = app.queryClient.getQueryCache().find({ queryKey: apiQueryKey('realtime', '/notifications/unread-count'), exact: false })
    const options = query?.observers[0]?.options as { refetchInterval?: unknown; refetchIntervalInBackground?: boolean } | undefined
    expect(options?.refetchInterval).toBe(UNREAD_POLL_MS)
    expect(UNREAD_POLL_MS).toBe(60_000)
    expect(options?.refetchIntervalInBackground).not.toBe(true)
  })

  it('消息中心与预警页都没上线：不显示入口，也不请求未读数', async () => {
    const app = mountApp({ url: '/app/orders', pages: { OrdersPage: pages.OrdersPage! }, handlers: unread({ unreadCount: 9, messages: 9, alerts: 9 }) })
    await screen.findByTestId('tab-bar')
    expect(screen.queryByRole('button', { name: /消息与预警/ })).toBeNull()
    expect(app.calls.filter(call => call.path === '/notifications/unread-count')).toHaveLength(0)
  })

  it('没有预警权限：铃铛只算消息未读，不把预警数加进来', async () => {
    mountApp({ url: '/app/orders', pages, me: { ...defaultMe, permissions: ['orders.read'] }, handlers: unread({ unreadCount: 2, messages: 2, alerts: 9 }) })
    expect(await screen.findByRole('button', { name: '消息与预警（2 条未读）' })).toBeInTheDocument()
  })

  it('点开才加载浮层并各取最近 5 条：消息、预警两个页签；链接只放行站内路径', async () => {
    const user = userEvent.setup()
    const app = mountApp({
      url: '/app/orders',
      pages,
      handlers: {
        ...unread({ unreadCount: 2, messages: 2, alerts: null }),
        '/notifications': () =>
          ok({
            items: [
              { id: 'n1', kind: 'ALERT', title: '库存告急', body: '', link: 'https://evil.example/phish', severity: 'CRITICAL', read: false, silenced: false, createdAt: '2026-10-20T10:00:00.000Z' },
              { id: 'n2', kind: 'SYSTEM', title: '同步完成', body: '', link: '/app/finance', severity: 'INFO', read: true, silenced: false, createdAt: '2026-10-20T09:00:00.000Z' },
            ],
          }),
        '/notifications/read': () => ok({ updated: 1 }),
        '/alerts': () =>
          ok({
            items: [
              { id: 'a1', title: '广告花费过高', severity: 'WARNING', storeName: '美国主店', lastTriggeredAt: '2026-10-20T10:00:00.000Z', read: false },
              { id: 'a2', title: '库存断货风险', severity: 'CRITICAL', storeName: null, lastTriggeredAt: '2026-10-20T09:00:00.000Z', read: true },
            ],
            counts: { open: 2 },
            note: null,
          }),
      },
    })
    const bell = await screen.findByRole('button', { name: '消息与预警（2 条未读）' })
    expect(app.calls.some(call => call.path === '/notifications' && call.method === 'GET')).toBe(false)
    await user.click(bell)
    const panel = await screen.findByTestId('notice-panel', {}, { timeout: 8000 })
    expect(await within(panel).findByText('库存告急')).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/notifications')
    expect(new URLSearchParams(call?.search).get('limit')).toBe('5')

    await user.click(within(panel).getByRole('tab', { name: /预警/ }))
    expect(await within(panel).findByText('暂时读不到预警的未读数，这里列出最近的待处理预警。')).toBeInTheDocument()
    // 预警按人已读（P6-15）：未读的有蓝点，已读的没有
    const unreadTitle = (await within(panel).findByText('广告花费过高')).closest('[data-unread]')
    expect(unreadTitle?.getAttribute('data-unread')).toBe('true')
    expect(within(unreadTitle as HTMLElement).getByLabelText('未读')).toBeInTheDocument()
    const readTitle = within(panel).getByText('库存断货风险').closest('[data-unread]')
    expect(readTitle?.getAttribute('data-unread')).toBe('false')
    expect(within(readTitle as HTMLElement).queryByLabelText('未读')).toBeNull()
    const alertCall = app.calls.find(item => item.path === '/alerts')
    expect(new URLSearchParams(alertCall?.search).get('pageSize')).toBe('5')

    // 站外链接被拦下：回到消息中心而不是跳出去
    await user.click(within(panel).getByRole('tab', { name: /消息/ }))
    await user.click(await within(panel).findByRole('button', { name: /库存告急/ }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/my/notifications'))
    expect(app.calls.some(item => item.path === '/notifications/read' && item.method === 'POST')).toBe(true)
  })

  it('浮层里读取消息失败：显示原因，不显示成“没有消息”', async () => {
    const user = userEvent.setup()
    mountApp({
      url: '/app/orders',
      pages,
      handlers: { ...unread({ unreadCount: 0, messages: 0, alerts: null }), '/notifications': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限查看消息' } } }) },
    })
    await user.click(await screen.findByRole('button', { name: '消息与预警' }))
    const panel = await screen.findByTestId('notice-panel', {}, { timeout: 8000 })
    await waitFor(() => expect(within(panel).queryByText('尚无消息记录')).toBeNull())
    expect(await within(panel).findByText('没有权限查看消息')).toBeInTheDocument()
  })
})
