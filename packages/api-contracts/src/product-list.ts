import type { InventoryFreshness, InventoryRiskLevel } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 商品主数据（P4-07，05 章 5.1；freeze/api.md `/products`、`/products/meta`、`/products/sync`）：一行 = 一个店铺 × SKU（FbaProduct）。
// 本文件放常量、标签、响应类型与纯函数（不含 zod，前端首屏会引用）；请求校验在 product-list-query.ts。
// 负责人与标签是本系统自己的数据（不写亚马逊）；刊登问题数与刊登质量分要等刊登表现、刊登质量上线，现在显示“尚未接入”，不当 0。

export const PRODUCT_READ = 'products.read'
export const PRODUCT_META_WRITE = 'catalog.meta.write'
/** 关注走协作模块的 `POST /watches`，权限是 collab.write（catalog.meta.write 的说明里写了“关注”，但那条接口认的是 collab.write）。 */
export const PRODUCT_WATCH_PERMISSION = 'collab.write'
export const PRODUCT_WATCH_ENTITY = 'ASIN'
export const PRODUCT_SYNC_PERMISSION = 'sync.manage'
export const PRODUCT_EXPORT_PERMISSION = 'export.create'
export const PRODUCT_EXPORT_KIND = 'products'

export const PRODUCT_META_ENTITY_TYPE = 'ASIN'
export const PRODUCT_META_EVENT_KIND = 'product.meta'
export const PRODUCT_META_ACTION = 'PRODUCT_META_UPDATED'
export const PRODUCT_SYNC_ACTION = 'PRODUCT_CATALOG_SYNC_REQUESTED'

export const PRODUCT_TAG_LIMITS = { MAX_TAGS: 20, MAX_LENGTH: 30, BATCH_MAX: 200 } as const
/** 一次“同步商品目录”最多处理的店铺数。 */
export const PRODUCT_SYNC_STORE_MAX = 50
/** 一次最多关注多少个商品（前端逐个调 `/watches`）。 */
export const PRODUCT_WATCH_BATCH_MAX = 50
/** 读取上限：Prisma 单次最多 20000 行，多读一行判断是否被截断。 */
export const PRODUCT_LIST_LIMIT = 19_999
/** 销售与利润的统计窗口：含今天在内的最近 30 天（企业时区）。 */
export const PRODUCT_WINDOW_DAYS = 30
/** 库存风险筛选一次最多评估的库存记录数（与库存健康页一致，超过会标记不完整）。 */
export const PRODUCT_RISK_FILTER_NOTE = '库存风险按库存健康页同一套规则计算（最多评估 5000 条库存记录）；没有生效的库存规则时没有风险结论，筛选结果为空。'

export const PRODUCT_SORTS = ['updatedAt', 'asin', 'sku', 'price', 'sales30', 'units30', 'margin30', 'sellable'] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]
export const PRODUCT_SORT_LABEL: Readonly<Record<ProductSort, string>> = {
  updatedAt: '更新时间',
  asin: 'ASIN',
  sku: '卖家 SKU',
  price: '价格',
  sales30: '近 30 天销售额',
  units30: '近 30 天销量',
  margin30: '近 30 天利润率',
  sellable: '可售数量',
}

export const PRODUCT_LISTING_LABEL: Readonly<Record<string, string>> = { ACTIVE: '在售', INACTIVE: '不可售', INCOMPLETE: '信息不全' }
export const PRODUCT_CHANNEL_LABEL: Readonly<Record<string, string>> = { AFN: '亚马逊物流 FBA', MFN: '自发货 FBM', FBA: '亚马逊物流 FBA', FBM: '自发货 FBM' }
export const PRODUCT_CHANNELS = ['AFN', 'MFN'] as const

export const PRODUCT_BASIS =
  '一行是一个店铺 × SKU。销量与销售额取近 30 天（含今天，企业时区）订单口径、美元，按“店铺 × ASIN”汇总：同店同 ASIN 的多个 SKU 看到的是同一份数字（行上标“同 ASIN 共用”）；' +
  '利润率 = 近 30 天净利润 ÷ 销售额（下单口径），只要有一天缺商品成本就不给利润率；可售数量是库存接口最近一次同步值。没有记录的值显示“尚无记录”，不当 0。'
export const PRODUCT_NOT_CONNECTED_NOTE = '刊登问题数与刊登质量分来自“刊登表现”“刊登质量与合规”（P4-09、P4-10），现在还没有数据来源，所以显示“尚未接入”，对应的筛选也暂不提供。'
export const PRODUCT_COPY_NOTE = '销售与利润数字按店铺 × ASIN 汇总，同店同 ASIN 的多个 SKU 共用同一份。'
export const PRODUCT_ACTIONS_NOTE = '这里只放真实可执行的动作；不提供批量修改刊登（修改刊登在“刊登质量与合规”里按问题逐条处理）。'

export type ProductDataState = 'OK' | 'NO_DATA' | 'RESTRICTED'

export interface ProductListRow {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sku: string
  fnsku: string | null
  title: string
  imageUrl: string | null
  parentAsin: string | null
  brand: string | null
  categoryPath: string | null
  fulfillmentChannel: string
  listingStatus: string
  price: number | null
  currency: string
  /** 可售数量；没有库存记录或没有 inventory.read 为 null。 */
  sellable: number | null
  /** 近 30 天销售额与销量（美元，店铺 × ASIN）；没有记录为 null。 */
  sales30: number | null
  units30: number | null
  /** 同店同 ASIN 在清单里不止一个 SKU：上面的销售数字是共用的。 */
  salesShared: boolean
  /** 近 30 天利润率（0 到 1 的小数）；没有 field.profit 时整个字段不出现，算不出时为 null（原因见 marginState）。 */
  margin30?: number | null
  marginState?: ProductMarginState
  ownerUserId: string | null
  ownerName: string | null
  tags: string[]
  /** 当前成员是否已关注。 */
  watched: boolean
  /** 乐观锁版本号：批量设置负责人与标签时带上。 */
  version: number
  updatedAt: string
  catalogState: 'OK' | 'NOT_FOUND' | 'NOT_SYNCED'
}

export type ProductMarginState = 'OK' | 'NO_SALES' | 'COST_MISSING' | 'NO_RECORD'
export const PRODUCT_MARGIN_STATE_LABEL: Readonly<Record<ProductMarginState, string>> = {
  OK: '',
  NO_SALES: '近 30 天没有销售额',
  COST_MISSING: '缺商品成本，算不出利润',
  NO_RECORD: '尚无利润记录',
}

export interface ProductFilterOptions {
  brands: string[]
  categories: string[]
  statuses: string[]
  tags: string[]
  owners: Array<{ id: string; name: string }>
}

export interface ProductListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: ProductListRow[]
  pageInfo: CursorPageInfo
  window: { from: string; to: string; days: number }
  currency: 'USD'
  stock: { state: ProductDataState; note: string | null }
  profit: { state: ProductDataState; note: string | null }
  filterOptions: ProductFilterOptions
  /** 可设置的负责人候选（在职成员）；没有 catalog.meta.write 时为空数组。 */
  members: Array<{ id: string; name: string }>
  canWrite: boolean
  /** 商品数超过读取上限，只处理了前一部分。 */
  truncated: boolean
  /** 按库存风险筛选时：评估的库存记录是否被截断。 */
  riskTruncated: boolean
  freshness: InventoryFreshness
  notConnected: string
  basis: string
}

// ---- 批量设置负责人与标签 ----

export interface ProductMetaResult {
  updated: number
  unchanged: number
  items: Array<{ id: string; version: number; tags: string[]; ownerId: string | null }>
}

/** 标签合法性：条数与单个长度，不含逗号与控制字符（逗号用来分隔筛选参数）。返回第一条问题；没问题为 null。 */
export function productTagProblem(tags: readonly string[]): string | null {
  if (tags.length > PRODUCT_TAG_LIMITS.MAX_TAGS) return `一个商品最多 ${PRODUCT_TAG_LIMITS.MAX_TAGS} 个标签`
  for (const tag of tags) {
    if (tag.length > PRODUCT_TAG_LIMITS.MAX_LENGTH) return `标签“${tag.slice(0, 8)}…”超过 ${PRODUCT_TAG_LIMITS.MAX_LENGTH} 个字`
    // eslint-disable-next-line no-control-regex
    if (/[,，\u0000-\u001f]/.test(tag)) return `标签“${tag}”含有逗号或不可见字符`
  }
  return null
}

// ---- 同步商品目录 ----

export interface ProductSyncResult {
  jobs: Array<{ storeId: string; storeName: string; jobId: string }>
  skipped: Array<{ storeId: string; storeName: string; reason: string }>
}
export const PRODUCT_SYNC_NO_CONNECTION = '这个店铺没有已授权的亚马逊连接，无法同步'

// ---- 筛选条件（页面与导出共用，保证两边筛出的是同一批商品）----

export interface ProductFilters {
  q?: string
  asin?: string
  sku?: string
  parentAsin?: string
  brand?: string
  category?: string
  status?: string
  fulfillment?: string
  ownerId?: string
  tag?: string
}

const upper = (value: string) => value.toUpperCase()

/**
 * 筛选条件换成 Prisma 查询条件（普通对象，不依赖 Prisma 类型，API 与 worker 都能直接展开）。
 * 范围（企业、店铺、美国站）由调用方另外加；库存风险与“只看已关注”不是商品表的列，在 API 里另行处理。
 */
export function productFilterWhere(filters: ProductFilters): Record<string, unknown> {
  const and: Array<Record<string, unknown>> = []
  if (filters.q) {
    const q = filters.q
    and.push({
      OR: [
        { asin: { startsWith: upper(q) } },
        { sellerSku: { startsWith: q, mode: 'insensitive' } },
        { fnsku: { startsWith: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
      ],
    })
  }
  if (filters.asin) and.push({ asin: { startsWith: upper(filters.asin) } })
  if (filters.sku) and.push({ sellerSku: { startsWith: filters.sku, mode: 'insensitive' } })
  if (filters.parentAsin) and.push({ parentAsin: upper(filters.parentAsin) })
  if (filters.brand) and.push({ brand: { equals: filters.brand, mode: 'insensitive' } })
  if (filters.category) and.push({ categoryPath: { contains: filters.category, mode: 'insensitive' } })
  if (filters.status) and.push({ listingStatus: filters.status })
  if (filters.fulfillment) and.push({ fulfillmentChannel: filters.fulfillment })
  if (filters.ownerId) and.push({ ownerUserId: filters.ownerId })
  if (filters.tag) and.push({ tagIds: { has: filters.tag } })
  return and.length > 0 ? { AND: and } : {}
}

/** 筛选摘要（导出任务与审计里展示）：只写有值的条件。 */
export function describeProductFilters(filters: ProductFilters): string {
  const parts: string[] = []
  if (filters.q) parts.push(`关键词 ${filters.q}`)
  if (filters.asin) parts.push(`ASIN ${filters.asin}`)
  if (filters.sku) parts.push(`SKU ${filters.sku}`)
  if (filters.parentAsin) parts.push(`父体 ${filters.parentAsin}`)
  if (filters.brand) parts.push(`品牌 ${filters.brand}`)
  if (filters.category) parts.push(`类目 ${filters.category}`)
  if (filters.status) parts.push(`状态 ${PRODUCT_LISTING_LABEL[filters.status] ?? filters.status}`)
  if (filters.fulfillment) parts.push(`履约 ${PRODUCT_CHANNEL_LABEL[filters.fulfillment] ?? filters.fulfillment}`)
  if (filters.ownerId) parts.push('指定负责人')
  if (filters.tag) parts.push(`标签 ${filters.tag}`)
  return parts.length > 0 ? parts.join('，') : '全部商品'
}

// ---- 排序与利润率 ----

/** 利润率：净利润 ÷ 销售额；销售额不为正或利润算不出为 null。 */
export function productMargin(profit: number | null, revenue: number | null): number | null {
  if (profit === null || revenue === null || revenue <= 0) return null
  return Math.round((profit / revenue) * 1_000_000) / 1_000_000
}

/** 把统计窗口里的各种“为什么算不出”折成一个状态。 */
export function productMarginState(input: { rows: number; revenue: number; profit: number | null }): ProductMarginState {
  if (input.rows === 0) return 'NO_RECORD'
  if (input.profit === null) return 'COST_MISSING'
  if (input.revenue <= 0) return 'NO_SALES'
  return 'OK'
}

export type ProductRiskLevel = InventoryRiskLevel
