import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../api'
import { renderWithApp } from '../../test/render'
import { moneyColumn, textColumn } from './columns'
import { ASYNC_BATCH_MAX, ASYNC_MAX_ENTRIES, createAsyncStore } from './grid-async'
import { PagedGrid } from './PagedGrid'
import { MassiveGrid } from './MassiveGrid'
import type { AsyncColumnSpec, AsyncRowsResponse, PageFetcher } from './grid-types'

// 异步列（P6-02）：慢列单独请求；只对可见行；先占位后淡入；失败可重试；响应里没有的行显示“—”；换筛选后旧响应作废。

const spec = (fetch: AsyncColumnSpec['fetch']): AsyncColumnSpec => ({ key: 'ads', fetch })
const ids = (count: number, prefix = 'r') => Array.from({ length: count }, (_, i) => `${prefix}${i}`)
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('异步列存储', () => {
  it('同一行不重复请求；一次最多 100 行，超过自动分批', async () => {
    const fetch = vi.fn(async (rowIds: string[]) => ({ rows: Object.fromEntries(rowIds.map(id => [id, { v: 1 }])) }))
    const store = createAsyncStore()
    store.request(spec(fetch), ids(250))
    await tick()
    expect(fetch.mock.calls.map(call => call[0].length)).toEqual([ASYNC_BATCH_MAX, ASYNC_BATCH_MAX, 50])
    store.request(spec(fetch), [...ids(250), 'new'])
    await tick()
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[3]![0]).toEqual(['new'])
  })

  it('响应里没有的行算“没有记录”（ready 且没有值），不算失败', async () => {
    const store = createAsyncStore()
    store.request(
      spec(async () => ({ rows: { a: { v: 5 } } })),
      ['a', 'b'],
    )
    await tick()
    await tick()
    expect(store.entry('ads', 'a')).toEqual({ status: 'ready', values: { v: 5 } })
    expect(store.entry('ads', 'b')).toEqual({ status: 'ready', values: {} })
  })

  it('失败的行标成失败；retry 只重发失败的行，成功的不动', async () => {
    let fail = true
    const fetch = vi.fn(async (rowIds: string[]): Promise<AsyncRowsResponse> => {
      if (fail && rowIds.includes('bad')) throw new Error('boom')
      return { rows: Object.fromEntries(rowIds.map(id => [id, { v: 1 }])) }
    })
    const store = createAsyncStore()
    store.request(spec(fetch), ['good'])
    store.request(spec(fetch), ['bad'])
    await tick()
    await tick()
    expect(store.entry('ads', 'good')?.status).toBe('ready')
    expect(store.entry('ads', 'bad')?.status).toBe('error')
    fail = false
    store.retry(spec(fetch))
    await tick()
    await tick()
    expect(fetch.mock.calls[fetch.mock.calls.length - 1]![0]).toEqual(['bad'])
    expect(store.entry('ads', 'bad')?.status).toBe('ready')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('403 的行标成 forbidden，retry 不再重发它', async () => {
    const fetch = vi.fn(async (): Promise<AsyncRowsResponse> => {
      throw new ApiError(403, 'FORBIDDEN', '无权限')
    })
    const store = createAsyncStore()
    store.request(spec(fetch), ['a'])
    await tick()
    await tick()
    expect(store.entry('ads', 'a')).toEqual({ status: 'error', forbidden: true })
    store.retry(spec(fetch))
    await tick()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reset 之后迟到的响应被丢弃，在途请求被中止', async () => {
    let release: (value: AsyncRowsResponse) => void = () => undefined
    let signal: AbortSignal | undefined
    const store = createAsyncStore()
    store.request(
      spec((_ids, abort) => {
        signal = abort
        return new Promise<AsyncRowsResponse>(resolve => (release = resolve))
      }),
      ['a'],
    )
    await tick()
    expect(store.entry('ads', 'a')?.status).toBe('pending')
    store.reset()
    expect(signal?.aborted).toBe(true)
    release({ rows: { a: { v: 1 } } })
    await tick()
    expect(store.entry('ads', 'a')).toBeUndefined()
  })

  it('同步抛错的取数函数也按失败处理，不会让表格崩溃', async () => {
    const store = createAsyncStore()
    store.request(
      spec(() => {
        throw new Error('同步错')
      }),
      ['a'],
    )
    await tick()
    await tick()
    expect(store.entry('ads', 'a')?.status).toBe('error')
  })

  it(`本地最多保留 ${ASYNC_MAX_ENTRIES} 个行结果，超出的丢最早的`, async () => {
    const store = createAsyncStore()
    const fetch = async (rowIds: string[]) => ({ rows: Object.fromEntries(rowIds.map(id => [id, { v: 1 }])) })
    store.request(spec(fetch), ids(ASYNC_MAX_ENTRIES + 10))
    await tick()
    await tick()
    expect(store.size()).toBe(ASYNC_MAX_ENTRIES)
    expect(store.entry('ads', 'r0')).toBeUndefined()
    expect(store.entry('ads', `r${ASYNC_MAX_ENTRIES + 9}`)?.status).toBe('ready')
  })
})

type Row = { id: string; name: string; adSpend?: number }
const emptyState = { kind: 'empty' as const, domain: '本页展示商品', prerequisite: '先同步商品' }
const rows = (count: number, start = 0): Row[] => Array.from({ length: count }, (_, i) => ({ id: `r${start + i}`, name: `商品${start + i}` }))

const gridProps = <F,>(fetchPage: F, ads: AsyncColumnSpec | undefined, over: object = {}) => ({
  gridId: 'async-test',
  columns: [textColumn<Row>('名称', 'name'), moneyColumn<Row>('广告花费', 'adSpend', { async: ads })],
  fetchPage,
  getRowId: (row: Row) => row.id,
  resetKey: 'k1',
  emptyState,
  ...over,
})

describe('异步列在表格里', () => {
  it('主数据先出来；异步列先占位，返回后显示格式化后的值；只请求可见行', async () => {
    let release: (value: AsyncRowsResponse) => void = () => undefined
    const fetch = vi.fn(
      (rowIds: string[]) =>
        new Promise<AsyncRowsResponse>(resolve => {
          release = () => resolve({ rows: Object.fromEntries(rowIds.map((id, i) => [id, { adSpend: (i + 1) * 10 }])) })
        }),
    )
    renderWithApp(<PagedGrid {...gridProps(async () => ({ items: rows(3), total: 3 }), spec(fetch))} />)
    expect(await screen.findByText('商品2')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('status', { name: '加载中' })).toHaveLength(3))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toEqual(['r0', 'r1', 'r2'])
    release({ rows: {} })
    expect(await screen.findByText('$10.00')).toBeInTheDocument()
    expect(screen.getByText('$30.00')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).toBeNull()
  })

  it('响应里缺的行显示“—”，不是 0 也不是失败', async () => {
    renderWithApp(
      <PagedGrid
        {...gridProps(
          async () => ({ items: rows(2), total: 2 }),
          spec(async () => ({ rows: { r0: { adSpend: 7 } } })),
        )}
      />,
    )
    expect(await screen.findByText('$7.00')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('status', { name: '加载中' })).toBeNull())
    expect(screen.queryByText(/加载失败/)).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('失败的单元格显示“加载失败，重试”，点击后重新请求并显示结果', async () => {
    let fail = true
    const fetch = vi.fn(async (rowIds: string[]): Promise<AsyncRowsResponse> => {
      if (fail) throw new Error('boom')
      return { rows: Object.fromEntries(rowIds.map(id => [id, { adSpend: 5 }])) }
    })
    renderWithApp(<PagedGrid {...gridProps(async () => ({ items: rows(2), total: 2 }), spec(fetch))} />)
    const retry = await screen.findAllByRole('button', { name: '加载失败，重试' })
    expect(retry).toHaveLength(2)
    fail = false
    await userEvent.click(retry[0]!)
    expect((await screen.findAllByText('$5.00')).length).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('403：单元格显示“无权限”，没有重试按钮，也不会自动重试', async () => {
    const fetch = vi.fn(async (): Promise<AsyncRowsResponse> => {
      throw new ApiError(403, 'FORBIDDEN', '无权限')
    })
    renderWithApp(<PagedGrid {...gridProps(async () => ({ items: rows(2), total: 2 }), spec(fetch))} />)
    expect((await screen.findAllByText('无权限')).length).toBe(2)
    expect(screen.queryByRole('button', { name: '加载失败，重试' })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('翻到新的一页只请求新出现的行；回到看过的页不再请求', async () => {
    const fetch = vi.fn(async (rowIds: string[]) => ({ rows: Object.fromEntries(rowIds.map(id => [id, { adSpend: 1 }])) }))
    const fetchPage: PageFetcher<Row> = async ({ page }) => ({ items: rows(2, page * 10), total: 80 })
    renderWithApp(<PagedGrid {...gridProps(fetchPage, spec(fetch), { initialPageSize: 20 })} />)
    await screen.findByText('商品10')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTitle('2'))
    await screen.findByText('商品20')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1]![0]).toEqual(['r20', 'r21'])
    await userEvent.click(screen.getByTitle('1'))
    await screen.findByText('商品10')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('筛选条件变化：旧结果清空，对新数据重新请求', async () => {
    const fetch = vi.fn(async (rowIds: string[]) => ({ rows: Object.fromEntries(rowIds.map(id => [id, { adSpend: 1 }])) }))
    const { rerender } = renderWithApp(<PagedGrid {...gridProps(async () => ({ items: rows(1), total: 1 }), spec(fetch))} />)
    await screen.findByText('$1.00')
    rerender(<PagedGrid {...gridProps(async () => ({ items: rows(1), total: 1 }), spec(fetch), { resetKey: 'k2' })} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('隐藏异步列后不请求它', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('erp.grid.async-test.hidden-columns', JSON.stringify(['adSpend']))
    const fetch = vi.fn(async () => ({ rows: {} }))
    renderWithApp(<PagedGrid {...gridProps(async () => ({ items: rows(2), total: 2 }), spec(fetch))} />)
    await screen.findByText('商品1')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fetch).not.toHaveBeenCalled()
    window.localStorage.clear()
  })

  it('无限滚动表格同样支持异步列', async () => {
    const fetch = vi.fn(async (rowIds: string[]) => ({ rows: Object.fromEntries(rowIds.map(id => [id, { adSpend: 3 }])) }))
    renderWithApp(<MassiveGrid {...gridProps(async () => ({ items: rows(2), nextCursor: null }), spec(fetch))} />)
    expect((await screen.findAllByText('$3.00')).length).toBe(2)
    expect(fetch.mock.calls[0]![0]).toEqual(['r0', 'r1'])
  })
})
