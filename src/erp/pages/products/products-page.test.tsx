import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { emptyList, listHandlers, listResponse, noSalesRow, ok, productRow } from './products-fixtures.test-helper'

// 商品主数据（P4-07）：假服务端返回固定数据，验证列的真实数字与“尚无记录 / 无权限 / 尚未接入”（不写 0）、筛选与排序随请求带出、
// 批量动作（设置标签与负责人、同步商品目录、导出、关注）的权限与请求体、空状态与读取失败。

const pages: LivePages = { ProductsPage: { load: () => import('./ProductsPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/products'
const withPermissions = (permissions: string[]) => ({ ...defaultMe, permissions })
const open = async (response = listResponse, extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url, pages, me, handlers: { ...listHandlers(response), ...extra } })
  const page = within(await screen.findByTestId('products-page'))
  await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
  return { app, page }
}

describe('商品主数据：列表', () => {
  it('有数据：标题链到 ASIN 360，销售、利润率、可售库存、标签、负责人都显示；同 ASIN 的销售标“共用”', async () => {
    const { page } = await open()
    const first = page.getByText('玻璃保鲜盒套装').closest('tr, [role=row]') as HTMLElement
    expect(within(first).getByRole('link', { name: '玻璃保鲜盒套装' })).toHaveAttribute('href', '/app/products/p1')
    expect(first).toHaveTextContent('B0TEST0001 · SKU-1')
    expect(first).toHaveTextContent('$580.00')
    expect(first).toHaveTextContent('共用')
    expect(first).toHaveTextContent('290')
    expect(first).toHaveTextContent('25.0%')
    expect(first).toHaveTextContent('100')
    expect(first).toHaveTextContent('热销')
    expect(first).toHaveTextContent('林然')
    expect(first).toHaveTextContent('在售')
    expect(first).toHaveTextContent('亚马逊物流 FBA')
  })

  it('没有记录的列写“尚无记录”或原因，不写 0；刊登问题数与质量分写“尚未接入”', async () => {
    const { page } = await open()
    const row = page.getByText('没有销售的商品').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
    expect(row).toHaveTextContent('缺成本')
    expect(row).toHaveTextContent('目录未同步')
    expect(row).toHaveTextContent('未指定')
    expect(row).not.toHaveTextContent('$0.00')
    expect(within(row).getAllByText('尚未接入')).toHaveLength(2)
  })

  it('没有库存与利润权限：对应列写“无权限”，并说明原因', async () => {
    const restricted = () =>
      listResponse({
        stock: { state: 'RESTRICTED', note: '需要“库存”读取权限才能查看可售数量与库存风险' },
        profit: { state: 'RESTRICTED', note: '需要“利润”读取与“利润字段”权限才能查看利润率' },
        items: [productRow({ sellable: null, margin30: undefined, marginState: undefined })],
        canWrite: false,
        members: [],
      })
    const { page } = await open(restricted)
    const row = page.getByText('玻璃保鲜盒套装').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('无权限')).toHaveLength(2)
    expect(page.getByText(/需要“库存”读取权限/)).toBeInTheDocument()
    expect(page.getByText(/需要“利润”读取与“利润字段”权限/)).toBeInTheDocument()
  })

  it('筛选与排序随请求带出，并回到第一页', async () => {
    const { app, page } = await open()
    const first = app.calls.find(call => call.path === '/products')!
    expect(new URLSearchParams(first.search).get('sort')).toBe('updatedAt:desc')
    fireEvent.click(page.getByRole('button', { name: '排序方向' }))
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('sort') === 'updatedAt:asc')).toBe(true))
    const search = page.getByRole('searchbox', { name: '搜索商品' })
    fireEvent.change(search, { target: { value: 'B0TEST' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('q') === 'B0TEST')).toBe(true))
  })

  it('下一页用服务端给的游标', async () => {
    const response = (search: string) =>
      new URLSearchParams(search).get('cursor') === 'c2'
        ? listResponse({ items: [productRow({ id: 'p9', title: '第二页商品' })] })
        : listResponse({ pageInfo: { hasMore: true, nextCursor: 'c2', approxTotal: 3 } as never })
    const calls: string[] = []
    mountApp({
      url,
      pages,
      handlers: {
        '/products': u => {
          calls.push(u.search)
          return ok(response(u.search))
        },
      },
    })
    const page = within(await screen.findByTestId('products-page'))
    await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
    await userEvent.click(page.getByRole('button', { name: '下一页' }))
    expect(await page.findByText('第二页商品')).toBeInTheDocument()
    expect(calls.some(search => new URLSearchParams(search).get('cursor') === 'c2')).toBe(true)
  })

  it('商品超过读取上限、风险评估被截断：如实提示', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ truncated: true, riskTruncated: true })) })
    expect(await screen.findByText(/商品数量超过读取上限/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.getByText(/库存记录超过评估上限/)).toBeInTheDocument()
  })

  it('还没有同步到商品：写明原因，不画示例行', async () => {
    mountApp({ url, pages, handlers: listHandlers(() => emptyList()) })
    expect(await screen.findByText(/还没有同步到商品/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '玻璃保鲜盒套装' })).toBeNull()
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { '/products': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('products-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('玻璃保鲜盒套装')).toBeNull()
  }, 30_000)
})

describe('商品主数据：批量动作', () => {
  const select = async (page: ReturnType<typeof within>) => {
    await userEvent.click(
      (await waitFor(() => {
        const box = document.querySelector('.ag-row .ag-selection-checkbox input')
        if (!box) throw new Error('no row')
        return box
      })) as HTMLElement,
    )
    expect(await page.findByText('已选 1 个')).toBeInTheDocument()
  }

  it('没勾选商品时：设置标签、同步目录、加入关注都不可点；勾选后可点', async () => {
    const { page } = await open()
    for (const name of ['设置标签与负责人', '同步商品目录', '加入关注']) expect(page.getByRole('button', { name })).toBeDisabled()
    expect(page.getByRole('button', { name: '去补货建议' })).toBeEnabled()
    await select(page)
    for (const name of ['设置标签与负责人', '同步商品目录', '加入关注']) expect(page.getByRole('button', { name })).toBeEnabled()
  })

  it('没有对应权限：按钮置灰，不提供“批量修改刊登”', async () => {
    const { page } = await open(listResponse, {}, withPermissions(['products.read']))
    await select(page)
    for (const name of ['设置标签与负责人', '同步商品目录', '加入关注', '导出商品资料']) expect(page.getByRole('button', { name })).toBeDisabled()
    expect(page.queryByRole('button', { name: /修改刊登/ })).toBeNull()
    expect(page.queryByRole('button', { name: /创建补货草稿/ })).toBeNull()
  })

  it('设置标签与负责人：请求体带所选商品的版本号与追加的标签', async () => {
    const bodies: Array<Record<string, any>> = []
    const { page } = await open(listResponse, {
      '/products/meta': (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ updated: 1, unchanged: 0, items: [] })
      },
    })
    await select(page)
    await userEvent.click(page.getByRole('button', { name: '设置标签与负责人' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByRole('combobox', { name: /标签/ }), '新品{Enter}')
    await userEvent.click(dialog.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ items: [{ id: 'p1', version: 1 }], tags: { mode: 'ADD', values: ['新品'] } })
  })

  it('同步商品目录：按所选商品所在的店铺发起，一个店铺一次', async () => {
    const bodies: Array<Record<string, any>> = []
    const { page } = await open(
      () => listResponse({ items: [productRow(), productRow({ id: 'p2', sku: 'SKU-2', title: '同店另一个商品' }), noSalesRow({ sellerAccountId: 'st2', storeName: 'Oak & Pine' })] }),
      {
        '/products/sync': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return { status: 201, body: { success: true, data: { jobs: [{ storeId: 'st1', storeName: 'Northstar US', jobId: 'j1' }], skipped: [] } } }
        },
      },
    )
    await page.findByText('同店另一个商品', {}, { timeout: 15_000 })
    for (const box of Array.from(document.querySelectorAll('.ag-row .ag-selection-checkbox input'))) await userEvent.click(box as HTMLElement)
    expect(await page.findByText('已选 3 个')).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: '同步商品目录' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/以店铺为单位/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /发起同步/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].storeIds.slice().sort()).toEqual(['st1', 'st2'])
  })

  it('导出：条件与页面一致，提交到导出中心；不含销售、利润、库存', async () => {
    const bodies: Array<Record<string, any>> = []
    const { page } = await open(listResponse, {
      '/exports': (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ id: 'e1' })
      },
    })
    const search = page.getByRole('searchbox', { name: '搜索商品' })
    fireEvent.change(search, { target: { value: '保鲜盒' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await userEvent.click(page.getByRole('button', { name: '导出商品资料' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/不含销售、利润、库存数字/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /发起导出/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ kind: 'products', format: 'CSV', filters: { q: '保鲜盒' } })
    expect(bodies[0].filterSummary).toContain('保鲜盒')
  })

  it('加入关注：只提交还没关注的商品，一个一个提交', async () => {
    const bodies: Array<Record<string, any>> = []
    const { page } = await open(listResponse, {
      '/watches': (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok({ id: 'w1', created: true })
      },
    })
    await select(page)
    await userEvent.click(page.getByRole('button', { name: '加入关注' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ entityType: 'ASIN', entityId: 'p1' })
  })

  it('所选商品都已关注：加入关注置灰并说明', async () => {
    const { page } = await open(() => listResponse({ items: [productRow({ watched: true })] }))
    await select(page)
    expect(page.getByRole('button', { name: '加入关注' })).toBeDisabled()
  })
})
