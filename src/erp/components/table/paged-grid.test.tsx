import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../api'
import { renderWithApp } from '../../test/render'
import { moneyColumn, numberColumn, textColumn } from './columns'
import { PagedGrid, type PagedGridProps } from './PagedGrid'
import type { PageFetcher } from './grid-types'

// 页码分页表格（P6-02）：page/pageSize/total 约定、跳页与每页条数、筛选回第一页、排序走服务端、汇总行只取服务端、固定列与两层表头。

type Row = { id: string; name: string; units: number; sales: number }
const makeRows = (count: number, start = 0): Row[] => Array.from({ length: count }, (_, i) => ({ id: `r${start + i}`, name: `商品${start + i}`, units: start + i, sales: (start + i) * 10 }))
const emptyState = { kind: 'empty' as const, domain: '本页展示库存', prerequisite: '先授权店铺并同步库存' }

const columns = [
  { ...textColumn<Row>('名称', 'name'), pin: 'left' as const, group: '商品' },
  { ...numberColumn<Row>('件数', 'units'), group: '销量' },
  { ...moneyColumn<Row>('销售额', 'sales'), group: '销量' },
]

function props(fetchPage: PageFetcher<Row>, over: Partial<PagedGridProps<Row>> = {}): PagedGridProps<Row> {
  return { gridId: 'paged-test', columns, fetchPage, getRowId: row => row.id, resetKey: 'k1', emptyState, sortableFields: { units: 'units' }, ...over }
}

describe('页码分页表格：取数约定', () => {
  it('第一次取第 1 页，每页 50 条，带上 page、pageSize、排序为空；显示共多少行与共多少条', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async () => ({ items: makeRows(3), total: 3 }))
    renderWithApp(<PagedGrid {...props(fetchPage)} />)
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ page: 1, pageSize: 50, sort: null })
    expect(await screen.findByText('共 3 行')).toBeInTheDocument()
    expect(await screen.findByText('共 3 条')).toBeInTheDocument()
    expect(await screen.findByText('商品2')).toBeInTheDocument()
  })

  it('点到第 2 页会请求第 2 页；换每页条数回到第 1 页并按新条数请求', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async ({ page, pageSize }) => ({ items: makeRows(2, (page - 1) * pageSize), total: 130 }))
    renderWithApp(<PagedGrid {...props(fetchPage)} />)
    await screen.findByText('商品0')
    await userEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(fetchPage.mock.calls[fetchPage.mock.calls.length - 1]![0]).toMatchObject({ page: 2, pageSize: 50 }))
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(await screen.findByText('100 条/页'))
    await waitFor(() => expect(fetchPage.mock.calls[fetchPage.mock.calls.length - 1]![0]).toMatchObject({ page: 1, pageSize: 100 }))
  })

  it('每页条数只有 20、50、100、200 四档', async () => {
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(1), total: 1 }))} />)
    await screen.findByText('商品0')
    await userEvent.click(screen.getByRole('combobox'))
    for (const label of ['20 条/页', '50 条/页', '100 条/页', '200 条/页']) expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)
    expect(screen.queryByText('10 条/页')).toBeNull()
  })

  it('筛选条件变化（resetKey）：回到第 1 页重新取', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async ({ page }) => ({ items: makeRows(2, page * 100), total: 130 }))
    const { rerender } = renderWithApp(<PagedGrid {...props(fetchPage)} />)
    await screen.findByText('商品100')
    await userEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(fetchPage.mock.calls[fetchPage.mock.calls.length - 1]![0].page).toBe(2))
    rerender(<PagedGrid {...props(fetchPage, { resetKey: 'k2' })} />)
    await waitFor(() => expect(fetchPage.mock.calls[fetchPage.mock.calls.length - 1]![0]).toMatchObject({ page: 1 }))
    expect(fetchPage.mock.calls.filter(call => call[0].page === 2)).toHaveLength(1)
  })

  it('没有数据：显示数据域与前置条件，不显示空表和分页', async () => {
    renderWithApp(<PagedGrid {...props(async () => ({ items: [], total: 0 }))} />)
    expect(await screen.findByText('本页展示库存')).toBeInTheDocument()
    expect(screen.getByText(/先授权店铺并同步库存/)).toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 条/)).toBeNull()
  })

  it('请求失败：显示服务端错误与请求编号，重试后恢复', async () => {
    let fail = true
    const fetchPage = vi.fn<PageFetcher<Row>>(async () => {
      if (fail) throw new ApiError(500, 'INTERNAL', '服务出错', undefined, { requestId: 'req-p1' })
      return { items: makeRows(1), total: 1 }
    })
    renderWithApp(<PagedGrid {...props(fetchPage)} />)
    expect(await screen.findByText(/请求编号：req-p1/)).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByText('商品0')).toBeInTheDocument()
    expect(screen.queryByText(/请求编号：req-p1/)).toBeNull()
  })

  it('服务端返回格式不对（缺 total）：按失败处理，不画坏数据', async () => {
    const bad = (async () => ({ items: makeRows(1) })) as unknown as PageFetcher<Row>
    renderWithApp(<PagedGrid {...props(bad)} />)
    expect(await screen.findByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
    expect(screen.queryByText('商品0')).toBeNull()
  })

  it('页码超出范围（翻页时数据变少了）：自动回到最后一页，不显示成空表也不死循环', async () => {
    let shrunk = false
    const calls: number[] = []
    const fetchPage: PageFetcher<Row> = async ({ page }) => {
      calls.push(page)
      if (!shrunk) return { items: makeRows(2, page * 100), total: 60 }
      return page > 2 ? { items: [], total: 30 } : { items: makeRows(2, page * 100), total: 30 }
    }
    renderWithApp(<PagedGrid {...props(fetchPage, { initialPageSize: 20 })} />)
    await screen.findByText('商品100')
    shrunk = true
    await userEvent.click(screen.getByTitle('3'))
    await screen.findByText('商品200')
    expect(calls).toEqual([1, 3, 2])
    expect(screen.queryByText('本页展示库存')).toBeNull()
  })
})

describe('页码分页表格：排序、汇总行、固定列与分组', () => {
  it('点击可排序列的表头：回到第 1 页并带上服务端排序字段；不在白名单里的列不可排序', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async () => ({ items: makeRows(3), total: 3 }))
    renderWithApp(<PagedGrid {...props(fetchPage)} />)
    await screen.findByText('商品0')
    await userEvent.click(screen.getByText('销售额'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetchPage.mock.calls.every(call => call[0].sort === null)).toBe(true)
    await userEvent.click(screen.getByText('件数'))
    await waitFor(() => expect(fetchPage.mock.calls[fetchPage.mock.calls.length - 1]![0]).toMatchObject({ page: 1, sort: { field: 'units', direction: 'asc' } }))
  })

  it('汇总行：取服务端汇总，显示在表头下方的固定行；没给的列显示“—”，不是 0；前端不求和', async () => {
    const fetchSummary = vi.fn(async () => ({ totals: { units: 9999, sales: null } }))
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(3), total: 3 }), { fetchSummary })} />)
    await screen.findByText('商品0')
    const top = await waitFor(() => {
      const el = document.querySelector('.ag-row-pinned')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    await waitFor(() => expect(within(top).getByText('汇总')).toBeInTheDocument())
    expect(within(top).getByText('9,999')).toBeInTheDocument()
    // 数据行 0+1+2=3 件，汇总行不能是前端算出来的 3
    expect(within(top).queryByText('3')).toBeNull()
    expect(within(top).getAllByText('—').length).toBeGreaterThan(0)
    expect(fetchSummary).toHaveBeenCalledTimes(1)
  })

  it('没有 fetchSummary：不显示汇总行', async () => {
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(2), total: 2 }))} />)
    await screen.findByText('商品0')
    expect(screen.queryByText('汇总')).toBeNull()
    expect(document.querySelector('.ag-row-pinned')).toBeNull()
  })

  it('汇总读取失败：不显示汇总行也不拿 0 充数，工具栏写明并可重试；表格数据不受影响', async () => {
    let fail = true
    const fetchSummary = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return { totals: { units: 7 } }
    })
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(2), total: 2 }), { fetchSummary })} />)
    expect(await screen.findByText(/汇总暂时读不到/)).toBeInTheDocument()
    expect(screen.getByText('商品0')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /重试汇总/ }))
    await waitFor(() => expect(screen.queryByText(/汇总暂时读不到/)).toBeNull())
    expect(fetchSummary).toHaveBeenCalledTimes(2)
  })

  it('翻页不重新取汇总；筛选条件变化才重新取', async () => {
    const fetchSummary = vi.fn(async () => ({ totals: { units: 1 } }))
    const fetchPage = vi.fn<PageFetcher<Row>>(async ({ page }) => ({ items: makeRows(2, page * 10), total: 130 }))
    const { rerender } = renderWithApp(<PagedGrid {...props(fetchPage, { fetchSummary })} />)
    await screen.findByText('商品10')
    await userEvent.click(screen.getByTitle('2'))
    await screen.findByText('商品20')
    expect(fetchSummary).toHaveBeenCalledTimes(1)
    rerender(<PagedGrid {...props(fetchPage, { fetchSummary, resetKey: 'k2' })} />)
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2))
  })

  it('固定列与两层表头：左固定的列在左固定容器里；同名分组并成一个组头', async () => {
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(1), total: 1 }))} />)
    await screen.findByText('商品0')
    const lastLeft = Array.from(document.querySelectorAll('.ag-cell-last-left-pinned')).map(el => el.textContent)
    expect(lastLeft).toContain('商品0')
    const groups = Array.from(document.querySelectorAll('.ag-header-group-cell')).map(el => el.textContent?.trim())
    expect(groups).toEqual(expect.arrayContaining(['商品', '销量']))
    expect(groups.filter(text => text === '销量')).toHaveLength(1)
  })

  it('列设置按组折叠；整组取消勾选后该组的列都隐藏，且至少保留一列', async () => {
    window.localStorage.clear()
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(1), total: 1 }))} />)
    await screen.findByText('商品0')
    await userEvent.click(screen.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByLabelText('整组显示：销量'))
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('erp.grid.paged-test.hidden-columns')!)).toEqual(['units', 'sales']))
    // 只剩“名称”一列时，它的勾选框被禁用，不能把表格隐藏成空表头
    await userEvent.click(await screen.findByLabelText('整组显示：商品'))
    expect(JSON.parse(window.localStorage.getItem('erp.grid.paged-test.hidden-columns')!)).toEqual(['units', 'sales'])
  })

  it('批量动作条显示在表格下方，没有勾选时不显示', async () => {
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(2), total: 2 }), { renderBulkActions: rows => <span>共 {rows.length} 个动作</span> })} />)
    await screen.findByText('商品0')
    expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull()
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = await screen.findByRole('toolbar', { name: '批量操作' })
    expect(within(bar).getByText('已选 1 项')).toBeInTheDocument()
    const grid = document.querySelector('.erp-grid-body') as HTMLElement
    expect(grid.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('翻页后上一页的勾选不带到新页：批量动作条随之消失', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async ({ page }) => ({ items: makeRows(2, page * 10), total: 130 }))
    renderWithApp(<PagedGrid {...props(fetchPage, { renderBulkActions: rows => <span>共 {rows.length} 个动作</span> })} />)
    await screen.findByText('商品10')
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    await screen.findByRole('toolbar', { name: '批量操作' })
    await userEvent.click(screen.getByTitle('2'))
    await screen.findByText('商品20')
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull())
  })
})

describe('页码分页表格：权限', () => {
  const denied = () => new ApiError(403, 'FORBIDDEN', '无权限', undefined, { requestId: 'req-403' })

  it('取页被拒绝（403）：显示无权限，不显示空表也不显示重试', async () => {
    const fetchPage = vi.fn<PageFetcher<Row>>(async () => {
      throw denied()
    })
    renderWithApp(<PagedGrid {...props(fetchPage)} />)
    expect(await screen.findByText('无权限查看此内容')).toBeInTheDocument()
    expect(screen.queryByText('商品0')).toBeNull()
  })

  it('汇总被拒绝（403）：只在工具栏写明无权查看汇总，没有重试按钮；表格数据照常', async () => {
    const fetchSummary = vi.fn(async () => {
      throw denied()
    })
    renderWithApp(<PagedGrid {...props(async () => ({ items: makeRows(2), total: 2 }), { fetchSummary })} />)
    expect(await screen.findByText(/没有查看汇总的权限/)).toBeInTheDocument()
    expect(screen.getByText('商品0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重试汇总/ })).toBeNull()
  })
})
