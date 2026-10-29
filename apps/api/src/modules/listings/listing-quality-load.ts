import {
  LISTING_ACTOR_LABEL,
  LISTING_QUALITY_LIMITS,
  estimateIssueImpact,
  listingAdviceOf,
  listingFieldLabel,
  listingIssueStatusOf,
  listingRestrictionReasonLabel,
  type ListingActor,
  type ListingChangeKind,
  type ListingChangeRow,
  type ListingImpact,
  type ListingInactiveRow,
  type ListingIssueKind,
  type ListingIssueRow,
  type ListingQualityTab,
  type ListingRestrictionRow,
  type ListingSeverity,
} from '@nova/api-contracts'
import type { ListingChangeEvent, ListingIssue, ListingSnapshot, ListingWriteRun, Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { type ResolvedScope, storeWhere } from '../auth'

// 刊登质量的数据读取与行转换（P4-10）。这里只读本系统自己的表：刊登问题、当前状态、变更事件、查询记录，加上商品身份（标题、图片、负责人）与销售汇总（影响估算）。

export const QUALITY_ROW_LIMIT = 5000
const DAY_MS = 86_400_000
const SALES_BATCH = 10

export interface ProductRef {
  id: string
  title: string
  imageUrl: string | null
  ownerUserId: string | null
}
export type ProductMap = Map<string, ProductRef>
export const productKey = (storeId: string, value: string) => `${storeId}|${value}`

/** 问题类页签的筛选条件：状态默认是“未解决”（新增 + 处理中）。 */
export function issueWhere(tenantId: string, scope: ResolvedScope, tab: ListingQualityTab, filters: { severity?: string; status?: string; impact?: string }): Prisma.ListingIssueWhereInput {
  const and: Prisma.ListingIssueWhereInput[] = []
  if (tab === 'suppressed') and.push({ OR: [{ issueKind: 'SEARCH_SUPPRESSED' }, { impact: 'SEARCH_SUPPRESSED' }] })
  else if (tab === 'missing') and.push({ issueKind: { in: ['ISSUE', 'COMPLIANCE'] }, category: 'MISSING_ATTRIBUTE' })
  else and.push({ issueKind: { in: ['ISSUE', 'COMPLIANCE'] } })
  const status = filters.status ?? 'OPEN'
  if (status === 'OPEN') and.push({ resolvedAt: null })
  else if (status === 'NEW') and.push({ resolvedAt: null, handlingStatus: 'OPEN' })
  else if (status === 'IN_PROGRESS') and.push({ resolvedAt: null, handlingStatus: 'IN_PROGRESS' })
  else if (status === 'RESOLVED') and.push({ resolvedAt: { not: null } })
  return { tenantId, ...storeWhere(scope), ...(filters.severity ? { severity: filters.severity } : {}), ...(filters.impact ? { impact: filters.impact } : {}), AND: and }
}

export const issueOrderBy = (field: string, dir: 'asc' | 'desc'): Prisma.ListingIssueOrderByWithRelationInput[] => {
  const column = field === 'lastSeen' ? 'lastSeenAt' : field === 'severity' ? 'severity' : field === 'sku' ? 'sellerSku' : 'firstSeenAt'
  return [{ [column]: dir }, { firstSeenAt: 'desc' }, { id: 'asc' }]
}

/** 商品身份：按（店铺，SKU）与（店铺，ASIN）两种键都能查到（变更事件有的只有 ASIN）。 */
export async function loadProducts(prisma: PrismaService, tenantId: string, refs: ReadonlyArray<{ storeId: string; sku: string; asin: string }>): Promise<ProductMap> {
  const skus = [...new Set(refs.map(ref => ref.sku).filter(Boolean))]
  const asins = [...new Set(refs.map(ref => ref.asin).filter(Boolean))]
  const map: ProductMap = new Map()
  if (skus.length === 0 && asins.length === 0) return map
  const found = await prisma.fbaProduct.findMany({
    where: { tenantId, OR: [...(skus.length ? [{ sellerSku: { in: skus } }] : []), ...(asins.length ? [{ asin: { in: asins } }] : [])] },
    select: { id: true, sellerAccountId: true, sellerSku: true, asin: true, title: true, imageUrl: true, ownerUserId: true },
    take: QUALITY_ROW_LIMIT * 2,
  })
  for (const item of found) {
    const ref: ProductRef = { id: item.id, title: item.title, imageUrl: item.imageUrl, ownerUserId: item.ownerUserId }
    map.set(productKey(item.sellerAccountId, item.sellerSku), ref)
    if (!map.has(productKey(item.sellerAccountId, item.asin))) map.set(productKey(item.sellerAccountId, item.asin), ref)
  }
  return map
}

/** 影响估算用的逐日销售额：只读销售汇总（美元），按（店铺，ASIN）归并；范围从最早的问题出现时间往前推一个存续期。 */
export async function loadSalesByAsin(
  prisma: PrismaService,
  tenantId: string,
  rows: ReadonlyArray<{ storeId: string; asin: string; firstSeenAt: Date }>,
  now: Date,
): Promise<Map<string, Map<string, number>>> {
  const asins = [...new Set(rows.map(row => row.asin).filter(Boolean))]
  const out = new Map<string, Map<string, number>>()
  if (asins.length === 0) return out
  const earliest = rows.reduce((min, row) => Math.min(min, row.firstSeenAt.getTime()), now.getTime())
  const spanDays = Math.min(LISTING_QUALITY_LIMITS.impactMaxSpanDays, Math.ceil((now.getTime() - earliest) / DAY_MS) + 1)
  const start = new Date(now.getTime() - 2 * spanDays * DAY_MS)
  const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  // 单次查询最多 20000 行：每批 10 个 ASIN（回看最多 360 天，同一 ASIN 在 5 家店铺内也装得下），分批读取
  for (let index = 0; index < asins.length; index += SALES_BATCH) {
    const found = await prisma.asinDailySummary.findMany({
      where: { tenantId, asin: { in: asins.slice(index, index + SALES_BATCH) }, currency: 'USD', summaryDate: { gte: from } },
      select: { sellerAccountId: true, asin: true, summaryDate: true, salesAmount: true },
      orderBy: { summaryDate: 'desc' },
      take: 20_000,
    })
    for (const item of found) {
      const key = productKey(item.sellerAccountId, item.asin)
      const day = item.summaryDate.toISOString().slice(0, 10)
      const days = out.get(key) ?? new Map<string, number>()
      days.set(day, (days.get(day) ?? 0) + Number(item.salesAmount))
      out.set(key, days)
    }
  }
  return out
}

export interface RowContext {
  stores: ReadonlyMap<string, string>
  products: ProductMap
  owners: ReadonlyMap<string, string>
  formerLabel: string
  now: Date
}

const iso = (date: Date | null) => (date ? date.toISOString() : null)

export function issueRowOf(row: ListingIssue, ctx: RowContext, sales: ReadonlyMap<string, Map<string, number>> | null): ListingIssueRow {
  const product = ctx.products.get(productKey(row.sellerAccountId, row.sellerSku)) ?? (row.asin ? ctx.products.get(productKey(row.sellerAccountId, row.asin)) : undefined)
  const end = row.resolvedAt ?? ctx.now
  const impact = row.impact as ListingImpact
  return {
    id: row.id,
    storeId: row.sellerAccountId,
    storeName: ctx.stores.get(row.sellerAccountId) ?? '',
    sku: row.sellerSku,
    asin: row.asin,
    productId: product?.id ?? null,
    title: product?.title ?? null,
    imageUrl: product?.imageUrl ?? null,
    kind: row.issueKind as ListingIssueKind,
    code: row.issueCode,
    attributeName: row.attributeName,
    category: row.category,
    severity: row.severity as ListingSeverity,
    impact,
    message: row.message,
    advice: listingAdviceOf({ category: row.category, attributeName: row.attributeName, kind: row.issueKind, impact, severity: row.severity }),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    durationHours: Math.max(0, Math.round(((end.getTime() - row.firstSeenAt.getTime()) / 3_600_000) * 10) / 10),
    status: listingIssueStatusOf(row),
    ownerUserId: product?.ownerUserId ?? null,
    ownerName: product?.ownerUserId ? (ctx.owners.get(product.ownerUserId) ?? ctx.formerLabel) : null,
    estimate: sales ? estimateIssueImpact({ impact, firstSeenAt: row.firstSeenAt, endAt: end, salesByDay: sales.get(productKey(row.sellerAccountId, row.asin)) ?? null }) : null,
  }
}

export function changeRowOf(row: ListingChangeEvent, ctx: RowContext): ListingChangeRow {
  const product = (row.sellerSku ? ctx.products.get(productKey(row.sellerAccountId, row.sellerSku)) : undefined) ?? (row.asin ? ctx.products.get(productKey(row.sellerAccountId, row.asin)) : undefined)
  const actor = row.actorKind as ListingActor
  return {
    id: row.id,
    storeId: row.sellerAccountId,
    storeName: ctx.stores.get(row.sellerAccountId) ?? '',
    sku: row.sellerSku,
    asin: row.asin,
    productId: product?.id ?? null,
    title: product?.title ?? null,
    kind: row.changeKind as ListingChangeKind,
    fieldPath: row.fieldPath,
    fieldLabel: row.fieldPath ? listingFieldLabel(row.fieldPath) : '商品类型',
    before: row.beforeText,
    after: row.afterText,
    actor,
    actorLabel: LISTING_ACTOR_LABEL[actor] ?? LISTING_ACTOR_LABEL.UNKNOWN,
    occurredAt: row.occurredAt.toISOString(),
  }
}

export function inactiveRowOf(row: ListingSnapshot, ctx: RowContext): ListingInactiveRow {
  const product = ctx.products.get(productKey(row.sellerAccountId, row.sellerSku))
  return {
    id: row.id,
    storeId: row.sellerAccountId,
    storeName: ctx.stores.get(row.sellerAccountId) ?? '',
    sku: row.sellerSku,
    asin: row.asin,
    productId: product?.id ?? null,
    title: product?.title ?? row.itemName,
    imageUrl: product?.imageUrl ?? row.mainImageUrl,
    productType: row.productType,
    statuses: row.amazonStatuses,
    statusSince: row.statusSince.toISOString(),
    inactiveDays: Math.max(0, Math.floor((ctx.now.getTime() - row.statusSince.getTime()) / DAY_MS)),
    syncedAt: row.syncedAt.toISOString(),
  }
}

/** 未过期的刊登限制查询结果，每个 ASIN 一行；结果保存在查询记录里，1 小时后不再显示。 */
export function restrictionRowsOf(runs: readonly ListingWriteRun[], ctx: RowContext): ListingRestrictionRow[] {
  const out: ListingRestrictionRow[] = []
  for (const run of runs) {
    const result = (run.resultJson ?? {}) as {
      rows?: Array<{ asin?: string; restricted?: boolean; reasons?: Array<{ code?: string; message?: string; link?: string | null }>; error?: string | null }>
    }
    const condition = String((run.requestJson as { conditionType?: unknown } | null)?.conditionType ?? 'new_new')
    for (const item of result.rows ?? []) {
      out.push({
        runId: run.id,
        storeId: run.sellerAccountId,
        storeName: ctx.stores.get(run.sellerAccountId) ?? '',
        asin: String(item.asin ?? ''),
        conditionType: condition,
        restricted: item.restricted === true,
        reasons: item.error
          ? [{ code: item.error, label: listingRestrictionReasonLabel(item.error), message: '', links: [] }]
          : (item.reasons ?? []).map(reason => ({
              code: String(reason.code ?? 'UNKNOWN'),
              label: listingRestrictionReasonLabel(String(reason.code ?? 'UNKNOWN')),
              message: String(reason.message ?? ''),
              links: reason.link ? [{ title: '去亚马逊处理', url: String(reason.link) }] : [],
            })),
        checkedAt: run.finishedAt?.toISOString() ?? run.createdAt.toISOString(),
        expiresAt: run.expiresAt?.toISOString() ?? '',
      })
    }
  }
  return out
}
