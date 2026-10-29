import { PROMOTION_ITEM_ROW_LIMIT, budgetTextOf, itemBenefitText, type PromotionAdsSection, type PromotionIssuesSection, type PromotionItemRow, type PromotionItemsSection } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { AsinAdsCoverageService } from '../ads'
import { issuesOf, num } from './promotions-common'
import { gateOf, PARTIAL_NOTE, type DetailContext } from './promotions-context'

// 促销详情的商品、问题、广告三个页签。商品页签带商品主数据链接（要 products.read），广告页签复用 ASIN 广告覆盖（要 ads.read）。

export type ItemRecord = {
  asin: string
  sku: string
  benefitType: string | null
  discountType: string | null
  percentOff: { toString(): string } | null
  amountOff: { toString(): string } | null
  fixedPrice: { toString(): string } | null
  currency: string | null
  perCustomerUses: number | null
  budgetType: string | null
  budgetValue: { toString(): string } | null
  issuesJson: unknown
}

export const ITEM_SELECT = {
  asin: true,
  sku: true,
  benefitType: true,
  discountType: true,
  percentOff: true,
  amountOff: true,
  fixedPrice: true,
  currency: true,
  perCustomerUses: true,
  budgetType: true,
  budgetValue: true,
  issuesJson: true,
} as const

export async function itemsSection(prisma: PrismaService, ctx: DetailContext, records: readonly ItemRecord[], canProducts: boolean): Promise<PromotionItemsSection> {
  const { row } = ctx
  const shown = records.slice(0, PROMOTION_ITEM_ROW_LIMIT)
  const products = new Map<string, { id: string; title: string }>()
  if (canProducts && shown.length > 0) {
    const found = await prisma.fbaProduct.findMany({
      where: { tenantId: ctx.tenantId, sellerAccountId: row.sellerAccountId, asin: { in: shown.map(item => item.asin).filter(Boolean) } },
      select: { id: true, asin: true, sellerSku: true, title: true },
      orderBy: [{ asin: 'asc' }, { sellerSku: 'asc' }],
      take: 2000,
    })
    for (const item of found) {
      products.set(`${item.asin}|${item.sellerSku}`, { id: item.id, title: item.title })
      if (!products.has(item.asin)) products.set(item.asin, { id: item.id, title: item.title })
    }
  }
  const items = shown.map((item): PromotionItemRow => {
    const product = products.get(`${item.asin}|${item.sku}`) ?? products.get(item.asin) ?? null
    return {
      asin: item.asin,
      sku: item.sku,
      productId: product?.id ?? null,
      productTitle: product?.title ?? null,
      benefitText: itemBenefitText({
        benefitType: item.benefitType,
        discountType: item.discountType,
        percentOff: num(item.percentOff),
        amountOff: num(item.amountOff),
        fixedPrice: num(item.fixedPrice),
        currency: item.currency,
      }),
      perCustomerUses: item.perCustomerUses,
      budgetText: item.budgetType && num(item.budgetValue) !== null ? budgetTextOf({ type: item.budgetType, value: num(item.budgetValue) ?? 0, currency: item.currency }) : null,
      issues: issuesOf(item.issuesJson),
    }
  })
  const base = { selectionType: row.selectionType, total: row.itemCount, truncated: row.itemsTruncated || records.length > PROMOTION_ITEM_ROW_LIMIT }
  if (row.selectionType === 'CATALOG') return { ...base, state: 'NO_ITEMS', note: '这是按目录选品的促销（整个目录参与），亚马逊没有提供商品清单', items: [] }
  if (!row.selectionType) return { ...base, state: 'NO_DATA', note: '尚无记录：亚马逊没有返回这个促销的商品选择信息', items: [] }
  if (row.itemCount === null) return { ...base, state: 'NO_DATA', note: '商品清单尚未同步：每日同步会按“进行中、即将开始优先”的顺序逐步补齐', items: [] }
  if (items.length === 0) return { ...base, state: 'NO_DATA', note: '尚无记录：亚马逊返回的商品清单是空的', items: [] }
  const notes = [
    records.length > PROMOTION_ITEM_ROW_LIMIT ? `商品较多，这里只显示前 ${PROMOTION_ITEM_ROW_LIMIT} 个` : null,
    row.itemsTruncated ? '同步时商品清单被截断，亚马逊侧的商品可能比这里多' : null,
  ].filter((note): note is string => note !== null)
  return { ...base, state: 'OK', note: notes.length ? notes.join('；') : null, items }
}

const REVISION_NOTE = (status: string) => (status === 'FAILED' ? '最近一次修订失败，请到卖家后台查看原因' : `最近一次修订的状态：${status}`)

export function issuesSection(ctx: DetailContext, records: readonly ItemRecord[]): PromotionIssuesSection {
  const { row } = ctx
  const promotionIssues = issuesOf(row.issuesJson)
  const itemIssueCount = records.filter(item => issuesOf(item.issuesJson).length > 0).length
  const latestRevision = row.revisionStatus ? { status: row.revisionStatus, note: REVISION_NOTE(row.revisionStatus) } : null
  const hasAny = promotionIssues.length > 0 || itemIssueCount > 0 || latestRevision?.status === 'FAILED'
  return {
    state: hasAny ? 'OK' : 'NO_DATA',
    note: hasAny ? null : '尚无记录：亚马逊没有返回这个促销的问题提示',
    promotionIssues,
    itemIssueCount,
    latestRevision,
  }
}

const ADS_ROWS = 100

export async function adsSection(coverage: AsinAdsCoverageService, ctx: DetailContext, canAds: boolean): Promise<PromotionAdsSection> {
  const idle = { totals: { spend: null, sales: null, orders: null }, items: [], truncated: false }
  if (!canAds) return { ...idle, state: 'RESTRICTED', note: '需要广告读取权限（ads.read）才能看活动期间的广告表现' }
  const gate = gateOf(ctx)
  if (gate || !ctx.window) return { ...idle, state: gate?.state ?? 'NOT_STARTED', note: gate?.note ?? null }
  const result = await coverage.coverage({ tenantId: ctx.tenantId, scope: ctx.scope, storeIds: [ctx.row.sellerAccountId], asins: ctx.asins, from: ctx.window.from, to: ctx.window.to })
  if (!result.bound) return { ...idle, state: 'NOT_CONNECTED', note: '尚未接入：这个店铺还没有绑定亚马逊广告账户' }
  if (!result.everSynced) return { ...idle, state: 'NOT_CONNECTED', note: '尚未接入：被推广商品日报表还没有同步过' }
  const all = [...result.byAsin.entries()].map(([asin, value]) => ({ asin, ...value }))
  const items = all.sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || a.asin.localeCompare(b.asin))
  const sum = (pick: (value: (typeof items)[number]) => number | null) => {
    const present = items.map(pick).filter((value): value is number => value !== null)
    return present.length ? Math.round(present.reduce((total, value) => total + value, 0) * 100) / 100 : null
  }
  const notes = [ctx.asinsPartial ? PARTIAL_NOTE : null, result.truncated || items.length > ADS_ROWS ? `商品较多，这里只显示花费最高的 ${ADS_ROWS} 个` : null].filter(
    (note): note is string => note !== null,
  )
  return {
    state: items.length === 0 ? 'NO_DATA' : 'OK',
    note: items.length === 0 ? '尚无记录：活动期间所选商品没有广告记录' : notes.length ? notes.join('；') : null,
    totals: { spend: sum(item => item.spend), sales: sum(item => item.sales), orders: sum(item => item.orders) },
    items: items.slice(0, ADS_ROWS),
    truncated: result.truncated || items.length > ADS_ROWS,
  }
}
