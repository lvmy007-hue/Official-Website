import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeSearchParser } from '@nova/api-contracts'
import { mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 通知中心的业务域与免打扰筛选（P5-11）：免打扰期间的通知带标记且不计未读；
// 汇总通知的链接（?silenced=true&domain=…）打开后筛选直接生效；筛选条件原样传给服务端。

const T = { timeout: 30000 }
const pages: LivePages = {
  NotificationCenterPage: { load: () => import('./NotificationCenterPage'), search: ScopeSearchParser },
}
const ok = (data: unknown) => ({ body: { success: true, data } })
const base: Record<string, Handler> = { '/notifications/unread-count': () => ok({ unreadCount: 0 }) }
const notice = (patch: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'ALERT_RULE',
  title: '库存低于安全线',
  body: null,
  link: null,
  severity: 'WARNING',
  read: false,
  createdAt: '2026-10-22T08:00:00Z',
  domain: 'INVENTORY',
  silenced: false,
  ...patch,
})
const page = (items: unknown[], unreadCount = 0) => ok({ items, pageInfo: { nextCursor: null, hasMore: false }, unreadCount })

afterEach(() => vi.unstubAllGlobals())

describe('通知中心：业务域与免打扰', () => {
  it('每条显示业务域；免打扰期间的通知带标记；没有业务域的旧通知写“其他”', T, async () => {
    mountApp({
      url: '/app/my/notifications',
      pages,
      handlers: {
        ...base,
        '/notifications': () => page([notice(), notice({ id: 'n2', title: '广告超预算', domain: 'ADS', silenced: true }), notice({ id: 'n3', title: '旧预警', domain: null })], 1),
      },
    })
    const row = (await screen.findByText('广告超预算', {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('广告')).toBeInTheDocument()
    expect(within(row).getByTestId('silenced-tag')).toHaveTextContent('免打扰期间')
    expect(within(screen.getByText('库存低于安全线').closest('tr, [role=row]') as HTMLElement).queryByTestId('silenced-tag')).not.toBeInTheDocument()
    expect(within(screen.getByText('旧预警').closest('tr, [role=row]') as HTMLElement).getByText('其他')).toBeInTheDocument()
  })

  it('地址栏 ?silenced=true&domain=ADS（汇总通知的链接）：筛选直接生效并传给服务端', T, async () => {
    const queries: string[] = []
    mountApp({
      url: '/app/my/notifications?silenced=true&domain=ADS',
      pages,
      handlers: { ...base, '/notifications': url => (queries.push(url.search), page([notice({ title: '广告超预算', domain: 'ADS', silenced: true })])) },
    })
    expect(await screen.findByText('广告超预算', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(queries[0]).toContain('silenced=true')
    expect(queries[0]).toContain('domain=ADS')
    expect(queries[0]).not.toContain('unread=')
  })

  it('切换业务域与“免打扰期间”：请求带上对应参数；没有结果时说明', T, async () => {
    const queries: string[] = []
    mountApp({ url: '/app/my/notifications', pages, handlers: { ...base, '/notifications': url => (queries.push(url.search), page([])) } })
    expect(await screen.findByText('还没有通知', {}, { timeout: 15000 })).toBeInTheDocument()
    await userEvent.click(screen.getByText('免打扰期间'))
    expect(await screen.findByText('没有免打扰期间的通知')).toBeInTheDocument()
    await waitFor(() => expect(queries.some(query => query.includes('silenced=true'))).toBe(true))
    await userEvent.click(screen.getByRole('combobox', { name: '业务域' }))
    await userEvent.click(await screen.findByTitle('财务'))
    await waitFor(() => expect(queries.some(query => query.includes('domain=FINANCE') && query.includes('silenced=true'))).toBe(true))
  })

  it('有“通知偏好与免打扰设置”入口，点击进入个人账号的通知偏好', T, async () => {
    const app = mountApp({
      url: '/app/my/notifications',
      pages: { ...pages, ProfilePage: { load: async () => ({ default: () => <div>个人账号内容</div> }), search: ScopeSearchParser } },
      handlers: { ...base, '/notifications': () => page([]) },
    })
    await userEvent.click(await screen.findByText('通知偏好与免打扰设置', {}, { timeout: 15000 }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/profile'))
    expect(app.router.state.location.searchStr).toContain('tab=notify')
  })
})
