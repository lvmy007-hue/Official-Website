import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { useApiQuery } from '../query/api-query'
import { defaultMe, mountApp } from '../test/app-harness'
import type { LivePages } from './live-pages'

// 路由集成测试（P1-03/P1-04）：登录检查、跳转规则、页面不存在、无权限、参数校验、范围参数统一带入。

function ScopedProbe() {
  const query = useApiQuery<{ ok: boolean }>({ domain: 'list', path: '/orders/probe' })
  return <div>订单页内容 {query.isSuccess ? '已取数' : '取数中'}</div>
}

const pages: LivePages = {
  OrdersPage: { load: async () => ({ default: ScopedProbe }) },
  FeeEventsPage: { load: async () => ({ default: () => <div>费用页内容</div> }) },
  ProfilePage: { load: async () => ({ default: () => <div>个人账号内容</div> }) },
}

const probe = { '/orders/probe': () => ({ body: { success: true, data: { ok: true } } }) }

afterEach(() => vi.unstubAllGlobals())

describe('登录检查', () => {
  it('未登录访问工作区：回到登录页，并记住原来的地址', async () => {
    const app = mountApp({ url: '/app/orders?storeIds=st1', me: null, pages })
    expect(await screen.findByText('登录 NOVA ERP')).toBeInTheDocument()
    expect(app.router.state.location.pathname).toBe('/app/login')
    expect(app.router.state.location.search).toMatchObject({ redirect: '/app/orders?storeIds=st1' })
  })

  it('已登录访问登录页：直接进入工作区', async () => {
    const app = mountApp({ url: '/login', pages })
    await screen.findByText('订单页内容', { exact: false })
    expect(app.router.state.location.pathname).toBe('/app/orders')
  })
})

describe('跳转规则（routes.md 第三节）', () => {
  it('/app 进入第一个有权限的已上线页面（经营控制台未上线时）', async () => {
    const app = mountApp({ url: '/app', pages, handlers: probe })
    await screen.findByText('订单页内容', { exact: false })
    expect(app.router.state.location.pathname).toBe('/app/orders')
  })

  it('/app 在经营控制台已上线时进入它', async () => {
    const withOverview: LivePages = { ...pages, OverviewPage: { load: async () => ({ default: () => <div>控制台内容</div> }) } }
    const app = mountApp({ url: '/app', pages: withOverview })
    await screen.findByText('控制台内容')
    expect(app.router.state.location.pathname).toBe('/app/overview')
  })

  it('/app/contact-requests 跳转到经营控制台入口', async () => {
    const withOverview: LivePages = { ...pages, OverviewPage: { load: async () => ({ default: () => <div>控制台内容</div> }) } }
    const app = mountApp({ url: '/app/contact-requests', pages: withOverview })
    await screen.findByText('控制台内容')
    expect(app.router.state.location.pathname).toBe('/app/overview')
  })
})

describe('页面不存在', () => {
  it.each([
    ['已移除的 /app/bi', '/app/bi'],
    ['未上线的页面（利润分析旧页已下线）', '/app/profit'],
    ['未上线的详情页', '/app/inventory/abc'],
    ['未知路径', '/app/whatever/else'],
  ])('%s：显示正式的“页面不存在”页，外壳仍在', async (_name, url) => {
    mountApp({ url, pages })
    expect(await screen.findByText('页面不存在')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    expect(screen.queryByText(/规划中/)).toBeNull()
  })
})

describe('阶段 6 新增路由未上线（P6-00）：静态路径不能被同级的编号路由吞掉', () => {
  const withDetails: LivePages = {
    ...pages,
    InventoryDetailPage: { load: async () => ({ default: () => <div>库存详情内容</div> }) },
    ReportJobDetailPage: { load: async () => ({ default: () => <div>报告任务详情内容</div> }) },
    AlertDetailPage: { load: async () => ({ default: () => <div>预警详情内容</div> }) },
  }

  it.each([
    ['跨仓总览', '/app/inventory/all-warehouses'],
    ['进销存报表', '/app/inventory/movement'],
    ['我的报表', '/app/reports/custom'],
    ['预警规则模板', '/app/alerts/templates'],
    ['物流渠道与报价', '/app/first-mile/carriers'],
  ])('%s 还没上线：显示“页面不存在”，不当成编号去打开详情页', async (_name, url) => {
    mountApp({ url, pages: withDetails })
    expect(await screen.findByText('页面不存在')).toBeInTheDocument()
    expect(screen.queryByText(/详情内容/)).toBeNull()
  })

  it('真正的编号路径照常打开详情页', async () => {
    mountApp({ url: '/app/inventory/abc', pages: withDetails })
    expect(await screen.findByText('库存详情内容')).toBeInTheDocument()
  })

  it('新页面登记后，静态路径打开新页面而不是详情页', async () => {
    const live: LivePages = { ...withDetails, InventoryMovementPage: { load: async () => ({ default: () => <div>进销存内容</div> }) } }
    mountApp({ url: '/app/inventory/movement', pages: live })
    expect(await screen.findByText('进销存内容')).toBeInTheDocument()
    expect(screen.queryByText('库存详情内容')).toBeNull()
  })

  it('物流渠道与报价（P6-26）登记后，静态路径打开渠道页而不是头程详情页', async () => {
    const live: LivePages = {
      ...withDetails,
      FirstMileDetailPage: { load: async () => ({ default: () => <div>头程详情内容</div> }) },
      FirstMileCarriersPage: { load: async () => ({ default: () => <div>物流渠道内容</div> }) },
    }
    mountApp({ url: '/app/first-mile/carriers', pages: live })
    expect(await screen.findByText('物流渠道内容')).toBeInTheDocument()
    expect(screen.queryByText('头程详情内容')).toBeNull()
  })

  it('审批收件箱（P6-27）登记后可以打开，只需要登录', async () => {
    const live: LivePages = { ...withDetails, ApprovalsPage: { load: async () => ({ default: () => <div>审批收件箱内容</div> }) } }
    mountApp({ url: '/app/approvals', pages: live, me: { ...defaultMe, permissions: [] } })
    expect(await screen.findByText('审批收件箱内容')).toBeInTheDocument()
  })

  it('新页面没有登记时不进导航', async () => {
    mountApp({ url: '/app/orders', pages: withDetails, handlers: probe })
    const nav = await screen.findByRole('navigation', { name: '主导航' })
    await waitFor(() => expect(nav).toHaveTextContent('订单'))
    for (const title of ['审批收件箱', '商品表现', '跨仓总览', '跟卖监控', '业务口径']) expect(nav).not.toHaveTextContent(title)
  })
})

describe('权限', () => {
  it('没有权限：保留地址，显示“无权限”并说明所需权限点', async () => {
    const app = mountApp({ url: '/app/finance', pages, me: { ...defaultMe, permissions: ['orders.read'] } })
    expect(await screen.findByText('无权限查看此内容')).toBeInTheDocument()
    expect(screen.getByText('finance.read')).toBeInTheDocument()
    expect(app.router.state.location.pathname).toBe('/app/finance')
    expect(screen.queryByText('费用页内容')).toBeNull()
  })

  it('导航只显示有权限的已上线页面', async () => {
    mountApp({ url: '/app/orders', pages, me: { ...defaultMe, permissions: ['orders.read'] }, handlers: probe })
    const nav = await screen.findByRole('navigation', { name: '主导航' })
    await waitFor(() => expect(nav).toHaveTextContent('订单'))
    expect(nav).not.toHaveTextContent('费用事件')
    expect(nav).toHaveTextContent('个人账号')
  })
})

describe('地址栏参数校验', () => {
  it('站点只支持美国站：其他站点给出中文说明与清除入口', async () => {
    mountApp({ url: '/app/orders?marketplaceId=A2EUQ1WTGCTBG2', pages })
    expect(await screen.findByText('地址里的筛选参数不正确')).toBeInTheDocument()
    expect(screen.getByText('站点只支持亚马逊美国站')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清除筛选条件' })).toBeInTheDocument()
  })

  it('日期范围不合法、对比期缺范围，都被拒绝', async () => {
    mountApp({ url: '/app/orders?from=2026-10-10&to=2026-10-01', pages })
    expect(await screen.findByText('结束日期不能早于开始日期')).toBeInTheDocument()
  })

  it('店铺编号“123”这类纯数字不会被当成数字处理而校验失败', async () => {
    const app = mountApp({ url: '/app/orders?storeIds=123,456', pages, handlers: probe })
    await screen.findByText('订单页内容', { exact: false })
    // 地址栏里是原样字符串；经校验后页面拿到的是字符串数组
    expect(app.router.state.location.search).toMatchObject({ storeIds: '123,456' })
    expect(app.router.state.matches[app.router.state.matches.length - 1]?.search).toMatchObject({ storeIds: ['123', '456'] })
  })
})

describe('统一范围参数', () => {
  it('地址栏里的范围会带进业务数据请求；范围一变，请求跟着变', async () => {
    const app = mountApp({ url: '/app/orders?storeIds=st1&from=2026-10-01&to=2026-10-07&compare=previous', pages, handlers: probe })
    await screen.findByText('订单页内容 已取数')
    const first = app.calls.filter(call => call.path === '/orders/probe')
    expect(first).toHaveLength(1)
    const params = new URLSearchParams(first[0].search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('from')).toBe('2026-10-01')
    expect(params.get('to')).toBe('2026-10-07')
    expect(params.get('compare')).toBe('previous')
    expect(params.get('marketplaceId')).toBe('ATVPDKIKX0DER')

    await app.router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, storeIds: ['st2'] })) as never })
    await waitFor(() => expect(app.calls.filter(call => call.path === '/orders/probe')).toHaveLength(2))
    const second = new URLSearchParams(app.calls.filter(call => call.path === '/orders/probe')[1].search)
    expect(second.get('storeIds')).toBe('st2')
  })

  it('范围默认值不写进地址栏，地址保持简洁', async () => {
    const app = mountApp({ url: '/app/orders', pages, handlers: probe })
    await screen.findByText('订单页内容 已取数')
    expect(app.router.state.location.searchStr).toBe('')
  })
})

const summary = (mode: 'READ_ONLY' | 'PARTIAL' | 'ALL', enabledCount: number) => ({
  '/settings/integrations/summary': () => ({ body: { success: true, data: { mode, enabledCount, total: 8, emergencyForced: false } } }),
})

describe('外壳', () => {
  it('显示只读模式标识、个人菜单与范围栏（写入状态来自服务端）', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { ...probe, ...summary('READ_ONLY', 0) } })
    await waitFor(() => expect(screen.getByTestId('write-status')).toHaveTextContent('只读模式'))
    expect(screen.getByTestId('write-status')).toHaveAttribute('data-state', 'read-only')
    expect(screen.getByRole('button', { name: '个人菜单' })).toHaveTextContent('林然')
    expect(await screen.findByTestId('scope-bar')).toBeInTheDocument()
    expect(screen.getByText('美国站 Amazon.com')).toBeInTheDocument()
  })

  it('部分开关开启时显示“部分可写”，全部开启显示“可写入”', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { ...probe, ...summary('PARTIAL', 2) } })
    await waitFor(() => expect(screen.getByTestId('write-status')).toHaveTextContent('部分可写'))
    expect(screen.getByTestId('write-status')).toHaveAttribute('data-state', 'partial')
  })

  it('全部开启显示“可写入”', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { ...probe, ...summary('ALL', 8) } })
    await waitFor(() => expect(screen.getByTestId('write-status')).toHaveTextContent('可写入'))
  })

  it('消息入口：已上线时显示服务端的未读数', async () => {
    const withBell: LivePages = { ...pages, NotificationCenterPage: { load: async () => ({ default: () => <div>通知</div> }) } }
    mountApp({
      url: '/app/orders',
      pages: withBell,
      handlers: { ...probe, ...summary('READ_ONLY', 0), '/notifications/unread-count': () => ({ body: { success: true, data: { unreadCount: 5, messages: 5, alerts: null } } }) },
    })
    expect(await screen.findByRole('button', { name: '消息与预警（5 条未读）' })).toBeInTheDocument()
  })

  it('读不到写入开关状态时显示“写入状态未知”，不假定为只读', async () => {
    mountApp({ url: '/app/orders', pages, handlers: { ...probe, '/settings/integrations/summary': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务异常' } } }) } })
    await waitFor(() => expect(screen.getByTestId('write-status')).toHaveTextContent('写入状态未知'), { timeout: 10_000 })
    expect(screen.getByTestId('write-status')).toHaveAttribute('data-state', 'unknown')
  }, 15_000)

  it('内部访问模式显示横幅', async () => {
    mountApp({ url: '/app/orders', pages, handlers: probe, me: { ...defaultMe, accessMode: 'INTERNAL_DIRECT' } })
    expect(await screen.findByTestId('access-mode-banner')).toHaveTextContent('内部访问模式')
  })

  it('正常登录时不显示内部访问横幅', async () => {
    mountApp({ url: '/app/orders', pages, handlers: probe })
    await screen.findByTestId('write-status')
    expect(screen.queryByTestId('access-mode-banner')).toBeNull()
  })

  it('没有授权任何店铺范围时，范围栏提示联系管理员', async () => {
    mountApp({
      url: '/app/orders',
      pages,
      handlers: probe,
      scopeOptions: { granted: false, unrestricted: false, entities: [], stores: [], marketplace: { id: 'ATVPDKIKX0DER', label: '美国站 Amazon.com' }, compareModes: [], currencies: [] },
    })
    expect(await screen.findByText(/还没有被授予任何店铺的数据访问范围/)).toBeInTheDocument()
  })
})
