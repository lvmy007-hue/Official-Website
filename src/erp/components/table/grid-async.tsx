import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { IRowNode, ICellRendererParams } from 'ag-grid-community'
import { EMPTY_VALUE } from '../../format'
import { describeError } from '../../query/errors'
import { columnId, type AsyncColumnSpec, type ErpColDef } from './grid-types'

// 异步列（P6-02，15 章第 6 节）：主数据先返回，慢的列只对“当前渲染出来的行”批量请求。
// - 单元格先显示占位，返回后淡入；滚动到新的数据块时，新出现的行再请求；已有记录的行不重复请求；
// - 失败的行显示“加载失败”，点一下只重试同一个 key 下失败的行；
// - 响应里没有的行按“没有记录”显示“—”，不算失败；
// - 一次请求最多 ASYNC_BATCH_MAX 行；本地最多保留 ASYNC_MAX_ENTRIES 个行结果（超出丢最早的，滚回去会重新请求）。

export const ASYNC_BATCH_MAX = 100
export const ASYNC_MAX_ENTRIES = 5000

export type AsyncEntry = { status: 'pending' } | { status: 'error'; forbidden: boolean } | { status: 'ready'; values: Record<string, unknown> }
type Listener = () => void

export type AsyncStore = {
  entry: (key: string, rowId: string) => AsyncEntry | undefined
  subscribe: (listener: Listener) => () => void
  /** 对尚未有结果的行发请求。 */
  request: (spec: AsyncColumnSpec, rowIds: readonly string[]) => void
  /** 重试某个 key 下失败的行。 */
  retry: (spec: AsyncColumnSpec) => void
  /** 作废在途请求并清空结果（筛选变化、重试整表时调用）。 */
  reset: () => void
  size: () => number
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

export function createAsyncStore(): AsyncStore {
  const entries = new Map<string, AsyncEntry>()
  const listeners = new Set<Listener>()
  let generation = 0
  let controller = new AbortController()
  const idOf = (key: string, rowId: string) => `${key}\u0000${rowId}`
  const notify = () => listeners.forEach(listener => listener())
  const put = (key: string, rowId: string, entry: AsyncEntry) => {
    const id = idOf(key, rowId)
    entries.delete(id)
    entries.set(id, entry)
    while (entries.size > ASYNC_MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  const run = (spec: AsyncColumnSpec, ids: string[]) => {
    const ticket = generation
    const { signal } = controller
    for (let start = 0; start < ids.length; start += ASYNC_BATCH_MAX) {
      const chunk = ids.slice(start, start + ASYNC_BATCH_MAX)
      chunk.forEach(rowId => put(spec.key, rowId, { status: 'pending' }))
      Promise.resolve()
        .then(() => spec.fetch(chunk, signal))
        .then(response => {
          if (ticket !== generation) return
          for (const rowId of chunk) put(spec.key, rowId, { status: 'ready', values: response.rows?.[rowId] ?? {} })
          notify()
        })
        .catch(error => {
          if (ticket !== generation || isAbort(error)) return
          const forbidden = describeError(error).kind === 'forbidden'
          for (const rowId of chunk) put(spec.key, rowId, { status: 'error', forbidden })
          notify()
        })
    }
    notify()
  }

  return {
    entry: (key, rowId) => entries.get(idOf(key, rowId)),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request: (spec, rowIds) => {
      const fresh = [...new Set(rowIds)].filter(rowId => !entries.has(idOf(spec.key, rowId)))
      if (fresh.length) run(spec, fresh)
    },
    retry: spec => {
      const failed: string[] = []
      const prefix = `${spec.key}\u0000`
      entries.forEach((entry, id) => {
        if (entry.status === 'error' && !entry.forbidden && id.startsWith(prefix)) failed.push(id.slice(prefix.length))
      })
      if (failed.length) run(spec, failed)
    },
    reset: () => {
      generation += 1
      controller.abort()
      controller = new AbortController()
      entries.clear()
      notify()
    },
    size: () => entries.size,
  }
}

/** 把列里的异步声明按 key 归并；隐藏的列不请求。 */
export function collectAsyncSpecs<T>(columns: readonly ErpColDef<T>[], hidden: readonly string[]): AsyncColumnSpec[] {
  const byKey = new Map<string, AsyncColumnSpec>()
  for (const col of columns) {
    if (!col.async || hidden.includes(columnId(col))) continue
    if (!byKey.has(col.async.key)) byKey.set(col.async.key, col.async)
  }
  return [...byKey.values()]
}

/** scan 只需要表格接口里的这两个方法。 */
export type ScanApi = { getRenderedNodes: () => IRowNode[]; isDestroyed: () => boolean }

/** 当前渲染出来的、已有数据的行编号（占位行、汇总行不算）。 */
export function renderedRowIds(api: ScanApi): string[] {
  const ids: string[] = []
  for (const node of api.getRenderedNodes()) if (!node.rowPinned && node.data && node.id) ids.push(node.id)
  return ids
}

export type AsyncColumns = { store: AsyncStore; specs: AsyncColumnSpec[]; scan: (api: ScanApi | null) => void }

/** 异步列的挂接：scan 在数据块到达、滚动停下、列显示变化时调用，对可见行发请求。 */
export function useAsyncColumns<T>(columns: readonly ErpColDef<T>[], hidden: readonly string[], resetKey: string): AsyncColumns | null {
  const store = useMemo(() => createAsyncStore(), [])
  const specs = useMemo(() => collectAsyncSpecs(columns, hidden), [columns, hidden])
  const specsRef = useRef(specs)
  specsRef.current = specs
  useEffect(() => {
    store.reset()
    return () => store.reset()
  }, [store, resetKey])
  const scan = useMemo(
    () => (api: ScanApi | null) => {
      if (!api || api.isDestroyed()) return
      const ids = renderedRowIds(api)
      if (ids.length) specsRef.current.forEach(spec => store.request(spec, ids))
    },
    [store],
  )
  return specs.length ? { store, specs, scan } : null
}

type AsyncCellParams = ICellRendererParams & {
  asyncKey: string
  asyncSpec: AsyncColumnSpec
  field: string
  format?: (value: unknown, params: ICellRendererParams) => string
  inner?: (params: ICellRendererParams) => ReactNode
}

/** 异步列的单元格：占位 → 淡入 → 失败可重试。 */
export function AsyncCell(params: AsyncCellParams) {
  const store = (params.context as { asyncStore?: AsyncStore } | undefined)?.asyncStore
  const rowId = params.node.id ?? ''
  const subscribe = useMemo(() => store?.subscribe ?? (() => () => undefined), [store])
  const entry = useSyncExternalStore(
    subscribe,
    () => store?.entry(params.asyncKey, rowId),
    () => undefined,
  )
  if (params.node.rowPinned) return <span className="erp-num">{params.valueFormatted ?? ''}</span>
  if (!entry || entry.status === 'pending') return <span className="erp-async-skeleton" role="status" aria-label="加载中" />
  if (entry.status === 'error') {
    if (entry.forbidden)
      return (
        <span className="erp-async-in" title="当前账号没有查看这一列的权限">
          无权限
        </span>
      )
    return (
      <button type="button" className="erp-async-error" onClick={() => store?.retry(params.asyncSpec)}>
        加载失败，重试
      </button>
    )
  }
  const value = entry.values[params.field]
  if (value === undefined || value === null) return <span className="erp-async-in">{EMPTY_VALUE}</span>
  const content = params.inner ? params.inner({ ...params, value }) : params.format ? params.format(value, params) : String(value)
  return <span className="erp-async-in">{content}</span>
}
