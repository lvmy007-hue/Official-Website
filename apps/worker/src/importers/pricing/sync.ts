import { LISTING_ROLE_MISSING, PRICING_LIMITS, PRICING_ROLE_MISSING } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { isListingsForbidden, type ListingsApi } from '../../connectors/listings-api'
import { isPricingForbidden, type PricingApi } from '../../connectors/pricing-api'
import type { ImportContext } from '../../types'
import { storeCompetitors } from './competitors'
import { parseExpectedPrices, parseOwnPrices, parseSummaries, type OwnPrice } from './parse'
import { storeExpected, storeOwnPrices, storeSummaries, type PricingScope } from './store'

// 定价同步器（importers.md I-13，P4-11）：每 2 小时一次，读取我方报价（刊登接口）、推荐报价预期价格（SKU 批量）、竞争摘要（ASIN 批量），写价格快照、预期价格、竞争摘要、竞争报价与购物车观察。
// 规则：
//   - 我方报价全量翻页读取（每页 20 个，最多 MAX_PAGES 页）；翻不完标 incomplete；
//   - 两个批量接口官方限速约 30 秒一次，所以每次最多 syncBatchesMax 批：商品多于一次的容量时按“时间槽”确定性轮转（无状态，每个商品在若干次运行内都会被轮到）；
//   - 批内个别项失败只计数不中断；整批请求失败（限速以外的错误）向上抛出由任务重试，已写入的批因去重规则幂等；
//   - 403（缺“定价”或“商品刊登”角色）以不可重试的失败码结束，页面如实显示“尚未接入”。

export type { PricingScope } from './store'
export interface PricingOptions {
  now?: Date
  maxPages?: number
  maxBatches?: number
  /** 我方卖家编号：用来在竞争报价里识别“我方”。 */
  ownSellerId?: string
}
export type PricingResult =
  | { notApplicable: true; reason: 'SELLER_ID_MISSING'; imported: 0 }
  | {
      notApplicable: false
      imported: number
      listings: number
      priceRows: number
      expectedRows: number
      summaryRows: number
      offerRows: number
      buyBoxRows: number
      /** 跟卖观察（P6-17）本次新出现、刷新与消失的行数合计；没有我方卖家编号时不写，为 0。 */
      competitorRows: number
      failedItems: number
      incomplete: boolean
    }

export const MAX_PAGES = 500

/** 无状态轮转：同一时间槽内选同一段，下一个时间槽接着往后；容量够用时每次全量。 */
export function rotate<T>(items: readonly T[], size: number, now: Date): T[] {
  if (items.length <= size) return [...items]
  const start = (Math.floor(now.getTime() / PRICING_LIMITS.syncSlotMs) * size) % items.length
  return [...items.slice(start), ...items.slice(0, start)].slice(0, size)
}
const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))

async function readOwnPrices(ctx: ImportContext, api: ListingsApi, scope: PricingScope, now: Date, maxPages: number) {
  const own = new Map<string, OwnPrice>()
  let rows = 0
  let token: string | undefined
  let incomplete = true
  for (let page = 0; page < maxPages; page += 1) {
    let parsed
    try {
      parsed = parseOwnPrices(await api.search(token, 'summaries,offers'))
    } catch (error) {
      if (isListingsForbidden(error)) throw new NonRetryableError(LISTING_ROLE_MISSING, '亚马逊商品刊登接口的角色尚未获批，我方报价无法同步')
      throw error
    }
    rows += await storeOwnPrices(ctx, scope, parsed.items, now)
    for (const item of parsed.items) own.set(item.sku, item)
    if (!parsed.nextToken) {
      incomplete = false
      break
    }
    token = parsed.nextToken
  }
  return { own, rows, incomplete }
}

async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (isPricingForbidden(error)) throw new NonRetryableError(PRICING_ROLE_MISSING, '亚马逊定价接口的角色尚未获批，推荐报价与竞争数据无法同步')
    throw error
  }
}

export async function syncPricing(ctx: ImportContext, listings: ListingsApi | null, pricing: PricingApi, scope: PricingScope, options: PricingOptions = {}): Promise<PricingResult> {
  const now = options.now ?? new Date()
  if (!listings) return { notApplicable: true, reason: 'SELLER_ID_MISSING', imported: 0 }
  const maxBatches = options.maxBatches ?? PRICING_LIMITS.syncBatchesMax
  const { own, rows: priceRows, incomplete } = await readOwnPrices(ctx, listings, scope, now, options.maxPages ?? MAX_PAGES)
  let failedItems = 0
  let expectedRows = 0
  const skus = rotate([...own.keys()].sort(), PRICING_LIMITS.featuredBatch * maxBatches, now)
  for (const batch of chunk(skus, PRICING_LIMITS.featuredBatch)) {
    const parsed = parseExpectedPrices(await guarded(() => pricing.featuredExpectedPrices(batch)))
    failedItems += parsed.failed
    expectedRows += await storeExpected(ctx, scope, parsed.rows, now)
  }
  const asins = rotate([...new Set([...own.values()].map(item => item.asin).filter(asin => asin !== ''))].sort(), PRICING_LIMITS.summaryBatch * maxBatches, now)
  const totals = { summaries: 0, offers: 0, buyBox: 0, competitors: 0 }
  // 摘要按 ASIN，跟卖观察按 SKU：一个 ASIN 下我方的每个 SKU 都记一份
  const skusOfAsin = new Map<string, string[]>()
  for (const item of own.values()) if (item.asin !== '') skusOfAsin.set(item.asin, [...(skusOfAsin.get(item.asin) ?? []), item.sku])
  for (const batch of chunk(asins, PRICING_LIMITS.summaryBatch)) {
    const parsed = parseSummaries(await guarded(() => pricing.competitiveSummaries(batch)), options.ownSellerId ?? '')
    failedItems += parsed.failed
    const stored = await storeSummaries(ctx, scope, parsed.rows, now)
    totals.summaries += stored.summaries
    totals.offers += stored.offers
    totals.buyBox += stored.buyBox
    // 没有我方卖家编号就分不出我方与对方，宁可不写跟卖观察，也不能把我方报价记成跟卖
    if (options.ownSellerId) {
      const found = await storeCompetitors(ctx, scope, parsed.rows, skusOfAsin, now)
      totals.competitors += found.appeared + found.refreshed + found.gone
    }
  }
  if (incomplete) ctx.logger.warn({ ...scope }, 'pricing sync reached the listing page limit; unseen listings keep their previous price rows')
  return {
    notApplicable: false,
    imported: priceRows + expectedRows + totals.summaries,
    listings: own.size,
    priceRows,
    expectedRows,
    summaryRows: totals.summaries,
    offerRows: totals.offers,
    buyBoxRows: totals.buyBox,
    competitorRows: totals.competitors,
    failedItems,
    incomplete,
  }
}
