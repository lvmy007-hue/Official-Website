import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { recordFreshness } from '../../freshness/record'
import { NtfSchemaError } from '../notifications/hourly-parse'
import { readJson, resolveSellerAccountId, type HourlyProcessorDeps } from '../notifications/hourly-write'
import { amountOf } from './parse'

// 定价相关的推送处理器（importers.md N-05、N-06，P4-11）。推送接收端按 14.10 暂缓：没有接收端就不会有事件进来，处理器先备好，
// 事件由重放接口或将来的接收端交给它们。字段名按官方文档整理（大小写与驼峰都容忍），未经真实推送验证（CR-086 未验证清单）：
//   N-05 ANY_OFFER_CHANGED   payload 带 offerChangeTrigger（asin、marketplaceId、itemCondition）、summary（buyBoxPrices）与 offers（isBuyBoxWinner、sellerId）
//                            → 只处理美国站、全新商品；写一条推荐报价快照（source=NOTIFICATION），与上一条相比没变化就不写。
//   N-06 PRICING_HEALTH      payload 带 asin 或 sku，以及失去资格的原因 → 原因是价格时写一条 lostReason=PRICE 的快照，详情页显示“因价格失去推荐报价资格”。
// 推送行不参与“获得/失去推荐报价”的判断（那只看每 2 小时的同步行），所以推送只补充历史，不会让事件重复或自相矛盾。
// 价格本身（我方当前价）以每 2 小时的刊登接口同步为准，推送不写价格快照。

const US = 'ATVPDKIKX0DER'
const SOURCE = 'NOTIFICATION'
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const pick = (row: Record<string, unknown>, ...names: string[]): unknown => {
  for (const name of names) if (row[name] !== undefined) return row[name]
  return undefined
}
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
/** 金额对象（官方推送里键名是 Amount，也容忍 amount）；非正数当没有。 */
const moneyOf = (value: unknown): number | null => {
  const row = obj(value)
  return row ? amountOf(pick(row, 'Amount', 'amount')) : null
}
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005)

function parseEnvelope(raw: unknown, expectedType: string): { eventTime: Date; payload: Record<string, unknown> } {
  const root = obj(raw)
  if (!root) throw new NtfSchemaError('通知根对象必须是对象')
  const type = text(root.notificationType)
  if (type !== expectedType) throw new NtfSchemaError(`期望 ${expectedType}，收到 ${type || '空'}`)
  const eventTime = new Date(text(root.eventTime))
  if (Number.isNaN(eventTime.getTime())) throw new NtfSchemaError('eventTime 不是合法时间')
  const payload = obj(root.payload)
  if (!payload) throw new NtfSchemaError('payload 必须是对象')
  const inner = obj(pick(payload, 'anyOfferChangedNotification', 'AnyOfferChangedNotification', 'pricingHealthNotification', 'PricingHealthNotification')) ?? payload
  return { eventTime, payload: inner }
}

interface Scoped {
  event: NotificationEventRef
  sellerAccountId: string
  eventTime: Date
  payload: Record<string, unknown>
}

async function scopedOf(deps: HourlyProcessorDeps, event: NotificationEventRef, type: string): Promise<Scoped | null> {
  const { eventTime, payload } = parseEnvelope(await readJson(deps.storage, event.payloadObjectKey), type)
  const trigger = obj(pick(payload, 'offerChangeTrigger', 'OfferChangeTrigger')) ?? payload
  const market = text(pick(trigger, 'marketplaceId', 'MarketplaceId')) || text(pick(payload, 'marketplaceId', 'MarketplaceId')) || US
  if (market !== US) return null // 只做美国站
  const sellerAccountId = await resolveSellerAccountId(deps.db, event.tenantId, event.sellerAccountId, [text(pick(payload, 'sellerId', 'SellerId', 'merchantId', 'MerchantId'))])
  return sellerAccountId ? { event, sellerAccountId, eventTime, payload } : null
}

async function fresh(deps: HourlyProcessorDeps, scope: Scoped, sourceKey: string) {
  await recordFreshness(deps.db, { tenantId: scope.event.tenantId, sellerAccountId: scope.sellerAccountId, sourceKey, ok: true, rowCount: 1, dataThrough: scope.eventTime })
}

/** 推荐报价的价格：优先取 summary 里全新商品的推荐报价价格，没有就取获得推荐报价的报价（挂牌价加运费）。 */
function featuredPriceOf(payload: Record<string, unknown>, winner: Record<string, unknown> | null): number | null {
  const summary = obj(pick(payload, 'summary', 'Summary')) ?? {}
  const prices = pick(summary, 'buyBoxPrices', 'BuyBoxPrices')
  if (Array.isArray(prices)) {
    for (const item of prices) {
      const row = obj(item)
      if (!row) continue
      const condition = text(pick(row, 'condition', 'Condition')).toLowerCase()
      if (condition && condition !== 'new') continue
      const landed = moneyOf(pick(row, 'landedPrice', 'LandedPrice'))
      if (landed !== null) return landed
      const listing = moneyOf(pick(row, 'listingPrice', 'ListingPrice'))
      if (listing !== null) return listing + (moneyOf(pick(row, 'shipping', 'Shipping')) ?? 0)
    }
  }
  if (!winner) return null
  const listing = moneyOf(pick(winner, 'listingPrice', 'ListingPrice'))
  return listing === null ? null : listing + (moneyOf(pick(winner, 'shipping', 'Shipping')) ?? 0)
}

export function createOfferChangedProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'ANY_OFFER_CHANGED')
    if (!scope) return
    const trigger = obj(pick(scope.payload, 'offerChangeTrigger', 'OfferChangeTrigger')) ?? scope.payload
    const asin = text(pick(trigger, 'asin', 'ASIN', 'Asin')).toUpperCase()
    if (!asin) throw new NtfSchemaError('报价变化缺少 asin')
    const condition = text(pick(trigger, 'itemCondition', 'ItemCondition')).toLowerCase()
    if (condition && condition !== 'new') return // 只看全新商品
    const offersRaw = pick(scope.payload, 'offers', 'Offers')
    const offers = Array.isArray(offersRaw) ? offersRaw.flatMap(item => (obj(item) ? [obj(item)!] : [])) : []
    const winner = offers.find(offer => pick(offer, 'isBuyBoxWinner', 'IsBuyBoxWinner') === true) ?? null
    const featuredPrice = featuredPriceOf(scope.payload, winner)
    const hasFeaturedOffer = winner !== null || featuredPrice !== null
    const account = await deps.db.sellerAccount.findFirst({ where: { id: scope.sellerAccountId, tenantId: event.tenantId }, select: { sellerId: true } })
    const winnerSeller = winner ? text(pick(winner, 'sellerId', 'SellerId')) : ''
    // 没有获得者信息或不认识本店卖家编号时，不猜“是不是我方”
    const ownIsFeatured = winner && account && winnerSeller ? winnerSeller === account.sellerId : null
    const before = await deps.db.buyBoxSnapshot.findFirst({
      where: { sellerAccountId: scope.sellerAccountId, marketplaceId: US, asin, sellerSku: '', source: SOURCE, lostReason: null },
      orderBy: { observedAt: 'desc' },
    })
    const beforePrice = before?.featuredPrice === null || before?.featuredPrice === undefined ? null : Number(before.featuredPrice.toString())
    const unchanged = before && before.hasFeaturedOffer === hasFeaturedOffer && before.ownIsFeatured === ownIsFeatured && same(beforePrice, featuredPrice)
    if (!unchanged) {
      await deps.db.buyBoxSnapshot.createMany({
        data: [
          {
            tenantId: event.tenantId,
            sellerAccountId: scope.sellerAccountId,
            marketplaceId: US,
            asin,
            sellerSku: '',
            hasFeaturedOffer,
            ownIsFeatured,
            featuredPrice,
            lostReason: null,
            source: SOURCE,
            observedAt: scope.eventTime,
          },
        ],
        skipDuplicates: true,
      })
    }
    await fresh(deps, scope, 'ntf.offer-changed')
  }
}

/** 失去资格的原因归一：含“PRICE”的算价格原因，其余记 OTHER。没有原因字段就是结构错误，不猜。 */
export function lostReasonOf(payload: Record<string, unknown>): 'PRICE' | 'OTHER' {
  const raw = pick(payload, 'lostEligibilityReason', 'reason', 'Reason', 'eligibilityReason', 'featuredOfferEligibilityReason')
  const reason = Array.isArray(raw) ? raw.map(text).join(',') : text(raw)
  if (!reason) throw new NtfSchemaError('价格健康通知缺少失去资格的原因')
  return reason.toUpperCase().includes('PRICE') ? 'PRICE' : 'OTHER'
}

export function createPricingHealthProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async event => {
    const scope = await scopedOf(deps, event, 'PRICING_HEALTH')
    if (!scope) return
    const trigger = obj(pick(scope.payload, 'offerChangeTrigger', 'OfferChangeTrigger')) ?? scope.payload
    const sku = text(pick(scope.payload, 'sku', 'Sku', 'sellerSku', 'SellerSku'))
    let asin = text(pick(trigger, 'asin', 'ASIN', 'Asin')).toUpperCase()
    if (!asin && sku) {
      const snapshot = await deps.db.listingSnapshot.findUnique({
        where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId: scope.sellerAccountId, marketplaceId: US, sellerSku: sku } },
        select: { asin: true },
      })
      asin = snapshot?.asin?.toUpperCase() ?? ''
    }
    if (!asin) throw new NtfSchemaError('价格健康通知缺少 asin，且无法由 sku 反查')
    const lostReason = lostReasonOf(scope.payload)
    await deps.db.buyBoxSnapshot.createMany({
      data: [
        {
          tenantId: event.tenantId,
          sellerAccountId: scope.sellerAccountId,
          marketplaceId: US,
          asin,
          sellerSku: '',
          hasFeaturedOffer: false,
          ownIsFeatured: false,
          featuredPrice: null,
          lostReason,
          source: SOURCE,
          observedAt: scope.eventTime,
        },
      ],
      skipDuplicates: true,
    })
    await fresh(deps, scope, 'ntf.pricing-health')
  }
}

export function registerPricingProcessors(registry: { register(type: string, processor: NotificationProcessor): unknown }, deps: HourlyProcessorDeps) {
  registry.register('ANY_OFFER_CHANGED', createOfferChangedProcessor(deps))
  registry.register('PRICING_HEALTH', createPricingHealthProcessor(deps))
}
