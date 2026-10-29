import type { FreshnessViewStatus } from './freshness.js'
import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 促销与优惠券（P4-05，04 章 4.8，importers.md I-17 / R-40 / R-41）：亚马逊 Promotions API v2025-12-01 的只读同步，加上促销绩效与优惠券绩效两份报告。
// 本文件放常量、标签、响应类型与几个纯函数（不含 zod，前端首屏会引用）；查询校验在 promotions-query.ts，估算口径在 promotions-math.ts。
// 官方接口只有三个查询操作（搜索促销、取单个促销、取促销的商品清单），没有创建、修改、取消，所以本系统不提供任何写入口（freeze/verification-log.md 第 11 条）。

export const PROMOTIONS_READ = 'analytics.read'
export const PROMOTIONS_SYNC_JOB = 'PROMOTIONS_SYNC'
export const PROMOTIONS_FRESHNESS_KEY = 'promotions.api'
export const PROMOTION_REPORT_TYPE = 'GET_PROMOTION_PERFORMANCE_REPORT'
export const COUPON_REPORT_TYPE = 'GET_COUPON_PERFORMANCE_REPORT'
export const PROMOTION_REPORT_FRESHNESS_KEY = 'rpt.promotion-performance'
export const COUPON_REPORT_FRESHNESS_KEY = 'rpt.coupon-performance'
/** 接口没有授权（403）时同步任务使用的通用失败码，新鲜度状态为“未授权”。 */
export const PROMOTIONS_ROLE_MISSING = 'ROLE_MISSING'
export const PROMOTIONS_ROLE_GUIDE =
  '亚马逊促销接口需要为应用授权对应角色：在亚马逊开发者控制台的应用资料里勾选该接口文档所列的角色并提交审核，审核通过后到连接中心重新授权店铺，促销会在下一次同步（每日）出现。'
export const PROMOTIONS_WRITE_NOTE = '亚马逊促销接口（2025-12-01 版）只提供查询，不支持创建、修改或取消促销：这里只读。请到卖家后台“促销”页面创建或调整促销，改动会在下一次同步后出现在这里。'

/** 商品清单与绩效明细的读取上限：超过时标注“只显示前若干条”。 */
export const PROMOTION_ITEM_ROW_LIMIT = 500
/** 基线：活动开始前取多少天，至少要有多少个有效日才给估算（D-06）。 */
export const PROMOTION_BASELINE_DAYS = 28
export const PROMOTION_BASELINE_MIN_DAYS = 14
/** 平台费用归集：费用事件的类型或子类型里含这些关键字（不区分大小写），且分类是“其他平台费用”。关键字是按亚马逊交易名整理的启发式，未逐条核对。 */
export const PROMOTION_FEE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  DEAL: ['deal'],
  COUPON: ['coupon'],
  PRICE_DISCOUNT: [],
  BASKET_BUILDING: [],
}

export const PROMOTION_TYPES = ['DEAL', 'COUPON', 'PRICE_DISCOUNT', 'BASKET_BUILDING'] as const
export type PromotionType = (typeof PROMOTION_TYPES)[number]
export const PROMOTION_TYPE_LABEL: Readonly<Record<PromotionType, string>> = {
  DEAL: '秒杀',
  COUPON: '优惠券',
  PRICE_DISCOUNT: '价格折扣',
  BASKET_BUILDING: '满减',
}
/** 亚马逊新增了我们不认识的类型时，显示原值而不是猜一个中文。 */
export const promotionTypeLabel = (type: string): string => PROMOTION_TYPE_LABEL[type as PromotionType] ?? `其他类型（${type}）`

export const PROMOTION_STATUSES = ['PROCESSING', 'UPCOMING', 'RUNNING', 'EXPIRED', 'FAILED', 'CANCELLING', 'CANCELLED'] as const
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number]
export const PROMOTION_STATUS_LABEL: Readonly<Record<PromotionStatus, string>> = {
  PROCESSING: '处理中',
  UPCOMING: '即将开始',
  RUNNING: '进行中',
  EXPIRED: '已结束',
  FAILED: '失败',
  CANCELLING: '取消中',
  CANCELLED: '已取消',
}
export const promotionStatusLabel = (status: string): string => PROMOTION_STATUS_LABEL[status as PromotionStatus] ?? `其他状态（${status}）`
/** 状态标签颜色（antd Tag 的 color）。 */
export const PROMOTION_STATUS_TONE: Readonly<Record<PromotionStatus, string>> = {
  PROCESSING: 'processing',
  UPCOMING: 'blue',
  RUNNING: 'success',
  EXPIRED: 'default',
  FAILED: 'error',
  CANCELLING: 'warning',
  CANCELLED: 'default',
}
/** 不会产生销售效果的状态：效果与利润页签直接说明，不去算基线。 */
export const PROMOTION_NO_EFFECT_STATUSES: readonly string[] = ['FAILED', 'CANCELLED', 'PROCESSING']

export const PROMOTION_COUPON_TYPE_LABEL: Readonly<Record<string, string>> = { STANDARD: '标准优惠券', SUBSCRIBE_AND_SAVE: '订阅省优惠券', REORDER_REWARDS: '复购奖励优惠券' }

export const PROMOTION_TABS = ['effect', 'items', 'cost', 'profit', 'issues', 'ads'] as const
export type PromotionTab = (typeof PROMOTION_TABS)[number]
export const PROMOTION_TAB_LABEL: Readonly<Record<PromotionTab, string>> = { effect: '效果', items: '商品', cost: '成本', profit: '利润', issues: '问题', ads: '广告' }

// ---- 展示文字 ----

const money = (amount: number, currency: string | null | undefined) => `${currency && currency !== 'USD' ? `${currency} ` : '$'}${amount.toFixed(2)}`
const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const recordOf = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** 折扣力度文字（促销级或商品级的 discount 对象）：百分比、固定金额、赠品。认不出来就返回 null（页面写“未提供”）。 */
export function discountTextOf(value: unknown): string | null {
  const discount = recordOf(value)
  if (!discount) return null
  const percent = numberOf(discount.percentOff)
  const amount = numberOf(discount.amountOff)
  if (discount.type === 'PERCENTAGE_OFF' && percent !== null) return `立减 ${percent}%`
  if (discount.type === 'AMOUNT_OFF' && amount !== null) return `立减 ${money(amount, typeof discount.currencyCode === 'string' ? discount.currencyCode : null)}`
  if (discount.type === 'FREE_ITEM') return '赠品'
  return null
}

/** 促销级折扣力度（benefitJson）：有阶梯时在后面注明档数。 */
export function benefitTextOf(benefit: unknown): string | null {
  const record = recordOf(benefit)
  if (!record) return null
  const base = discountTextOf(record.discount)
  const tiers = Array.isArray(record.additionalTiers) ? record.additionalTiers.length : 0
  if (!base) return tiers > 0 ? `${tiers + 1} 档阶梯` : null
  return tiers > 0 ? `${base}（另有 ${tiers} 档阶梯）` : base
}

/** 商品级折扣力度：固定价或折扣价。 */
export function itemBenefitText(row: {
  benefitType: string | null
  discountType: string | null
  percentOff: number | null
  amountOff: number | null
  fixedPrice: number | null
  currency: string | null
}): string | null {
  if (row.benefitType === 'FIXED_PRICE' && row.fixedPrice !== null) return `固定价 ${money(row.fixedPrice, row.currency)}`
  if (row.discountType === 'PERCENTAGE_OFF' && row.percentOff !== null) return `立减 ${row.percentOff}%`
  if (row.discountType === 'AMOUNT_OFF' && row.amountOff !== null) return `立减 ${money(row.amountOff, row.currency)}`
  if (row.discountType === 'FREE_ITEM') return '赠品'
  return null
}

export function budgetTextOf(budget: PromotionBudget | null): string | null {
  if (!budget) return null
  return budget.type === 'UNITS' ? `${budget.value} 件` : money(budget.value, budget.currency)
}

// ---- 响应 ----

/** 同步状态：页面据此区分“没有促销”“还没同步”“接口角色没批”。 */
export interface PromotionSync {
  status: FreshnessViewStatus
  statusLabel: string
  lastSuccessAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** 接口角色未获批（失败码 ROLE_MISSING）。 */
  rolePending: boolean
}

export interface PromotionBudget {
  type: string
  value: number
  currency: string | null
}

export interface PromotionIssue {
  code: string
  message: string
  severity: string
  /** 只有商品级问题带：出问题的 ASIN / SKU。 */
  asin?: string | null
  sku?: string | null
}

/** 来自促销绩效报告 / 优惠券绩效报告的汇总；报告还没同步或没有这个促销的行时不给数字。 */
export interface PromotionReported {
  state: 'OK' | 'NO_RECORD' | 'NOT_CONNECTED'
  units: number | null
  sales: number | null
  redemptions: number | null
}

export interface PromotionPlatformFee {
  /** INCOMPLETE：同期费用事件太多没有读完，不给不完整的数字。 */
  state: 'OK' | 'NO_DATA' | 'RESTRICTED' | 'NO_ITEMS' | 'NOT_APPLICABLE' | 'INCOMPLETE'
  /** 美元，正数 = 花掉的钱。 */
  amount: number | null
}

export interface PromotionRow {
  id: string
  promotionId: string
  sellerAccountId: string
  storeName: string
  type: string
  typeLabel: string
  couponType: string | null
  title: string
  status: string
  statusLabel: string
  revisionStatus: string | null
  startAt: string | null
  endAt: string | null
  /** 商品数；还没取回商品清单时为 null，页面写“尚未同步”，不写 0。 */
  itemCount: number | null
  selectionType: string | null
  itemsTruncated: boolean
  discountText: string | null
  budget: PromotionBudget | null
  errorCount: number
  warningCount: number
  reported: PromotionReported
  platformFee: PromotionPlatformFee
}

export type PromotionListState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'ROLE_PENDING'

export interface PromotionListResponse {
  state: PromotionListState
  note: string | null
  items: PromotionRow[]
  pageInfo: CursorPageInfo
  sync: PromotionSync
  freshness: InventoryFreshness
  /** 平台费用与绩效数字的口径说明（列表头部显示一行）。 */
  basis: string
}

export type PromotionSectionState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED' | 'NOT_STARTED' | 'NO_EFFECT' | 'NO_ITEMS' | 'INSUFFICIENT'

export interface PromotionDay {
  date: string
  actualUnits: number | null
  actualSales: number | null
  baselineUnits: number | null
  baselineSales: number | null
  reportedUnits: number | null
  reportedSales: number | null
}

export interface PromotionBaselineInfo {
  state: 'OK' | 'INSUFFICIENT' | 'NONE'
  /** 参与估算的有效日数 / 因同期其他促销或没有数据而排除的日数。 */
  usedDays: number
  excludedDays: number
  from: string | null
  to: string | null
}

export interface PromotionEffectSection {
  state: PromotionSectionState
  note: string | null
  /** 活动期间（开始日到结束日或今天，取较早者）。 */
  window: { from: string; to: string; days: number } | null
  baseline: PromotionBaselineInfo
  actual: { units: number | null; sales: number | null }
  expected: { units: number | null; sales: number | null }
  incremental: { units: number | null; sales: number | null; liftPct: number | null }
  reported: PromotionReported & { clips: number | null; budgetSpent: number | null; note: string | null }
  daily: PromotionDay[]
}

export interface PromotionItemRow {
  asin: string
  sku: string
  productId: string | null
  productTitle: string | null
  benefitText: string | null
  perCustomerUses: number | null
  budgetText: string | null
  issues: PromotionIssue[]
}

export interface PromotionItemsSection {
  state: PromotionSectionState
  note: string | null
  selectionType: string | null
  total: number | null
  truncated: boolean
  items: PromotionItemRow[]
}

export interface PromotionFeeLine {
  label: string
  amount: number
  count: number
}

export interface PromotionFeePreview {
  upfront: { amount: number; currency: string; frequency: string } | null
  variablePct: number | null
  capAmount: number | null
}

export interface PromotionCostSection {
  state: PromotionSectionState
  note: string | null
  currency: 'USD'
  discount: { state: 'OK' | 'NO_DATA' | 'RESTRICTED'; amount: number | null; orderLines: number; note: string | null }
  platformFee: { state: 'OK' | 'NO_DATA' | 'RESTRICTED' | 'NOT_APPLICABLE'; amount: number | null; lines: PromotionFeeLine[]; note: string | null }
  total: number | null
  feePreview: PromotionFeePreview | null
}

export interface PromotionProfitSection {
  state: PromotionSectionState
  note: string | null
  currency: 'USD'
  actualProfit: number | null
  expectedProfit: number | null
  incrementalProfit: number | null
  roi: { value: number | null; denominator: number | null; formula: string }
}

export interface PromotionIssuesSection {
  state: 'OK' | 'NO_DATA'
  note: string | null
  promotionIssues: PromotionIssue[]
  itemIssueCount: number
  latestRevision: { status: string; note: string } | null
}

export interface PromotionAdsRow {
  asin: string
  spend: number | null
  sales: number | null
  orders: number | null
  enabledAds: number
  totalAds: number
}

export interface PromotionAdsSection {
  state: PromotionSectionState
  note: string | null
  totals: { spend: number | null; sales: number | null; orders: number | null }
  items: PromotionAdsRow[]
  truncated: boolean
}

export interface PromotionDetailResponse {
  promotion: PromotionRow & { mappingId: string | null; benefitTextFull: string | null; createdAt: string | null; updatedAt: string; marketplaceId: string }
  effect: PromotionEffectSection
  items: PromotionItemsSection
  cost: PromotionCostSection
  profit: PromotionProfitSection
  issues: PromotionIssuesSection
  ads: PromotionAdsSection
  /** 本系统不写入：亚马逊接口不支持修改促销。 */
  write: { supported: false; note: string }
  /** 口径说明：基线法与 ROI 公式，页面常驻显示，避免把估算当事实。 */
  methodNote: string
  sync: PromotionSync
  freshness: InventoryFreshness
}

export const PROMOTION_LIST_BASIS = '绩效数字来自亚马逊促销绩效报告与优惠券绩效报告（按映射编号关联）；平台费用按所选商品与活动期间从费用事件里归集，同一商品同期有多个同类促销时可能重复计入。'
export const PROMOTION_METHOD_NOTE =
  `增量按基线法估算：取活动开始前 ${PROMOTION_BASELINE_DAYS} 天、剔除同期有其他促销或没有数据的日子、按星期对齐的日均，与活动期间实际对比；有效日不足 ${PROMOTION_BASELINE_MIN_DAYS} 天不估算。` +
  '促销投入回报率 = 增量毛利 ÷（折扣成本 + 平台费用），是模型估算，不是亚马逊给的数字，也不能证明因果。'

/** 列表页整体状态：有行就是 OK；没有行时按同步状态区分，不把“没同步”说成“没有促销”。 */
export function promotionListState(sync: PromotionSync, hasRows: boolean): { state: PromotionListState; note: string | null } {
  if (hasRows) return { state: 'OK', note: null }
  if (sync.rolePending) return { state: 'ROLE_PENDING', note: PROMOTIONS_ROLE_GUIDE }
  if (sync.status === 'NO_RECORD' || sync.status === 'NOT_CONNECTED') return { state: 'NOT_CONNECTED', note: '促销尚未同步：店铺授权后每日同步一次' }
  if (sync.status === 'NORMAL' || sync.status === 'DELAYED') return { state: 'NO_DATA', note: '尚无记录：亚马逊促销接口里没有这个店铺的促销' }
  return { state: 'NOT_CONNECTED', note: sync.errorMessage ?? '促销同步没有成功，暂时没有可显示的数据' }
}
