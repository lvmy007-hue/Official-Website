import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DownOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons'
import type { ICellRendererParams } from 'ag-grid-community'

// 行内展开（P6-02，15 章第 6 节：父 ASIN 展开子体、装箱展开箱内明细）。
// AG Grid 的树形数据（treeData）是企业版功能，社区版没有，所以这里自己把“父子行”摊平成一维列表交给表格：
// - 只在页码分页模式（PagedGrid）可用，因为摊平发生在“当前页已有的行”上；无限滚动没有稳定的整体顺序，不支持；
// - 子行来自两处：行里已带着（getChildren），或展开时才请求（loadChildren，失败可重试）；
// - 深度最多 TREE_MAX_DEPTH 层，每个父行最多显示 TREE_CHILD_LIMIT 个子行，超出的部分提示而不是悄悄丢掉；
// - 同一个行编号只出现一次（重复的子行被忽略），避免表格行编号冲突。

export const TREE_MAX_DEPTH = 4
export const TREE_CHILD_LIMIT = 200

export type TreeOptions<T> = {
  hasChildren: (row: T) => boolean
  /** 子行已经带在父行里时返回它们（不再请求）。 */
  getChildren?: (row: T) => readonly T[] | undefined
  /** 展开时才请求子行。 */
  loadChildren?: (row: T, signal: AbortSignal) => Promise<readonly T[]>
}

export type TreeNodeState = 'collapsed' | 'expanded' | 'loading' | 'error'
export type TreeMeta = { __depth: number; __parent: string | null; __hasChildren: boolean; __treeState: TreeNodeState }
export type FlatRow<T> = T & TreeMeta
export type ChildState<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: readonly T[]; truncated: boolean }
export type TreeController = { toggle: (id: string) => void }

export type FlattenResult<T> = { rows: FlatRow<T>[]; byId: Map<string, T>; truncatedParents: number }

export function flattenTree<T extends object>(
  roots: readonly T[],
  getId: (row: T) => string,
  options: TreeOptions<T>,
  expanded: ReadonlySet<string>,
  children: ReadonlyMap<string, ChildState<T>>,
): FlattenResult<T> {
  const rows: FlatRow<T>[] = []
  const byId = new Map<string, T>()
  let truncatedParents = 0
  const visit = (row: T, depth: number, parent: string | null) => {
    const id = getId(row)
    if (byId.has(id)) return
    byId.set(id, row)
    const canExpand = depth < TREE_MAX_DEPTH && options.hasChildren(row)
    const isOpen = canExpand && expanded.has(id)
    const loaded = options.getChildren?.(row)
    const remote = children.get(id)
    let treeState: TreeNodeState = isOpen ? 'expanded' : 'collapsed'
    let kids: readonly T[] = []
    if (isOpen) {
      if (loaded) kids = loaded
      else if (remote?.status === 'ready') kids = remote.rows
      else treeState = remote?.status === 'error' ? 'error' : 'loading'
      if (kids.length > TREE_CHILD_LIMIT) {
        kids = kids.slice(0, TREE_CHILD_LIMIT)
        truncatedParents += 1
      } else if (remote?.status === 'ready' && remote.truncated) truncatedParents += 1
    }
    rows.push({ ...row, __depth: depth, __parent: parent, __hasChildren: canExpand, __treeState: treeState })
    for (const kid of kids) visit(kid, depth + 1, id)
  }
  for (const row of roots) visit(row, 0, null)
  return { rows, byId, truncatedParents }
}

type TreeState<T> = { scope: string; expanded: Set<string>; children: Map<string, ChildState<T>> }
const emptyState = <T,>(scope: string): TreeState<T> => ({ scope, expanded: new Set(), children: new Map() })

export type TreeRows<T> = { rows: readonly T[]; controller: TreeController | null; truncatedParents: number }

/** 把当前页的行按展开状态摊平；scopeKey 变化（换页、换筛选）时展开状态与子行缓存全部作废。 */
export function useTreeRows<T extends object>(items: readonly T[], getId: (row: T) => string, tree: TreeOptions<T> | undefined, scopeKey: string): TreeRows<T> {
  const [state, setState] = useState<TreeState<T>>(() => emptyState(scopeKey))
  const blank = useMemo(() => emptyState<T>(scopeKey), [scopeKey])
  // 换页、换筛选：展开状态与子行缓存作废（回到原来那一页时也不能把旧的展开状态带回来）
  if (state.scope !== scopeKey) setState(blank)
  const current = state.scope === scopeKey ? state : blank
  const abort = useRef<AbortController | null>(null)
  const lookup = useRef<Map<string, T>>(new Map())
  const treeRef = useRef(tree)
  treeRef.current = tree
  const currentRef = useRef(current)
  currentRef.current = current
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  const hasTree = tree !== undefined

  useEffect(() => {
    abort.current = new AbortController()
    return () => abort.current?.abort()
  }, [scopeKey])

  const flat = useMemo(() => (tree ? flattenTree(items, getId, tree, current.expanded, current.children) : null), [items, getId, tree, current])
  lookup.current = flat?.byId ?? lookup.current

  const controller = useMemo<TreeController | null>(() => {
    if (!hasTree) return null
    const patch = (update: (draft: TreeState<T>) => void) =>
      setState(prev => {
        const scope = scopeRef.current
        const base = prev.scope === scope ? prev : emptyState<T>(scope)
        const next: TreeState<T> = { scope, expanded: new Set(base.expanded), children: new Map(base.children) }
        update(next)
        return next
      })
    const load = (id: string, row: T) => {
      const loader = treeRef.current?.loadChildren
      const signal = abort.current?.signal
      if (!loader || !signal) return
      patch(draft => draft.children.set(id, { status: 'loading' }))
      loader(row, signal)
        .then(rows => {
          if (signal.aborted) return
          patch(draft => draft.children.set(id, { status: 'ready', rows: rows.slice(0, TREE_CHILD_LIMIT), truncated: rows.length > TREE_CHILD_LIMIT }))
        })
        .catch(() => {
          if (signal.aborted) return
          patch(draft => draft.children.set(id, { status: 'error' }))
        })
    }
    return {
      toggle: id => {
        const row = lookup.current.get(id)
        if (!row) return
        const now = currentRef.current
        const failed = now.children.get(id)?.status === 'error'
        if (now.expanded.has(id) && !failed) {
          patch(draft => draft.expanded.delete(id))
          return
        }
        patch(draft => draft.expanded.add(id))
        const options = treeRef.current
        if (options && !options.getChildren?.(row) && (!now.children.has(id) || failed)) load(id, row)
      },
    }
  }, [hasTree])

  return { rows: flat?.rows ?? items, controller, truncatedParents: flat?.truncatedParents ?? 0 }
}

/** 第一列的缩进与展开按钮；其余内容仍由列自己的渲染器负责。 */
export function TreeCell(params: ICellRendererParams & { inner?: (p: ICellRendererParams) => ReactNode }) {
  const row = params.data as Partial<TreeMeta> & { [key: string]: unknown }
  const controller = (params.context as { tree?: TreeController } | undefined)?.tree
  const depth = row.__depth ?? 0
  const state = row.__treeState ?? 'collapsed'
  const label = state === 'expanded' ? '收起子行' : state === 'error' ? '子行加载失败，点击重试' : state === 'loading' ? '正在加载子行' : '展开子行'
  const content = params.inner ? params.inner(params) : (params.valueFormatted ?? (params.value as ReactNode))
  return (
    <span className="erp-tree-cell" style={{ paddingInlineStart: depth * 16 }}>
      {row.__hasChildren ? (
        <button
          type="button"
          className="erp-tree-toggle"
          aria-label={label}
          aria-expanded={state === 'expanded'}
          disabled={state === 'loading'}
          onClick={() => controller?.toggle(params.node.id ?? '')}
        >
          {state === 'loading' ? <LoadingOutlined /> : state === 'expanded' ? <DownOutlined /> : <RightOutlined />}
        </button>
      ) : (
        <span className="erp-tree-toggle-gap" />
      )}
      <span className={state === 'error' ? 'erp-tree-error' : undefined}>{content}</span>
    </span>
  )
}
