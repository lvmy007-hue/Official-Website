import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MIGRATED_VIEW_NAME, emptyViewConfig, type GridViewConfig, type GridViewItem } from '@nova/api-contracts'
import { defaultMe } from '../../test/app-harness'
import { renderWithApp } from '../../test/render'
import { numberColumn, textColumn } from './columns'
import { PagedGrid, type PagedGridProps } from './PagedGrid'
import type { PageFetcher } from './grid-types'

// 表格服务端视图（P6-03，前端）：默认视图套用（隐藏列、排序）、另存为 / 保存修改 / 设为默认 / 删除、共享开关随权限、
// 本机旧列配置迁移、已失效条件提示、读取失败降级、内部访问不启用、列头问号只读字典。用假的服务端替代接口。

type Row = { id: string; name: string; units: number; sales: number }
const rows: Row[] = [{ id: 'r1', name: '商品甲', units: 3, sales: 30 }]
const columns = [{ ...textColumn<Row>('名称', 'name'), pin: 'left' as const }, { ...numberColumn<Row>('件数', 'units'), metric: 'M-206' }, numberColumn<Row>('销售额', 'sales')]
const emptyState = { kind: 'empty' as const, domain: '本页展示库存', prerequisite: '先授权店铺并同步库存' }
const GRID = 'views-test'
const HIDDEN_KEY = `erp.grid.${GRID}.hidden-columns`

const view = (over: Partial<Omit<GridViewItem, 'config'>> & { config?: Partial<GridViewConfig> } = {}): GridViewItem => {
  const { config, ...rest } = over
  return {
    id: 'v1',
    gridId: GRID,
    kind: 'VIEW',
    scope: 'USER',
    name: '我的精简',
    config: { ...emptyViewConfig(), ...config },
    isDefault: false,
    version: 1,
    mine: true,
    canEdit: true,
    owner: { id: 'u1', name: '林然' },
    updatedAt: '2026-10-26T08:00:00.000Z',
    ...rest,
  }
}

type Call = { method: string; path: string; search: string; body?: Record<string, any> }
type Server = { views: GridViewItem[]; canShare: boolean; listStatus: number; calls: Call[]; override: (call: Call) => { status: number; body: unknown } | null }
const newServer = (views: GridViewItem[] = [], over: Partial<Server> = {}): Server => ({ views, canShare: false, listStatus: 200, calls: [], override: () => null, ...over })

const definition = {
  id: 'M-206',
  name: '我方可售天数',
  type: '我方计算',
  group: '库存',
  definition: '可售数量 ÷ 预测日销（中）',
  source: '库存快照与订单',
  refresh: '每日',
  version: 1,
  pages: ['库存健康'],
  reconcileWith: [{ label: '补货建议', route: '/app/replenishment' }],
  mismatchReasons: ['预测日销按近 30 天日均，剔除已知断货日'],
  configurableAt: { label: '库存规则', route: '/app/inventory' },
  history: [],
}

function install(server: Server) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost')
      const call: Call = { method: (init.method ?? 'GET').toUpperCase(), path: url.pathname.replace(/^\/api\/v1/, ''), search: url.search, body: init.body ? JSON.parse(String(init.body)) : undefined }
      server.calls.push(call)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(status < 400 ? { success: true, data: body } : body), { status, headers: { 'content-type': 'application/json' } })
      const custom = server.override(call)
      if (custom) return reply(custom.status, custom.body)
      if (call.path === '/metrics/definitions') return reply(200, { items: [definition], total: 1, page: 1, pageSize: 50, groups: [], types: [] })
      if (call.path === '/grid-views' && call.method === 'GET') {
        if (server.listStatus !== 200) return reply(server.listStatus, { error: { code: 'NOT_FOUND', message: '接口不存在' } })
        return reply(200, { items: server.views, canShare: server.canShare, limits: { user: 20, team: 30 } })
      }
      if (call.path === '/grid-views' && call.method === 'POST') {
        const created = view({ id: `new-${server.views.length + 1}`, name: call.body!.name, scope: call.body!.scope ?? 'USER', isDefault: call.body!.isDefault, config: call.body!.config })
        return reply(201, created)
      }
      const match = /^\/grid-views\/([^/]+)(\/default)?$/.exec(call.path)
      const found = server.views.find(item => item.id === match?.[1])
      if (match && found && call.method === 'PUT') return reply(200, { ...found, config: call.body!.config ?? found.config, version: found.version + 1 })
      if (match && found && call.method === 'DELETE') return reply(200, { id: found.id })
      if (match && found && call.method === 'POST') return reply(200, { ...found, isDefault: true })
      return reply(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } })
    }),
  )
}

const fetchPage = () => vi.fn<PageFetcher<Row>>(async () => ({ items: rows, total: 1 }))
function gridProps(fetch: PageFetcher<Row>, over: Partial<PagedGridProps<Row>> = {}): PagedGridProps<Row> {
  return { gridId: GRID, columns, fetchPage: fetch, getRowId: row => row.id, resetKey: 'k1', emptyState, sortableFields: { units: 'units' }, serverViews: true, ...over }
}
const mount = (server: Server, over: Partial<PagedGridProps<Row>> = {}, me = defaultMe) => {
  install(server)
  const fetch = fetchPage()
  return { fetch, ...renderWithApp(<PagedGrid {...gridProps(fetch, over)} />, { me }) }
}
const posts = (server: Server) => server.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/grid-views'))

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('套用默认视图', () => {
  it('没有视图：用页面默认列，按钮显示“页面默认”，请求带表格标识', async () => {
    const server = newServer()
    const { fetch } = mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /视图：页面默认/ })).toBeInTheDocument()
    expect(server.calls.find(call => call.path === '/grid-views')?.search).toBe(`?gridId=${GRID}`)
    expect(fetch.mock.calls[0]![0]).toMatchObject({ page: 1, sort: null })
    expect(screen.getByText('销售额')).toBeInTheDocument()
  })

  it('我的默认视图：隐藏列与排序在第一次取数前就套好（不白取一次）', async () => {
    const server = newServer([view({ isDefault: true, config: { hidden: ['sales'], sort: { field: 'units', direction: 'desc' } } })])
    const { fetch } = mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /视图：我的精简/ })).toBeInTheDocument()
    expect(screen.queryByText('销售额')).toBeNull()
    // 带问号的列头自己画列名和排序箭头：按视图里的排序显示“↓”
    expect(screen.getByRole('button', { name: '件数 ↓' })).toBeInTheDocument()
    expect(fetch.mock.calls[0]![0]).toMatchObject({ sort: { field: 'units', direction: 'desc' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('有未保存的修改')).toBeNull()
  })

  it('三级回落：我的默认优先于团队默认；换成别的视图再选“页面默认”回到页面自带的列', async () => {
    const server = newServer([
      view({ id: 'team', scope: 'TEAM', mine: false, name: '团队精简', isDefault: true, config: { hidden: ['units'] } }),
      view({ id: 'mine', name: '我的精简', isDefault: true, config: { hidden: ['sales'] } }),
    ])
    mount(server)
    await screen.findByText('商品甲')
    expect(screen.getByRole('button', { name: /视图：我的精简/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /视图：/ }))
    await userEvent.click(await screen.findByText('页面默认'))
    expect(await screen.findByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('件数')).toBeInTheDocument()
  })
})

describe('另存为、保存修改、设为默认、删除', () => {
  it('隐藏一列后提示“有未保存的修改”；另存为带上列显示，保存后切到新视图、提示消失', async () => {
    const server = newServer()
    mount(server)
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '销售额' }))
    expect(await screen.findByText('有未保存的修改')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /另存为/ }))
    const save = await screen.findByRole('button', { name: /^保\s*存$/ })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('视图名称'), '只看件数')
    expect(screen.queryByLabelText('共享给团队')).toBeNull()
    await userEvent.click(save)
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]).toMatchObject({
      method: 'POST',
      path: '/grid-views',
      body: { gridId: GRID, name: '只看件数', scope: 'USER', isDefault: false, config: { hidden: ['sales'], sort: null } },
    })
    expect(await screen.findByRole('button', { name: /视图：只看件数/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('有未保存的修改')).toBeNull())
  })

  it('有共享权限才显示“共享给团队”；打开后保存的是团队视图，可同时设为团队默认', async () => {
    const server = newServer([], { canShare: true })
    mount(server)
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: /另存为/ }))
    await userEvent.type(await screen.findByLabelText('视图名称'), '团队口径')
    await userEvent.click(screen.getByLabelText('共享给团队'))
    await userEvent.click(screen.getByRole('checkbox', { name: /设为团队默认视图/ }))
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]!.body).toMatchObject({ name: '团队口径', scope: 'TEAM', isDefault: true })
  })

  it('保存修改：带上当前版本与新的列显示；服务端说版本过期（409）时提示原因并重新读取', async () => {
    const server = newServer([view({ isDefault: true, config: { hidden: ['sales'] } })])
    mount(server)
    await screen.findByText('商品甲')
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '件数' }))
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]).toMatchObject({ method: 'PUT', path: '/grid-views/v1', body: { version: 1, config: { hidden: ['sales', 'units'] } } })
    await waitFor(() => expect(screen.queryByText('有未保存的修改')).toBeNull())
    // 再改一次，这次服务端说别人刚改过
    server.override = call => (call.method === 'PUT' ? { status: 409, body: { error: { code: 'CONFLICT', message: '视图已被他人修改，请刷新后查看最新内容', details: { currentVersion: 3 } } } } : null)
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '件数' }))
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(await screen.findByText(/已被他人修改/)).toBeInTheDocument()
    await waitFor(() => expect(server.calls.filter(call => call.method === 'GET' && call.path === '/grid-views').length).toBeGreaterThan(1))
  })

  it('设为默认与删除：调用对应接口；删除前要确认，删掉正在用的视图回到页面默认', async () => {
    const server = newServer([view({ isDefault: false, config: { hidden: ['sales'] } })])
    mount(server)
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: /视图：/ }))
    await userEvent.click(await screen.findByText('我的精简'))
    expect(await screen.findByRole('button', { name: /视图：我的精简/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '管理当前视图' }))
    await userEvent.click(await screen.findByText('设为默认视图'))
    await waitFor(() => expect(posts(server).map(call => `${call.method} ${call.path}`)).toEqual(['POST /grid-views/v1/default']))
    await userEvent.click(screen.getByRole('button', { name: '管理当前视图' }))
    await userEvent.click(await screen.findByText('删除视图'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText(/删除视图“我的精简”/).length).toBeGreaterThan(0)
    expect(posts(server)).toHaveLength(1)
    await userEvent.click(within(dialog).getByRole('button', { name: /删\s*除/ }))
    await waitFor(() => expect(posts(server).map(call => call.method)).toEqual(['POST', 'DELETE']))
    expect(await screen.findByRole('button', { name: /视图：页面默认/ })).toBeInTheDocument()
  })

  it('系统视图只读、没有共享权限的团队视图不能改：保存修改与管理置灰', async () => {
    const server = newServer([
      view({ id: 'sys', scope: 'SYSTEM', mine: false, canEdit: false, name: '系统精简', owner: null }),
      view({ id: 'team', scope: 'TEAM', mine: false, canEdit: false, name: '团队口径' }),
    ])
    mount(server)
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: /视图：/ }))
    await userEvent.click(await screen.findByText('系统精简'))
    expect(await screen.findByRole('button', { name: /视图：系统精简/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '销售额' }))
    expect(await screen.findByText('有未保存的修改')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /^另存为$/ }))
    expect(await screen.findByLabelText('视图名称')).toBeInTheDocument()
    expect(posts(server)).toHaveLength(0)
  })
})

describe('本机旧列配置、失效条件与降级', () => {
  it('第一次加载把本机隐藏列迁成“我的默认视图”，成功后删掉本机副本，列显示不变', async () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(['sales']))
    const server = newServer()
    mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(screen.queryByText('销售额')).toBeNull()
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]).toMatchObject({ method: 'POST', body: { gridId: GRID, name: MIGRATED_VIEW_NAME, scope: 'USER', isDefault: true, config: { hidden: ['sales'] } } })
    await waitFor(() => expect(window.localStorage.getItem(HIDDEN_KEY)).toBeNull())
    expect(await screen.findByRole('button', { name: new RegExp(`视图：${MIGRATED_VIEW_NAME}`) })).toBeInTheDocument()
    expect(screen.queryByText('销售额')).toBeNull()
  })

  it('已有个人默认视图：旧配置迁成不默认的同名视图，不抢默认；已迁过就只删本机副本', async () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(['units']))
    const server = newServer([view({ isDefault: true })])
    mount(server)
    await screen.findByText('商品甲')
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]!.body).toMatchObject({ name: MIGRATED_VIEW_NAME, isDefault: false })
    await waitFor(() => expect(window.localStorage.getItem(HIDDEN_KEY)).toBeNull())
  })

  it('迁移失败：保留本机副本，列显示仍按它，不出现错误弹窗之外的白屏', async () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(['sales']))
    const server = newServer([], { override: call => (call.method === 'POST' ? { status: 500, body: { error: { code: 'INTERNAL', message: '服务出错' } } } : null) })
    mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(window.localStorage.getItem(HIDDEN_KEY)).not.toBeNull()
    expect(screen.queryByText('销售额')).toBeNull()
  })

  it('视图里引用了已不存在的列与排序：忽略并提示“有 N 个条件已失效”，不报错', async () => {
    const server = newServer([view({ isDefault: true, config: { hidden: ['sales', 'gone'], order: ['gone2'], sort: { field: 'removed', direction: 'asc' } } })])
    const { fetch } = mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(screen.getByText('有 3 个条件已失效，已忽略')).toBeInTheDocument()
    expect(screen.queryByText('销售额')).toBeNull()
    expect(fetch.mock.calls[0]![0].sort).toBeNull()
    // 失效项被丢弃，不算“未保存的修改”
    expect(screen.queryByText('有未保存的修改')).toBeNull()
  })

  it('筛选与维度由页面还原：套用视图时交给页面，页面报告忽略了几个就计入失效提示', async () => {
    const apply = vi.fn(() => 2)
    const server = newServer([view({ isDefault: true, config: { filters: { tab: 'low', shop: 'deleted-shop' }, dimension: 'asin' } })])
    mount(server, { viewFilters: { value: { tab: 'low', shop: 'deleted-shop' }, dimension: 'asin', apply } })
    await screen.findByText('商品甲')
    expect(apply).toHaveBeenCalledWith({ tab: 'low', shop: 'deleted-shop' }, 'asin')
    expect(await screen.findByText('有 2 个条件已失效，已忽略')).toBeInTheDocument()
  })

  it('页面当前的筛选和视图里的不同，算“未保存的修改”，另存为时一起保存', async () => {
    const server = newServer()
    mount(server, { viewFilters: { value: { tab: 'low' }, dimension: 'sku', apply: () => 0 } })
    await screen.findByText('商品甲')
    expect(await screen.findByText('有未保存的修改')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /另存为/ }))
    await userEvent.type(await screen.findByLabelText('视图名称'), '低库存')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]!.body!.config).toMatchObject({ filters: { tab: 'low' }, dimension: 'sku' })
  })

  it('视图读取失败：表格照常用页面默认列显示，提示“视图暂时不可用”并可重试', async () => {
    const server = newServer([], { listStatus: 500 })
    const { fetch } = mount(server)
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalled()
    expect(screen.getByText(/视图暂时不可用/)).toBeInTheDocument()
    server.listStatus = 200
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByRole('button', { name: /视图：页面默认/ })).toBeInTheDocument()
  })

  it('内部访问与支持访问没有个人账号：不请求视图、不显示视图入口，列配置沿用本机', async () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(['sales']))
    const server = newServer([view({ isDefault: true, config: { hidden: ['units'] } })])
    mount(server, {}, { ...defaultMe, accessMode: 'SUPPORT' })
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(server.calls.some(call => call.path === '/grid-views')).toBe(false)
    expect(screen.queryByRole('button', { name: /另存为/ })).toBeNull()
    expect(screen.queryByText('销售额')).toBeNull()
    expect(screen.getByText('件数')).toBeInTheDocument()
    expect(window.localStorage.getItem(HIDDEN_KEY)).not.toBeNull()
  })
})

describe('列头问号（只读指标字典）', () => {
  it('点开之前不请求字典；点开后依次显示定义、来源、刷新频率、口径版本与三个链接', async () => {
    const server = newServer()
    mount(server)
    await screen.findByText('商品甲')
    expect(server.calls.some(call => call.path === '/metrics/definitions')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '件数的口径说明' }))
    const help = await screen.findByTestId('metric-help')
    expect(within(help).getByText('我方可售天数')).toBeInTheDocument()
    for (const text of ['可售数量 ÷ 预测日销（中）', '库存快照与订单', '每日', '第 1 版', '预测日销按近 30 天日均，剔除已知断货日']) expect(within(help).getByText(text)).toBeInTheDocument()
    expect(within(help).getByRole('link', { name: '补货建议' })).toHaveAttribute('href', '/app/replenishment')
    expect(within(help).getByRole('link', { name: '库存规则' })).toHaveAttribute('href', '/app/inventory')
    const request = server.calls.filter(call => call.path === '/metrics/definitions')
    expect(request).toHaveLength(1)
    expect(request[0]!.search).toContain('ids=M-206')
  })

  it('字典读取失败：问号里写明并可重试，不显示任何写死的口径', async () => {
    const server = newServer([], { override: call => (call.path === '/metrics/definitions' ? { status: 500, body: { error: { code: 'INTERNAL', message: '服务出错' } } } : null) })
    mount(server)
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: '件数的口径说明' }))
    expect(await screen.findByText(/口径暂时读取失败/)).toBeInTheDocument()
    expect(screen.queryByTestId('metric-help')).toBeNull()
  })

  it('没有 metric 的列没有问号；带问号的列照样能点列名排序', async () => {
    const server = newServer()
    const { fetch } = mount(server)
    await screen.findByText('商品甲')
    expect(screen.queryByRole('button', { name: '销售额的口径说明' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '件数' }))
    await waitFor(() => expect(fetch.mock.calls[fetch.mock.calls.length - 1]![0].sort).toEqual({ field: 'units', direction: 'asc' }))
  })
})
