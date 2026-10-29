import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { emptyViewConfig, type GridViewConfig, type GridViewItem } from '@nova/api-contracts'
import { renderWithApp } from '../../test/render'
import { textColumn } from './columns'
import { PagedGrid, type PagedGridProps } from './PagedGrid'
import type { ViewFilterBinding } from './grid-view-layout'
import type { PageFetcher } from './grid-types'

// 筛选方案（P6-04）：与视图共用 /grid-views，kind=FILTER；套用时认不出的条件忽略并提示、另存为只存筛选、共享开关随权限、删除、读取失败降级。

type Row = { id: string; name: string }
const columns = [textColumn<Row>('名称', 'name')]
const emptyState = { kind: 'empty' as const, domain: '本页展示商品', prerequisite: '先授权店铺并同步' }
const GRID = 'schemes-test'

const scheme = (over: Partial<Omit<GridViewItem, 'config'>> & { filters?: GridViewConfig['filters'] } = {}): GridViewItem => {
  const { filters, ...rest } = over
  return {
    id: 's1',
    gridId: GRID,
    kind: 'FILTER',
    scope: 'USER',
    name: '只看启用中',
    config: { ...emptyViewConfig(), filters: filters ?? { state: 'ENABLED' } },
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
function install(options: { items?: GridViewItem[]; canShare?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost')
      const call: Call = { method: (init.method ?? 'GET').toUpperCase(), path: url.pathname.replace(/^\/api\/v1/, ''), search: url.search, body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(status < 400 ? { success: true, data: body } : body), { status, headers: { 'content-type': 'application/json' } })
      if (call.path === '/grid-views' && call.method === 'GET') {
        if (options.fail) return reply(500, { error: { code: 'INTERNAL', message: '服务暂时不可用' } })
        return reply(200, { items: options.items ?? [], canShare: options.canShare ?? false, limits: { user: 20, team: 30 } })
      }
      if (call.path === '/grid-views' && call.method === 'POST') return reply(201, scheme({ id: 'new-1', name: call.body!.name, scope: call.body!.scope, filters: call.body!.config.filters }))
      if (/^\/grid-views\/[^/]+$/.test(call.path) && call.method === 'DELETE') return reply(200, { id: call.path.split('/').pop() })
      return reply(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } })
    }),
  )
  return calls
}

const fetchPage: PageFetcher<Row> = async () => ({ items: [{ id: 'r1', name: '商品甲' }], total: 1 })
function mount(binding: ViewFilterBinding, over: Partial<PagedGridProps<Row>> = {}) {
  return renderWithApp(<PagedGrid gridId={GRID} columns={columns} fetchPage={fetchPage} getRowId={row => row.id} resetKey="k1" emptyState={emptyState} serverViews viewFilters={binding} {...over} />)
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('筛选方案', () => {
  it('只读取 kind=FILTER 的方案；套用时把方案里的筛选交给页面，认不出的条件提示条数', async () => {
    const calls = install({ items: [scheme()] })
    const apply = vi.fn(() => 2)
    mount({ value: {}, dimension: null, apply })
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    const listCall = calls.find(call => call.method === 'GET' && call.path === '/grid-views' && call.search.includes('kind=FILTER'))
    expect(listCall?.search).toContain(`gridId=${GRID}`)
    await waitFor(() => expect(screen.getByRole('button', { name: '筛选方案' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '筛选方案' }))
    await userEvent.click(await screen.findByText('只看启用中'))
    expect(apply).toHaveBeenCalledWith({ state: 'ENABLED' }, null)
    expect(await screen.findByText(/2 个条件/)).toBeInTheDocument()
  })

  it('没有筛选条件时不能存为方案；有条件时只存筛选（不含列设置），个人方案、不设默认', async () => {
    const calls = install()
    const { unmount } = mount({ value: {}, dimension: null, apply: () => 0 })
    await screen.findByText('商品甲')
    expect(screen.getByRole('button', { name: '存为筛选方案' })).toBeDisabled()
    unmount()

    mount({ value: { state: 'PAUSED', q: '春季' }, dimension: null, apply: () => 0 })
    await screen.findByText('商品甲')
    await userEvent.click(screen.getByRole('button', { name: '存为筛选方案' }))
    await userEvent.type(await screen.findByRole('textbox', { name: '方案名称' }), '暂停的春季活动')
    expect(screen.queryByRole('switch', { name: '筛选方案共享给团队' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^保存方案$/ }))
    await waitFor(() => expect(calls.some(call => call.method === 'POST')).toBe(true))
    const post = calls.find(call => call.method === 'POST')!
    expect(post.body).toMatchObject({ gridId: GRID, kind: 'FILTER', name: '暂停的春季活动', scope: 'USER', isDefault: false })
    expect(post.body!.config).toEqual({ ...emptyViewConfig(), filters: { state: 'PAUSED', q: '春季' }, dimension: null })
  })

  it('有共享权限时出现共享开关，打开后存为团队方案', async () => {
    const calls = install({ canShare: true })
    mount({ value: { state: 'PAUSED' }, dimension: null, apply: () => 0 })
    await screen.findByText('商品甲')
    await waitFor(() => expect(screen.getByRole('button', { name: '存为筛选方案' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '存为筛选方案' }))
    await userEvent.type(await screen.findByRole('textbox', { name: '方案名称' }), '团队共用')
    await userEvent.click(await screen.findByRole('switch', { name: '筛选方案共享给团队' }))
    await userEvent.click(screen.getByRole('button', { name: /^保存方案$/ }))
    await waitFor(() => expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ kind: 'FILTER', scope: 'TEAM' }))
  })

  it('删除自己的方案：确认后调用删除接口', async () => {
    const calls = install({ items: [scheme()] })
    mount({ value: {}, dimension: null, apply: () => 0 })
    await screen.findByText('商品甲')
    await waitFor(() => expect(screen.getByRole('button', { name: '筛选方案' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '筛选方案' }))
    await userEvent.click(await screen.findByRole('button', { name: '删除筛选方案：只看启用中' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /^删\s?除$/ }))
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE' && call.path === '/grid-views/s1')).toBe(true))
  })

  it('读取失败：写明方案暂时不可用并给重试，表格本身不受影响', async () => {
    install({ fail: true })
    mount({ value: {}, dimension: null, apply: () => 0 })
    expect(await screen.findByText('商品甲')).toBeInTheDocument()
    expect(await screen.findByText('筛选方案暂时不可用', undefined, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /重\s?试/ }).length).toBeGreaterThan(0)
  }, 30_000)

  it('页面没有传筛选绑定时，不出现筛选方案入口', async () => {
    install()
    renderWithApp(<PagedGrid gridId={GRID} columns={columns} fetchPage={fetchPage} getRowId={row => row.id} resetKey="k1" emptyState={emptyState} serverViews />)
    await screen.findByText('商品甲')
    expect(screen.queryByRole('button', { name: '筛选方案' })).toBeNull()
  })
})
