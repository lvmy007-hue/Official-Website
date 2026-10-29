import type { ColDef } from 'ag-grid-community'

// 表格共用类型（P6-02，15 章第 6 节）：列定义在 AG Grid 的 ColDef 上加三个我们自己的键，进入 AG Grid 之前由 grid-columns 剥掉。

/** 异步列的返回形状：`rows[行编号][字段]`；响应里缺的行按“没有记录”处理，不算失败。 */
export type AsyncRowsResponse = { rows: Record<string, Record<string, unknown>> }

export type AsyncColumnSpec = {
  /** 同一个 key 的多列共用一次请求。 */
  key: string
  /** 按可见行批量取；rowIds 一次不超过 ASYNC_BATCH_MAX 个。 */
  fetch: (rowIds: string[], signal: AbortSignal) => Promise<AsyncRowsResponse>
}

export type ErpColDef<T> = ColDef<T> & {
  /** 固定列：商品信息列固定在左，操作列固定在右。 */
  pin?: 'left' | 'right'
  /** 两层表头的第一层名称；相邻且同名的列并成一组，列配置面板按组折叠。 */
  group?: string
  /** 慢列：主数据返回后按可见行单独请求，先显示占位。异步列不参与排序。 */
  async?: AsyncColumnSpec
  /** 指标字典键（如 M-206）：列头显示问号，定义、公式、来源、刷新频率、口径版本与三个链接都从字典取，页面不写口径文案。 */
  metric?: string
}

/** 列标识：优先 colId，其次字段名（和 AG Grid 的取法一致）。 */
export const columnId = <T>(col: ErpColDef<T>): string => col.colId ?? (typeof col.field === 'string' ? col.field : '')

/** 汇总接口的返回形状；金额列币种随行变化时，由服务端在 currency 里给出汇总币种，没有就显示“—”。 */
export type GridSummaryResponse = { totals: Record<string, number | null>; currency?: string | null }
export type FetchSummary = (args: { signal: AbortSignal }) => Promise<GridSummaryResponse>

/** 页码分页的服务端约定：page 从 1 开始。 */
export type PageFetchArgs = { page: number; pageSize: number; sort: { field: string; direction: 'asc' | 'desc' } | null; signal: AbortSignal }
export type PageFetchResult<T> = { items: T[]; total: number }
export type PageFetcher<T> = (args: PageFetchArgs) => Promise<PageFetchResult<T>>

/** 分页每页条数的可选值（15 章第 6 节）。 */
export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const
export const DEFAULT_PAGE_SIZE = 50
/** 页码分页一次最多跳到的页码，防止手输一个巨大页码把服务端的偏移查询拖慢。 */
export const MAX_PAGE_NUMBER = 10000
