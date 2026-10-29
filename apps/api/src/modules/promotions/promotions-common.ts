import {
  COUPON_REPORT_FRESHNESS_KEY,
  COUPON_REPORT_TYPE,
  PROMOTIONS_FRESHNESS_KEY,
  PROMOTION_REPORT_TYPE,
  PROMOTIONS_ROLE_MISSING,
  PROMOTION_REPORT_FRESHNESS_KEY,
  aggregateFreshness,
  benefitTextOf,
  freshnessSourceOfJobType,
  freshnessSourceOfReport,
  promotionStatusLabel,
  promotionTypeLabel,
  type InventoryFreshness,
  type PromotionBudget,
  type PromotionFeePreview,
  type PromotionIssue,
  type PromotionPlatformFee,
  type PromotionReported,
  type PromotionRow,
  type PromotionSync,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 促销模块的公共部分（P4-05）：选择列、行转换、同步状态与三个数据来源（促销接口、促销绩效报告、优惠券绩效报告）的新鲜度。

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const PROMOTION_SELECT = {
  id: true,
  promotionId: true,
  sellerAccountId: true,
  marketplaceId: true,
  promotionType: true,
  couponType: true,
  title: true,
  status: true,
  revisionStatus: true,
  startAt: true,
  endAt: true,
  amazonCreatedAt: true,
  amazonUpdatedAt: true,
  mappingId: true,
  budgetType: true,
  budgetValue: true,
  budgetCurrency: true,
  benefitJson: true,
  selectionType: true,
  itemCount: true,
  itemsTruncated: true,
  errorCount: true,
  warningCount: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.PromotionSelect
export type PromotionRecord = Prisma.PromotionGetPayload<{ select: typeof PROMOTION_SELECT }>

export const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
export const iso = (value: Date | null) => (value ? value.toISOString() : null)

export const NO_REPORT: PromotionReported = { state: 'NO_RECORD', units: null, sales: null, redemptions: null }
export const NO_FEE: PromotionPlatformFee = { state: 'NO_DATA', amount: null }

export function budgetOf(row: Pick<PromotionRecord, 'budgetType' | 'budgetValue' | 'budgetCurrency'>): PromotionBudget | null {
  const value = num(row.budgetValue)
  return row.budgetType && value !== null ? { type: row.budgetType, value, currency: row.budgetCurrency } : null
}

export function promotionRow(row: PromotionRecord, reported: PromotionReported, platformFee: PromotionPlatformFee): PromotionRow {
  return {
    id: row.id,
    promotionId: row.promotionId,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    type: row.promotionType,
    typeLabel: promotionTypeLabel(row.promotionType),
    couponType: row.couponType,
    title: row.title,
    status: row.status,
    statusLabel: promotionStatusLabel(row.status),
    revisionStatus: row.revisionStatus,
    startAt: iso(row.startAt),
    endAt: iso(row.endAt),
    // 商品清单还没取回时没有可信的条数，页面写“尚未同步”而不是 0
    itemCount: row.itemCount,
    selectionType: row.selectionType,
    itemsTruncated: row.itemsTruncated,
    discountText: benefitTextOf(row.benefitJson),
    budget: budgetOf(row),
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    reported,
    platformFee,
  }
}

/** 数据库里存的问题（促销级或商品级）转成响应里的形状；认不出来的条目丢弃。 */
export function issuesOf(value: unknown): PromotionIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    const item = entry as Record<string, unknown> | null
    if (!item || typeof item.code !== 'string' || typeof item.message !== 'string') return []
    return [
      {
        code: item.code,
        message: item.message,
        severity: item.severity === 'ERROR' ? 'ERROR' : 'WARNING',
        ...(typeof item.asin === 'string' ? { asin: item.asin } : {}),
        ...(typeof item.sku === 'string' ? { sku: item.sku } : {}),
      },
    ]
  })
}

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const amountOf = (value: unknown): { amount: number; currency: string } | null => {
  const item = record(value)
  return item && typeof item.amount === 'number' && Number.isFinite(item.amount) ? { amount: item.amount, currency: typeof item.currencyCode === 'string' ? item.currencyCode : 'USD' } : null
}

/** 亚马逊给的“预览费率”（保存下来的 feeJson）：一次性费用与按销售额的变动费用，字段缺失就不给，不猜。 */
export function feePreviewOf(value: unknown): PromotionFeePreview | null {
  const fee = record(value)
  if (!fee) return null
  const upfront = record(fee.upfrontFee)
  const variable = record(fee.variableFee)
  const rate = amountOf(upfront?.rate)
  const percentage = typeof variable?.salesPercentage === 'number' ? variable.salesPercentage : null
  const cap = amountOf(variable?.feeCapAmount)
  if (!rate && percentage === null && !cap) return null
  return {
    upfront: rate ? { amount: rate.amount, currency: rate.currency, frequency: typeof upfront?.frequency === 'string' ? upfront.frequency : 'UNKNOWN' } : null,
    variablePct: percentage,
    capAmount: cap?.amount ?? null,
  }
}

export interface PromotionSources {
  sync: PromotionSync
  freshness: InventoryFreshness
  /** 两份绩效报告是否至少成功同步过一次（区分“尚未接入”与“报告里没有这个促销”）。 */
  reportConnected: { promotion: boolean; coupon: boolean }
}

/** 范围内店铺的促销同步状态（最差的店铺为准）、新鲜度条所需摘要与报告接入情况。 */
export async function promotionSources(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now = new Date()): Promise<PromotionSources> {
  const specs = [freshnessSourceOfJobType('PROMOTIONS_SYNC'), freshnessSourceOfReport(PROMOTION_REPORT_TYPE), freshnessSourceOfReport(COUPON_REPORT_TYPE)].filter(spec => spec !== undefined)
  const keys = [PROMOTIONS_FRESHNESS_KEY, PROMOTION_REPORT_FRESHNESS_KEY, COUPON_REPORT_FRESHNESS_KEY]
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: { in: keys }, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    }),
  ])
  const views = aggregateFreshness(
    rows,
    stores.map(store => store.id),
    now,
    specs,
  ).sources
  const view = views.find(item => item.sourceKey === PROMOTIONS_FRESHNESS_KEY)
  const connected = (key: string) => rows.some(row => row.sourceKey === key && row.lastSuccessAt !== null)
  const reportConnected = { promotion: connected(PROMOTION_REPORT_FRESHNESS_KEY), coupon: connected(COUPON_REPORT_FRESHNESS_KEY) }
  if (!view) {
    const sync: PromotionSync = { status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false }
    return { sync, freshness: { lastSuccessAt: null, sources: [], qualityIssues: 0 }, reportConnected }
  }
  const sync: PromotionSync = {
    status: view.status,
    statusLabel: view.statusLabel,
    lastSuccessAt: iso(view.lastSuccessAt),
    errorCode: view.errorCode,
    errorMessage: view.errorMessage,
    rolePending: view.errorCode === PROMOTIONS_ROLE_MISSING,
  }
  const healthy = ['NORMAL', 'NOT_APPLICABLE', 'NOT_CONNECTED', 'NO_RECORD']
  const issues = views.filter(item => !healthy.includes(item.status)).length
  return {
    sync,
    freshness: { lastSuccessAt: sync.lastSuccessAt, sources: views.filter(item => item.lastSuccessAt).map(item => item.label), qualityIssues: issues },
    reportConnected,
  }
}
