import type { GridFilterValue, GridViewConfig } from '@nova/api-contracts'
import { columnId, type ErpColDef } from './grid-types'

// 表格视图的纯函数（P6-03）：把视图里的顺序、列宽、固定套到页面列上；数“有多少项已失效”；比较两份视图内容。
// 不碰界面状态，便于单测。视图里引用了已不存在的列或排序字段，一律忽略并计数，不报错（14 章 P6-03 风险一条）。

/** 按视图重排列并覆盖列宽、固定；没出现在视图里的列保持页面默认顺序，排在已排好的列后面。页面自己固定的列（pin）不被改动。 */
export function applyLayout<T>(columns: readonly ErpColDef<T>[], config: GridViewConfig): ErpColDef<T>[] {
  const rank = new Map(config.order.map((id, index) => [id, index]))
  const decorated = columns.map((col, index) => {
    const id = columnId(col)
    const width = config.widths[id]
    const side = config.pinned[id]
    const next: ErpColDef<T> = { ...col }
    if (width !== undefined) next.width = width
    if (side && !col.pin) next.pin = side
    return { col: next, rank: rank.get(id) ?? Number.POSITIVE_INFINITY, index }
  })
  if (rank.size === 0) return decorated.map(item => item.col)
  return decorated.sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank)).map(item => item.col)
}

/** 视图里引用了、但页面里已经没有的东西的个数：隐藏、顺序、列宽、固定里的列，加上不可排序的排序字段。 */
export function countInvalid(config: GridViewConfig, columnIds: readonly string[], sortFields: readonly string[] | null): number {
  const known = new Set(columnIds)
  let invalid = 0
  for (const id of [...config.hidden, ...config.order, ...Object.keys(config.widths), ...Object.keys(config.pinned)]) if (!known.has(id)) invalid += 1
  if (config.sort && sortFields && !sortFields.includes(config.sort.field)) invalid += 1
  return invalid
}

/** 去掉已失效的列（视图里留着它们没有意义，且会让“是否有修改”误判）。 */
export function dropInvalid(config: GridViewConfig, columnIds: readonly string[], sortFields: readonly string[] | null): GridViewConfig {
  const known = new Set(columnIds)
  const keep = (ids: string[]) => ids.filter(id => known.has(id))
  const pick = <V>(record: Record<string, V>) => Object.fromEntries(Object.entries(record).filter(([id]) => known.has(id)))
  return {
    ...config,
    hidden: keep(config.hidden),
    order: keep(config.order),
    widths: pick(config.widths),
    pinned: pick(config.pinned),
    sort: config.sort && (!sortFields || sortFields.includes(config.sort.field)) ? config.sort : null,
  }
}

const sortedEntries = (record: Record<string, unknown>) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** 两份视图内容是否一样（隐藏列与筛选的次序不影响；顺序与排序的先后有影响）。 */
export function sameConfig(a: GridViewConfig, b: GridViewConfig): boolean {
  const set = (list: string[]) => [...list].sort().join('\u0000')
  return (
    set(a.hidden) === set(b.hidden) &&
    a.order.join('\u0000') === b.order.join('\u0000') &&
    JSON.stringify(sortedEntries(a.widths)) === JSON.stringify(sortedEntries(b.widths)) &&
    JSON.stringify(sortedEntries(a.pinned)) === JSON.stringify(sortedEntries(b.pinned)) &&
    JSON.stringify(a.sort) === JSON.stringify(b.sort) &&
    JSON.stringify(sortedEntries(a.filters)) === JSON.stringify(sortedEntries(b.filters)) &&
    a.dimension === b.dimension
  )
}

/** 页面把当前筛选与维度交给表格保存进视图；套用视图时由页面把它们还原。 */
export type ViewFilterBinding = {
  value: Record<string, GridFilterValue>
  dimension?: string | null
  /** 套用视图里的筛选与维度（页面默认值要补上）；返回被忽略的条件个数（引用了已删除的店铺、成员，或页面不认识的键）。 */
  apply: (filters: Record<string, GridFilterValue>, dimension: string | null) => number
}

/** 工作中的视图内容：用页面当前的筛选与维度覆盖视图里存的那两项。 */
export function withBinding(config: GridViewConfig, binding: ViewFilterBinding | undefined): GridViewConfig {
  if (!binding) return config
  return { ...config, filters: { ...binding.value }, dimension: binding.dimension ?? null }
}

/** 用户在表格上拖列、拉宽后的版式变化。 */
export type LayoutEvent = { order?: string[]; widths?: Record<string, number> }

type ColumnEventLike = {
  type: string
  finished: boolean
  source: string
  columns: ReadonlyArray<{ getColId(): string; getActualWidth(): number }> | null
  api: { getColumnState(): ReadonlyArray<{ colId: string }> }
}

/**
 * 把 AG Grid 的“列被拖动 / 拉宽”事件变成版式变化。只认人手操作（source 以 ui 开头）且已松手：
 * 列定义刷新（gridOptionsChanged）、接口调用（api）产生的事件不算，免得保存了并非用户做的改动。
 */
export function layoutEventOf(event: ColumnEventLike): LayoutEvent | null {
  if (!event.finished || !event.source.startsWith('ui')) return null
  if (event.type === 'columnMoved') return { order: event.api.getColumnState().map(state => state.colId) }
  if (event.type === 'columnResized' && event.columns && event.columns.length > 0) {
    return { widths: Object.fromEntries(event.columns.map(column => [column.getColId(), Math.round(column.getActualWidth())])) }
  }
  return null
}

/** 界面上提示“有 N 个条件已失效”的文字。 */
export const invalidNotice = (count: number) => `有 ${count} 个条件已失效，已忽略`
