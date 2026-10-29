// 表格视图（P6-03，14 章 P6-03、15 章第 6 节；freeze/api.md 16.2 的 /grid-views）。
// 本文件不引用 zod：前端表格组件（懒加载页面里）直接取这里的类型、常量与纯函数；带 zod 的请求校验在 grid-view-query.ts，前端不引用。
// 一个视图保存：列显示、顺序、列宽、固定、排序、筛选、维度。分三级：系统（只读，由迁移或系统任务写入）、团队共享、我的。
// 加载时的取舍：视图里引用了已不存在的列或已失效的筛选值，一律忽略并告诉用户“有 N 项已失效”，不报错、不阻塞表格。

export const GRID_VIEW_KINDS = ['VIEW', 'FILTER'] as const
export type GridViewKind = (typeof GRID_VIEW_KINDS)[number]
export const GRID_VIEW_SCOPES = ['SYSTEM', 'USER', 'TEAM'] as const
export type GridViewScope = (typeof GRID_VIEW_SCOPES)[number]

/** 每个人在同一个表格、同一类型下最多保存的个人视图数。 */
export const GRID_VIEW_USER_LIMIT = 20
/** 同一个表格、同一类型下最多的团队共享视图数；个人 20 + 团队 30 = 50，对应“每个表格上限 50 条”。 */
export const GRID_VIEW_TEAM_LIMIT = 30
export const GRID_VIEW_NAME_MAX = 40
/** 第一次加载时把本机旧列配置迁成的个人默认视图的名称。 */
export const MIGRATED_VIEW_NAME = '我的默认视图'
export const GRID_ID_PATTERN = /^[a-z][a-z0-9.-]{1,59}$/

/** 视图内容的长度上限（读取时同样套用，防止被改坏的数据拖慢页面）。 */
export const GRID_VIEW_LIMITS = { columns: 200, idLength: 100, widthMin: 40, widthMax: 1200, filters: 50, filterText: 200, filterItems: 100 } as const

export type GridSortSpec = { field: string; direction: 'asc' | 'desc' }
export type GridFilterValue = string | number | boolean | string[]
export type GridViewConfig = {
  /** 隐藏的列标识。 */
  hidden: string[]
  /** 列的显示顺序（列标识）；没出现的列按页面默认顺序排在后面。 */
  order: string[]
  /** 列宽（像素）。 */
  widths: Record<string, number>
  /** 固定列；没出现的列沿用页面默认。 */
  pinned: Record<string, 'left' | 'right'>
  sort: GridSortSpec | null
  /** 筛选条件（页面自己的键）；筛选方案（kind=FILTER）只用这一项。 */
  filters: Record<string, GridFilterValue>
  /** 维度（如“按 SKU / 按 ASIN / 按店铺”），页面自己的取值。 */
  dimension: string | null
}

export const emptyViewConfig = (): GridViewConfig => ({ hidden: [], order: [], widths: {}, pinned: {}, sort: null, filters: {}, dimension: null })

export type GridViewItem = {
  id: string
  gridId: string
  kind: GridViewKind
  scope: GridViewScope
  name: string
  config: GridViewConfig
  isDefault: boolean
  version: number
  /** 是不是当前成员自己的个人视图。 */
  mine: boolean
  /** 当前成员能不能修改、删除、设为默认：个人视图本人可以，团队视图需要共享权限，系统视图谁都不行。 */
  canEdit: boolean
  /** 创建人；系统视图为空。 */
  owner: { id: string; name: string } | null
  updatedAt: string
}

export type GridViewListResponse = { items: GridViewItem[]; canShare: boolean; limits: { user: number; team: number } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const idOf = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= GRID_VIEW_LIMITS.idLength ? value : null)

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.map(idOf).filter((id): id is string => id !== null)
  return [...new Set(ids)].slice(0, GRID_VIEW_LIMITS.columns)
}

function filterValueOf(value: unknown): GridFilterValue | null {
  if (typeof value === 'string') return value.length <= GRID_VIEW_LIMITS.filterText ? value : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.length <= GRID_VIEW_LIMITS.filterText)
    return items.length === value.length && items.length <= GRID_VIEW_LIMITS.filterItems ? items : null
  }
  return null
}

/** 宽容地读出视图内容：只认长度合规的字符串、数字与布尔，其余丢弃；任何输入都返回完整结构，不抛错。 */
export function viewConfigOf(raw: unknown): GridViewConfig {
  const config = emptyViewConfig()
  if (!isRecord(raw)) return config
  config.hidden = idList(raw.hidden)
  config.order = idList(raw.order)
  if (isRecord(raw.widths)) {
    for (const [id, width] of Object.entries(raw.widths).slice(0, GRID_VIEW_LIMITS.columns)) {
      if (idOf(id) && typeof width === 'number' && Number.isFinite(width)) config.widths[id] = Math.min(GRID_VIEW_LIMITS.widthMax, Math.max(GRID_VIEW_LIMITS.widthMin, Math.round(width)))
    }
  }
  if (isRecord(raw.pinned)) {
    for (const [id, side] of Object.entries(raw.pinned).slice(0, GRID_VIEW_LIMITS.columns)) {
      if (idOf(id) && (side === 'left' || side === 'right')) config.pinned[id] = side
    }
  }
  if (isRecord(raw.sort) && idOf(raw.sort.field) && (raw.sort.direction === 'asc' || raw.sort.direction === 'desc')) {
    config.sort = { field: raw.sort.field as string, direction: raw.sort.direction }
  }
  if (isRecord(raw.filters)) {
    for (const [key, value] of Object.entries(raw.filters).slice(0, GRID_VIEW_LIMITS.filters)) {
      const parsed = idOf(key) ? filterValueOf(value) : null
      if (parsed !== null) config.filters[key] = parsed
    }
  }
  config.dimension = typeof raw.dimension === 'string' && raw.dimension.length > 0 && raw.dimension.length <= GRID_VIEW_LIMITS.idLength ? raw.dimension : null
  return config
}

/** 视图里什么都没改（等同页面默认）。 */
export function isViewConfigEmpty(config: GridViewConfig): boolean {
  return (
    config.hidden.length === 0 &&
    config.order.length === 0 &&
    Object.keys(config.widths).length === 0 &&
    Object.keys(config.pinned).length === 0 &&
    config.sort === null &&
    Object.keys(config.filters).length === 0 &&
    config.dimension === null
  )
}

/** 进入表格时用哪个视图：我的默认 → 团队默认 → 系统默认；都没有就用页面自己的默认。 */
export function pickDefaultView<T extends Pick<GridViewItem, 'scope' | 'isDefault'>>(items: readonly T[]): T | null {
  for (const scope of ['USER', 'TEAM', 'SYSTEM'] as const) {
    const found = items.find(item => item.scope === scope && item.isDefault)
    if (found) return found
  }
  return null
}

/** 视图列表的显示顺序：我的、团队、系统各自按名称排，默认视图排在同级最前面。 */
export function sortViews<T extends Pick<GridViewItem, 'scope' | 'isDefault' | 'name'>>(items: readonly T[]): T[] {
  const rank = { USER: 0, TEAM: 1, SYSTEM: 2 } as const
  return [...items].sort((a, b) => rank[a.scope] - rank[b.scope] || Number(b.isDefault) - Number(a.isDefault) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
