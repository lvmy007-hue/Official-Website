import type { AttributionFactor, DashCompare, DashPeriod, DashState } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'
import type { InventorySuggestion } from './inventory-detail.js'
import type { Asin360ActionRuleView } from './asin360-more.js'

// ASIN 360 契约（P2a-14，05 章 5.2；freeze/api.md `/products/:id*`）。
// 一个商品行（FbaProduct，店铺 × SKU）一页：身份区、关键指标、建议动作、页签。页签随各工作包上线，没上线的不显示（routes.md 2.3.1）。
// 本文件只放常量、纯函数与类型（没有 zod），前端首屏引用不会带上校验代码。

export const ASIN360_TAB_KEYS = ['overview', 'traffic', 'ads', 'inventory', 'economics', 'returns', 'listing', 'reviews', 'pricing', 'competitors', 'content', 'changes'] as const
export type Asin360TabKey = (typeof ASIN360_TAB_KEYS)[number]

export interface Asin360TabSpec {
  key: Asin360TabKey
  label: string
  /** 负责上线的工作包（routes.md 2.3.1）。 */
  workPackage: string
  /** 已上线：只有已上线且当前成员有权限的页签才显示。后续工作包交付页签时把它改成 true。 */
  live: boolean
  /** 进入页签需要的权限（页签数据接口会再校验一次）。 */
  permissions: readonly string[]
}

// 顺序就是页面上的顺序（05 章 5.2 的 12 个页签）。
export const ASIN360_TABS: readonly Asin360TabSpec[] = [
  { key: 'overview', label: '经营表现', workPackage: 'P2a-14', live: true, permissions: ['products.read'] },
  { key: 'traffic', label: '流量转化', workPackage: 'P4-08', live: true, permissions: ['products.read'] },
  { key: 'ads', label: '广告', workPackage: 'P3-19', live: true, permissions: ['products.read', 'ads.read'] },
  { key: 'inventory', label: '库存补货', workPackage: 'P2a-14', live: true, permissions: ['products.read', 'inventory.read'] },
  { key: 'economics', label: '利润与成本', workPackage: 'P2b-17', live: true, permissions: ['products.read', 'profit.read', 'field.profit'] },
  { key: 'returns', label: '退货', workPackage: 'P2b-17', live: true, permissions: ['products.read', 'returns.read'] },
  { key: 'listing', label: '刊登与问题', workPackage: 'P4-08', live: true, permissions: ['products.read', 'listing.read'] },
  { key: 'reviews', label: '评价', workPackage: 'P4-08', live: true, permissions: ['products.read', 'reviews.read'] },
  { key: 'pricing', label: '定价与购物车', workPackage: 'P4-08', live: true, permissions: ['products.read', 'pricing.read'] },
  { key: 'competitors', label: '竞品', workPackage: 'P4-08', live: true, permissions: ['products.read', 'competitors.read'] },
  { key: 'content', label: '内容与 A+', workPackage: 'P4-08', live: true, permissions: ['products.read', 'aplus.read'] },
  { key: 'changes', label: '变更与审计', workPackage: 'P2a-14', live: true, permissions: ['products.read'] },
]

/** 当前成员能看到的页签：已上线且拥有进入权限。 */
export function visibleAsin360Tabs(has: (permission: string) => boolean): Asin360TabSpec[] {
  return ASIN360_TABS.filter(tab => tab.live && tab.permissions.every(has))
}

/** 商品目录同步来源键（freshness.ts 的 JOB_FRESHNESS_SOURCES 登记）。 */
export const CATALOG_SYNC_JOB = 'CATALOG_SYNC'
export const CATALOG_FRESHNESS_KEY = 'catalog.items-v2022'

// ---- 身份区 ----
export interface Asin360Product {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sku: string
  fnsku: string | null
  title: string
  brand: string | null
  productType: string | null
  listingStatus: string
  fulfillmentChannel: string
  price: number | null
  currency: string
  imageUrl: string | null
  categoryPath: string | null
  parentAsin: string | null
  ownerUserId: string | null
  ownerName: string | null
  tags: string[]
}

/** 商品目录（亚马逊 Catalog Items API）核对状态：OK 找到；NOT_FOUND 目录里查无此 ASIN（待核实）；NOT_SYNCED 还没有同步过。 */
export interface Asin360CatalogState {
  state: 'OK' | 'NOT_FOUND' | 'NOT_SYNCED'
  syncedAt: string | null
  note: string | null
}

export interface Asin360Sibling {
  id: string
  sku: string
  fnsku: string | null
  listingStatus: string
}

export interface Asin360Variants {
  parentAsin: string | null
  /** 当前 ASIN 自己是父体时，目录里登记的子体数量。 */
  childCount: number | null
  isParent: boolean
  /** 同父体的其他子体数量（不含自己）；没有父体为 null。 */
  siblingCount: number | null
  variationTheme: string | null
}

export interface Asin360Rank {
  classificationId: string
  name: string
  rank: number
}

export interface Asin360Ranks {
  state: DashState
  note: string | null
  snapshotDate: string | null
  items: Asin360Rank[]
}

/** 库存摘要：来自库存健康（P2a-06）同一套口径；没有库存读权限不返回数字。 */
export interface Asin360Stock {
  state: 'OK' | 'NO_DATA' | 'RESTRICTED'
  note: string | null
  /** 库存记录编号，库存补货页签与库存详情页用。 */
  inventoryId: string | null
  sellable: number | null
  inboundCounted: number | null
  daysOfCover: number | null
  stockoutDate: string | null
  noDemand: boolean
  riskLabel: string | null
}

export interface Asin360IdentityResponse {
  product: Asin360Product
  catalog: Asin360CatalogState
  siblings: Asin360Sibling[]
  variants: Asin360Variants
  ranks: Asin360Ranks
  stock: Asin360Stock
  freshness: InventoryFreshness
}

// ---- 经营表现页签 ----
export const ASIN360_KPI_KEYS = ['sales', 'profit', 'margin', 'conversion', 'adsShare'] as const
export type Asin360KpiKey = (typeof ASIN360_KPI_KEYS)[number]

export interface Asin360KpiCard {
  key: Asin360KpiKey
  label: string
  state: DashState
  format: 'money' | 'percent'
  value: number | null
  compareValue: number | null
  /** 金额用比率（0.12 表示 +12%），百分比类指标用百分点差。 */
  change: number | null
  changeKind: 'ratio' | 'points'
  note: string | null
}

export interface Asin360DailyPoint {
  date: string
  units: number
  sales: number
  profit: number | null
  adsSales: number | null
  sessions: number | null
}

export interface Asin360TableRow {
  key: 'sales' | 'units' | 'unitPrice'
  label: string
  format: 'money' | 'number'
  current: number | null
  previous: number | null
  yoy: number | null
  /** 环比、同比变化比率；对比期为 0 或没有记录时为 null。 */
  momChange: number | null
  yoyChange: number | null
}

export interface Asin360OverviewResponse {
  period: DashPeriod
  compare: DashCompare | null
  previous: DashCompare
  yoy: DashCompare
  /** 没有显式选择时间范围时用默认的近 30 天并对比上一期。 */
  defaulted: boolean
  currency: string
  metricVersion: string | null
  /** 汇总最近一次刷新时间；这个商品在本期没有汇总行为 null。 */
  refreshedAt: string | null
  hasRows: boolean
  cards: Asin360KpiCard[]
  /** 本期逐日（没有记录的日子也列出，件数与销售额为 0 表示“当天没有订单记录”）。 */
  daily: Asin360DailyPoint[]
  /** 对比期销售额，与 daily 按位置对齐；对比期没有记录的日子为 null。 */
  compareSales: Array<number | null>
  table: Asin360TableRow[]
  /** 指标树归因（销售额变化 = 件数 × 件单价）；没有对比期或某个因子为 0 时为 null。 */
  attribution: { mode: 'TWO_FACTOR' | 'THREE_FACTOR'; factors: AttributionFactor[]; unavailable: Array<{ key: string; label: string; reason: string }> } | null
  /** 自然销售与广告销售拆分：广告销售没有接入时只有总销售额。 */
  split: { state: DashState; note: string | null; adsSales: number | null; organicSales: number | null; adsShare: number | null }
  profit: { state: DashState; note: string | null }
  refunds: { state: 'NOT_CONNECTED'; note: string }
}

// ---- 库存补货页签 ----
export interface Asin360InventoryRef {
  state: 'OK' | 'NO_DATA'
  note: string | null
  /** 库存记录编号：页签内的库存结构、在途、补货、上游仓储、库龄与费用直接用库存详情的接口。 */
  inventoryId: string | null
}

// ---- 建议动作区 ----
export interface Asin360ActionsResponse {
  state: 'OK' | 'NO_DATA' | 'RESTRICTED'
  note: string | null
  inventoryId: string | null
  items: InventorySuggestion[]
  /** 05 章 5.2 的 6 条建议规则各自的状态（P4-08）：库存类按库存建议判断，其余没有数据来源的是“尚未接入”。 */
  rules: Asin360ActionRuleView[]
}

// ---- 变更与审计页签 ----
export const ASIN360_CHANGE_SOURCES = ['system', 'amazon', 'manual'] as const
export type Asin360ChangeSource = (typeof ASIN360_CHANGE_SOURCES)[number]
export const ASIN360_CHANGE_SOURCE_LABEL: Record<Asin360ChangeSource, string> = { system: '系统内操作', amazon: '亚马逊侧变更', manual: '手工记录' }

export interface Asin360Change {
  id: string
  source: Asin360ChangeSource
  kind: string
  kindLabel: string
  title: string
  occurredAt: string
  actor: string
  /** 变更前后的取值（事件带 before/after 时才有，用于展开对照）。 */
  before: string | null
  after: string | null
}

export interface Asin360ChangesResponse {
  items: Asin360Change[]
  truncated: boolean
}
