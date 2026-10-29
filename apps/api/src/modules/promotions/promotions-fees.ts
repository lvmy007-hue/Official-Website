import { PROMOTION_FEE_KEYWORDS, type PromotionFeeLine, type PromotionPlatformFee } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { num, type PromotionRecord } from './promotions-common'

// 促销平台费用（M-162）的归集：从费用事件（FbaFeeEvent）里找“其他平台费用”类、类型或子类型含 deal / coupon 的事件，
// 按促销所选商品（ASIN）与活动期间（结束后再留 7 天入账时间）归到每个促销。关键字与“事件带 ASIN”都是启发式，未用真实费用事件逐条核对（CR-080）。
// 事件没有 ASIN 的不归入（宁可少算也不乱摊）；同一商品同期有多个同类促销时会被重复计入。

export const FEE_TAIL_DAYS = 7
const DAY_MS = 86_400_000
export const FEE_EVENT_LIMIT = 5000
/** 一页列表里所有促销的商品数合计上限：超过就不去算费用（IN 列表太长），整页标“未读完”。 */
export const FEE_ASIN_LIMIT = 10_000

export interface FeeEvent {
  sellerAccountId: string
  asin: string
  eventType: string
  feeSubtype: string | null
  amount: number
  postedAt: Date
}

export interface FeeTarget {
  id: string
  sellerAccountId: string
  type: string
  startAt: Date
  endAt: Date | null
  asins: ReadonlySet<string>
}

/** 费用入账的时间窗：开始时刻到（结束时刻或现在）之后 7 天。 */
export function feeWindow(startAt: Date, endAt: Date | null, now: Date): { from: Date; to: Date } {
  const end = endAt && endAt < now ? endAt : now
  return { from: startAt, to: new Date(Math.max(end.getTime(), startAt.getTime()) + FEE_TAIL_DAYS * DAY_MS) }
}

export const keywordsOf = (type: string): readonly string[] => PROMOTION_FEE_KEYWORDS[type] ?? []

const matches = (event: Pick<FeeEvent, 'eventType' | 'feeSubtype'>, keywords: readonly string[]) => {
  const text = `${event.eventType} ${event.feeSubtype ?? ''}`.toLowerCase()
  return keywords.some(keyword => text.includes(keyword))
}

export async function loadFeeEvents(
  prisma: PrismaService,
  input: { tenantId: string; storeIds: readonly string[]; asins: readonly string[]; from: Date; to: Date; keywords: readonly string[] },
): Promise<{ events: FeeEvent[]; truncated: boolean }> {
  if (input.asins.length === 0 || input.keywords.length === 0) return { events: [], truncated: false }
  const keyword: Prisma.FbaFeeEventWhereInput[] = input.keywords.flatMap(word => [
    { eventType: { contains: word, mode: 'insensitive' as const } },
    { feeSubtype: { contains: word, mode: 'insensitive' as const } },
  ])
  const rows = await prisma.fbaFeeEvent.findMany({
    where: {
      tenantId: input.tenantId,
      sellerAccountId: { in: [...input.storeIds] },
      feeCategory: 'OTHER',
      currency: 'USD',
      postedAt: { gte: input.from, lt: input.to },
      asin: { in: [...input.asins] },
      OR: keyword,
    },
    select: { sellerAccountId: true, asin: true, eventType: true, feeSubtype: true, amount: true, postedAt: true },
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    take: FEE_EVENT_LIMIT + 1,
  })
  const events = rows
    .slice(0, FEE_EVENT_LIMIT)
    .flatMap(row =>
      row.asin ? [{ sellerAccountId: row.sellerAccountId, asin: row.asin, eventType: row.eventType, feeSubtype: row.feeSubtype, amount: num(row.amount) ?? 0, postedAt: row.postedAt }] : [],
    )
  return { events, truncated: rows.length > FEE_EVENT_LIMIT }
}

/** 一个促销名下的费用：金额为“花掉的钱”（费用事件里是负数，这里取反）；没有匹配事件时 count 为 0，调用方显示“尚无记录”而不是 0。 */
export function feeOf(events: readonly FeeEvent[], target: Omit<FeeTarget, 'id'>, now: Date): { amount: number; count: number; lines: PromotionFeeLine[] } {
  const window = feeWindow(target.startAt, target.endAt, now)
  const keywords = keywordsOf(target.type)
  const lines = new Map<string, PromotionFeeLine>()
  let total = 0
  let count = 0
  for (const event of events) {
    if (event.sellerAccountId !== target.sellerAccountId || !target.asins.has(event.asin)) continue
    if (event.postedAt < window.from || event.postedAt >= window.to || !matches(event, keywords)) continue
    const label = event.feeSubtype ? `${event.eventType} / ${event.feeSubtype}` : event.eventType
    const held = lines.get(label) ?? { label, amount: 0, count: 0 }
    held.amount += -event.amount
    held.count += 1
    lines.set(label, held)
    total += -event.amount
    count += 1
  }
  const round = (value: number) => Math.round(value * 100) / 100
  return { amount: round(total), count, lines: [...lines.values()].map(line => ({ ...line, amount: round(line.amount) })) }
}

/** 列表里每个促销的平台费用：先判断“能不能算”（权限、类型、商品清单），能算再按事件归集。 */
export async function platformFees(prisma: PrismaService, tenantId: string, rows: readonly PromotionRecord[], canFinance: boolean, now = new Date()): Promise<Map<string, PromotionPlatformFee>> {
  const result = new Map<string, PromotionPlatformFee>()
  if (!canFinance) {
    for (const row of rows) result.set(row.id, { state: 'RESTRICTED', amount: null })
    return result
  }
  const candidates: PromotionRecord[] = []
  for (const row of rows) {
    if (keywordsOf(row.promotionType).length === 0) result.set(row.id, { state: 'NOT_APPLICABLE', amount: null })
    else if (row.selectionType !== 'ITEMS' || !row.itemCount) result.set(row.id, { state: 'NO_ITEMS', amount: null })
    else candidates.push(row)
  }
  if (candidates.length === 0) return result
  const items = await prisma.promotionItem.findMany({
    where: { tenantId, promotionRowId: { in: candidates.map(row => row.id) }, asin: { not: '' } },
    select: { promotionRowId: true, asin: true },
    take: FEE_ASIN_LIMIT + 1,
  })
  if (items.length > FEE_ASIN_LIMIT) {
    for (const row of candidates) result.set(row.id, { state: 'INCOMPLETE', amount: null })
    return result
  }
  const asinsOf = new Map<string, Set<string>>()
  for (const item of items) asinsOf.set(item.promotionRowId, (asinsOf.get(item.promotionRowId) ?? new Set()).add(item.asin))
  const windows = candidates.map(row => feeWindow(row.startAt, row.endAt, now))
  const loaded = await loadFeeEvents(prisma, {
    tenantId,
    storeIds: [...new Set(candidates.map(row => row.sellerAccountId))],
    asins: [...new Set(items.map(item => item.asin))],
    from: new Date(Math.min(...windows.map(window => window.from.getTime()))),
    to: new Date(Math.max(...windows.map(window => window.to.getTime()))),
    keywords: [...new Set(candidates.flatMap(row => keywordsOf(row.promotionType)))],
  })
  for (const row of candidates) {
    if (loaded.truncated) {
      result.set(row.id, { state: 'INCOMPLETE', amount: null })
      continue
    }
    const fee = feeOf(loaded.events, { sellerAccountId: row.sellerAccountId, type: row.promotionType, startAt: row.startAt, endAt: row.endAt, asins: asinsOf.get(row.id) ?? new Set() }, now)
    result.set(row.id, fee.count > 0 ? { state: 'OK', amount: fee.amount } : { state: 'NO_DATA', amount: null })
  }
  return result
}
