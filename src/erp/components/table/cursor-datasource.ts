import type { IDatasource, IGetRowsParams } from 'ag-grid-community'

// 游标分页数据源（12 章 12.2、12.4）：把 AG Grid 无限滚动的“按行区间取块”转成服务端的“按游标取下一页”。
// - 每块固定 100 行，最多缓存 10 块（由表格选项设定，这里只负责取数）；
// - 游标只能顺序获得：跳到第 k 块时，从最近已知的块开始依次取，直到拿到第 k 块的起始游标；
// - 排序只允许白名单字段，且一次只按一列排序；排序或筛选变化必须新建数据源（旧游标作废）；
// - 同一块并发请求合并，卸载后丢弃迟到的响应。

export const BLOCK_SIZE = 100
export const MAX_CACHED_BLOCKS = 10
/** 一次连续追赶的最大块数：超过说明用户在没有筛选的情况下拖到了很深的位置，提示先缩小范围。 */
export const MAX_CHAIN_BLOCKS = 30

export type SortSpec = { field: string; direction: 'asc' | 'desc' }

export type CursorFetchArgs = { cursor: string | null; limit: number; sort: SortSpec | null; signal: AbortSignal }
export type CursorFetchResult<T> = { items: T[]; nextCursor: string | null; approxTotal?: number | null }
export type CursorFetcher<T> = (args: CursorFetchArgs) => Promise<CursorFetchResult<T>>

export type CursorDatasourceOptions<T> = {
  fetchPage: CursorFetcher<T>
  /** 允许排序的字段（列标识 → 服务端字段名）。不在表里的列点击排序无效。 */
  sortableFields?: Readonly<Record<string, string>>
  /** 默认排序（服务端字段名）。 */
  defaultSort?: SortSpec | null
  blockSize?: number
  onError?: (error: unknown) => void
  /** 总数（约数）更新时回调，用于显示“约 N 行”。 */
  onTotal?: (approxTotal: number | null) => void
}

export type CursorDatasource<T> = IDatasource & {
  /** 作废：之后到达的响应全部丢弃，并中止在途请求。 */
  destroy: () => void
  /** 恢复（严格模式下清理后再次挂载时使用）。 */
  revive: () => void
  /** 已知游标的块数（测试与诊断用）。 */
  knownBlocks: () => number
  readonly __rowType?: T
}

export class ChainTooLongError extends Error {
  constructor() {
    super('当前位置过深，请先用筛选条件缩小范围')
    this.name = 'ChainTooLongError'
  }
}

/** 从 AG Grid 的排序模型取白名单内的第一列排序；其余一律忽略。 */
export function pickSort(sortModel: ReadonlyArray<{ colId: string; sort: string }> | undefined, sortable: Readonly<Record<string, string>> | undefined, fallback: SortSpec | null): SortSpec | null {
  const first = sortModel?.find(item => sortable && Object.prototype.hasOwnProperty.call(sortable, item.colId) && (item.sort === 'asc' || item.sort === 'desc'))
  if (!first || !sortable) return fallback
  return { field: sortable[first.colId]!, direction: first.sort as 'asc' | 'desc' }
}

export function createCursorDatasource<T>(options: CursorDatasourceOptions<T>): CursorDatasource<T> {
  const blockSize = options.blockSize ?? BLOCK_SIZE
  // cursors[k] = 取第 k 块用的游标（第 0 块为 null）；undefined 表示尚未获得。
  const cursors: Array<string | null | undefined> = [null]
  // 已确认没有更多数据的最后一块序号。
  let lastBlock: number | null = null
  let totalRows = 0
  let destroyed = false
  let controller = new AbortController()
  const inflight = new Map<number, Promise<CursorFetchResult<T>>>()

  async function loadBlock(block: number, sort: SortSpec | null): Promise<CursorFetchResult<T>> {
    const running = inflight.get(block)
    if (running) return running
    const cursor = cursors[block]
    if (cursor === undefined) throw new Error('内部错误：缺少游标')
    const task = options
      .fetchPage({ cursor, limit: blockSize, sort, signal: controller.signal })
      .then(result => {
        cursors[block + 1] = result.nextCursor
        if (result.nextCursor === null) {
          lastBlock = block
          totalRows = block * blockSize + result.items.length
        }
        if (result.approxTotal !== undefined) options.onTotal?.(result.approxTotal)
        return result
      })
      .finally(() => inflight.delete(block))
    inflight.set(block, task)
    return task
  }

  async function getRows(params: IGetRowsParams) {
    const block = Math.floor(params.startRow / blockSize)
    const sort = pickSort(params.sortModel, options.sortableFields, options.defaultSort ?? null)
    try {
      // 追赶：找到最近一个已有游标的块，依次取到目标块之前
      let known = block
      while (known > 0 && cursors[known] === undefined) known--
      if (block - known > MAX_CHAIN_BLOCKS) throw new ChainTooLongError()
      for (let step = known; step < block; step++) {
        if (lastBlock !== null && step >= lastBlock) break
        await loadBlock(step, sort)
        if (destroyed) return
      }
      if (lastBlock !== null && block > lastBlock) {
        params.successCallback([], totalRows)
        return
      }
      const result = await loadBlock(block, sort)
      if (destroyed) return
      const lastRow = result.nextCursor === null ? block * blockSize + result.items.length : -1
      params.successCallback(result.items, lastRow)
    } catch (error) {
      if (destroyed) return
      options.onError?.(error)
      params.failCallback()
    }
  }

  return {
    getRows: params => {
      void getRows(params)
    },
    destroy: () => {
      destroyed = true
      controller.abort()
    },
    revive: () => {
      if (!destroyed) return
      destroyed = false
      controller = new AbortController()
      inflight.clear()
    },
    knownBlocks: () => cursors.filter(item => item !== undefined).length,
  }
}
