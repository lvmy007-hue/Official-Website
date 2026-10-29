import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp } from '../test/app-harness'
import type { LivePages } from '../routes/live-pages'
import { registerObjectSearcher } from './object-search'
import { buildCrumbs } from './Breadcrumbs'
import { filterPages } from './CommandPalette'
import { selectedNavPath } from './SideNav'

const pages: LivePages = {
  OrdersPage: { load: async () => ({ default: () => <div>订单页</div> }) },
  FeeEventsPage: { load: async () => ({ default: () => <div>费用页</div> }) },
  InventoryHealthPage: { load: async () => ({ default: () => <div>库存页</div> }) },
  InventoryDetailPage: { load: async () => ({ default: () => <div>库存详情页</div> }) },
}

afterEach(() => vi.unstubAllGlobals())

describe('导航高亮', () => {
  it('详情页高亮它的列表页；取最长前缀', () => {
    const paths = ['/app/inventory', '/app/inventory/ledger', '/app/orders']
    expect(selectedNavPath('/app/inventory/abc', paths)).toBe('/app/inventory')
    expect(selectedNavPath('/app/inventory/ledger', paths)).toBe('/app/inventory/ledger')
    expect(selectedNavPath('/app/orders', paths)).toBe('/app/orders')
    expect(selectedNavPath('/app/other', paths)).toBeUndefined()
  })
})

describe('面包屑', () => {
  const live = (component: string) => component in pages
  it('列表页：分组 › 页面', () => {
    expect(buildCrumbs('/app/orders', live)).toEqual([{ label: '订单与售后' }, { label: '订单' }])
  })
  it('详情页：分组 › 已上线的列表页（可点击）› 当前页', () => {
    expect(buildCrumbs('/app/inventory/abc', live)).toEqual([{ label: '库存与补货' }, { label: '库存健康', to: '/app/inventory' }, { label: '库存详情' }])
  })
  it('列表页未上线时，面包屑不放无法打开的链接', () => {
    expect(buildCrumbs('/app/inventory/abc', () => false)).toEqual([{ label: '库存与补货' }, { label: '库存详情' }])
  })
  it('不在清单里的地址没有面包屑', () => {
    expect(buildCrumbs('/app/nowhere', live)).toEqual([])
  })
})

describe('命令面板', () => {
  it('页面筛选：标题或分组名包含关键词即命中，不区分大小写', () => {
    const entries = [
      { key: '1', group: '库存', title: '库存健康', to: '/app/inventory' },
      { key: '2', group: '财务', title: '费用事件', to: '/app/finance' },
    ]
    expect(filterPages(entries, '库存').map(item => item.key)).toEqual(['1'])
    expect(filterPages(entries, '财务').map(item => item.key)).toEqual(['2'])
    expect(filterPages(entries, '  ').map(item => item.key)).toEqual(['1', '2'])
    expect(filterPages(entries, '没有').length).toBe(0)
  })

  it('Ctrl+K 唤起，输入后回车跳转，并保持当前范围参数', async () => {
    const app = mountApp({ url: '/app/orders?storeIds=st1', pages })
    await screen.findByText('订单页')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText('命令面板搜索')
    await userEvent.type(input, '库存')
    expect(await screen.findByRole('option', { name: /库存健康/ })).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/inventory'))
    expect(app.router.state.location.search).toMatchObject({ storeIds: 'st1' })
    await screen.findByText('库存页')
  })

  it('没有匹配项时给出提示；没有权限的页面搜不到', async () => {
    mountApp({ url: '/app/orders', pages, me: { ...defaultMe, permissions: ['orders.read'] } })
    await screen.findByText('订单页')
    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    const input = await screen.findByLabelText('命令面板搜索')
    await userEvent.type(input, '费用')
    expect(await screen.findByText('没有匹配的页面或对象')).toBeInTheDocument()
  })

  it('对象搜索：已登记的业务模块可以搜到对象并跳转', async () => {
    const dispose = registerObjectSearcher({ kind: '订单', search: async query => [{ id: 'o1', title: `订单 ${query}`, subtitle: '2026-10-20', to: '/app/orders' }] })
    try {
      const app = mountApp({ url: '/app/finance', pages })
      await screen.findByText('费用页')
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
      await userEvent.type(await screen.findByLabelText('命令面板搜索'), '112-0001')
      const hit = await screen.findByRole('option', { name: /订单 112-0001/ }, { timeout: 2000 })
      await userEvent.click(hit)
      await waitFor(() => expect(app.router.state.location.pathname).toBe('/app/orders'))
    } finally {
      dispose()
    }
  })
})

describe('范围栏', () => {
  it('选择店铺后地址栏同步，且只有该主体下的店铺可选', async () => {
    const app = mountApp({ url: '/app/orders?legalEntityIds=le1', pages })
    await screen.findByText('订单页')
    const scope = await screen.findByTestId('scope-bar')
    const storeSelect = within(scope).getByRole('combobox', { name: '店铺' })
    await userEvent.click(storeSelect)
    expect(await screen.findByText('Northstar US')).toBeInTheDocument()
    // 主体 le1 之外的店铺不在选项里
    expect(screen.queryByText('Oak & Pine')).toBeNull()
    await userEvent.click(screen.getByText('Northstar US'))
    await waitFor(() => expect(app.router.state.location.search).toMatchObject({ storeIds: 'st1' }))
  })

  it('选择对比期：自动补全时间范围，地址栏同步', async () => {
    const app = mountApp({ url: '/app/orders', pages })
    await screen.findByText('订单页')
    const scope = await screen.findByTestId('scope-bar')
    await userEvent.click(within(scope).getByRole('combobox', { name: '对比期' }))
    await userEvent.click(await screen.findByText('去年同期'))
    await waitFor(() => expect(app.router.state.location.search).toMatchObject({ compare: 'yoy' }))
    expect(app.router.state.location.search).toHaveProperty('from')
  })

  it('币种口径切到原币后写入地址栏；切回美元则不写（默认值）', async () => {
    const app = mountApp({ url: '/app/orders', pages })
    await screen.findByText('订单页')
    const scope = await screen.findByTestId('scope-bar')
    await userEvent.click(within(scope).getByText('原币'))
    await waitFor(() => expect(app.router.state.location.search).toMatchObject({ displayCurrency: 'ORIGINAL' }))
    await userEvent.click(within(scope).getByText('美元'))
    await waitFor(() => expect(app.router.state.location.searchStr).toBe(''))
  })

  it('站点固定为美国站，没有可切换的站点选项', async () => {
    mountApp({ url: '/app/orders', pages })
    const scope = await screen.findByTestId('scope-bar')
    expect(within(scope).getByText('美国站 Amazon.com')).toBeInTheDocument()
    expect(within(scope).queryByLabelText('站点')).toBeNull()
  })
})
