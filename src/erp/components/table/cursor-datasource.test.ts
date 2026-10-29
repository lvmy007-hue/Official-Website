import { describe, expect, it, vi } from 'vitest'
import type { IGetRowsParams } from 'ag-grid-community'
import { BLOCK_SIZE, ChainTooLongError, MAX_CACHED_BLOCKS, MAX_CHAIN_BLOCKS, createCursorDatasource, pickSort, type CursorFetcher } from './cursor-datasource'

// 假的服务端：共 total 行，游标是“下一行起点”的文本，只能顺序取。
function fakeServer(total: number) {
  const calls: Array<{ cursor: string | null; sort: unknown; limit: number }> = []
  const fetchPage: CursorFetcher<{ id: number }> = async ({ cursor, limit, sort }) => {
    calls.push({ cursor, sort, limit })
    const start = cursor === null ? 0 : Number(cursor)
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => ({ id: start + i }))
    const next = start + limit < total ? String(start + limit) : null
    return { items, nextCursor: next, approxTotal: total }
  }
  return { fetchPage, calls }
}

function request(ds: ReturnType<typeof createCursorDatasource>, startRow: number, sortModel: IGetRowsParams['sortModel'] = []) {
  return new Promise<{ rows?: unknown[]; lastRow?: number; failed?: boolean }>(resolve => {
    ds.getRows({
      startRow,
      endRow: startRow + BLOCK_SIZE,
      sortModel,
      filterModel: {},
      context: undefined,
      successCallback: (rows, lastRow) => resolve({ rows, lastRow }),
      failCallback: () => resolve({ failed: true }),
    } as IGetRowsParams)
  })
}

describe('游标分页数据源', () => {
  it('规格：每块 100 行，最多缓存 10 块', () => {
    expect(BLOCK_SIZE).toBe(100)
    expect(MAX_CACHED_BLOCKS).toBe(10)
  })

  it('第一块不带游标；总数未知时 lastRow 为 -1，取完最后一块后给出准确行数', async () => {
    const server = fakeServer(250)
    const ds = createCursorDatasource({ fetchPage: server.fetchPage })
    const first = await request(ds, 0)
    expect(first.rows).toHaveLength(100)
    expect(first.lastRow).toBe(-1)
    expect(server.calls[0]).toMatchObject({ cursor: null, limit: 100 })
    const second = await request(ds, 100)
    expect(second.lastRow).toBe(-1)
    const third = await request(ds, 200)
    expect(third.rows).toHaveLength(50)
    expect(third.lastRow).toBe(250)
  })

  it('跳到后面的块：从最近已知游标起依次取，每个块只取一次', async () => {
    const server = fakeServer(1000)
    const ds = createCursorDatasource({ fetchPage: server.fetchPage })
    const jump = await request(ds, 400)
    expect((jump.rows![0] as { id: number }).id).toBe(400)
    expect(server.calls.map(call => call.cursor)).toEqual([null, '100', '200', '300', '400'])
    // 回到已知的块，用保存的游标直接取，不再重复追赶
    await request(ds, 200)
    expect(server.calls).toHaveLength(6)
    expect(server.calls[5]!.cursor).toBe('200')
  })

  it('同一块的并发请求合并为一次', async () => {
    const server = fakeServer(500)
    const ds = createCursorDatasource({ fetchPage: server.fetchPage })
    await Promise.all([request(ds, 0), request(ds, 0), request(ds, 0)])
    expect(server.calls).toHaveLength(1)
  })

  it('只允许白名单字段排序，且只取第一列；不在白名单的列被忽略', async () => {
    expect(pickSort([{ colId: 'secret', sort: 'asc' }], { orderedAt: 'purchaseDate' }, null)).toBeNull()
    expect(
      pickSort(
        [
          { colId: 'secret', sort: 'asc' },
          { colId: 'orderedAt', sort: 'desc' },
        ],
        { orderedAt: 'purchaseDate' },
        null,
      ),
    ).toEqual({ field: 'purchaseDate', direction: 'desc' })
    expect(pickSort([], { orderedAt: 'purchaseDate' }, { field: 'purchaseDate', direction: 'desc' })).toEqual({ field: 'purchaseDate', direction: 'desc' })
    // 原型链上的名字不算白名单
    expect(pickSort([{ colId: 'toString', sort: 'asc' }], { orderedAt: 'purchaseDate' }, null)).toBeNull()
    const server = fakeServer(10)
    const ds = createCursorDatasource({ fetchPage: server.fetchPage, sortableFields: { orderedAt: 'purchaseDate' } })
    await request(ds, 0, [{ colId: 'secret', sort: 'asc' }])
    await request(createCursorDatasource({ fetchPage: server.fetchPage, sortableFields: { orderedAt: 'purchaseDate' } }), 0, [{ colId: 'orderedAt', sort: 'asc' }])
    expect(server.calls[0]!.sort).toBeNull()
    expect(server.calls[1]!.sort).toEqual({ field: 'purchaseDate', direction: 'asc' })
  })

  it('超过最大追赶块数时拒绝，并提示先缩小范围', async () => {
    const server = fakeServer(1_000_000)
    const onError = vi.fn()
    const ds = createCursorDatasource({ fetchPage: server.fetchPage, onError })
    const result = await request(ds, (MAX_CHAIN_BLOCKS + 1) * BLOCK_SIZE)
    expect(result.failed).toBe(true)
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(ChainTooLongError)
    expect(server.calls).toHaveLength(0)
  })

  it('请求失败：通知页面并让表格显示失败', async () => {
    const onError = vi.fn()
    const ds = createCursorDatasource({ fetchPage: async () => Promise.reject(new Error('boom')), onError })
    expect((await request(ds, 0)).failed).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('作废后迟到的响应被丢弃；恢复后可继续使用', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const fetchPage: CursorFetcher<{ id: number }> = async () => {
      await gate
      return { items: [{ id: 1 }], nextCursor: null }
    }
    const ds = createCursorDatasource({ fetchPage })
    const callback = vi.fn()
    ds.getRows({ startRow: 0, endRow: 100, sortModel: [], filterModel: {}, context: undefined, successCallback: callback, failCallback: callback } as unknown as IGetRowsParams)
    ds.destroy()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(callback).not.toHaveBeenCalled()
    ds.revive()
    expect((await request(ds, 0)).rows).toHaveLength(1)
  })

  it('请求最后一块之后的区间：返回空并给出总行数', async () => {
    const server = fakeServer(150)
    const ds = createCursorDatasource({ fetchPage: server.fetchPage })
    await request(ds, 0)
    await request(ds, 100)
    const beyond = await request(ds, 300)
    expect(beyond.rows).toEqual([])
    expect(beyond.lastRow).toBe(150)
  })

  it('回调约数总数', async () => {
    const onTotal = vi.fn()
    const ds = createCursorDatasource({ fetchPage: fakeServer(1234).fetchPage, onTotal })
    await request(ds, 0)
    expect(onTotal).toHaveBeenCalledWith(1234)
  })
})
