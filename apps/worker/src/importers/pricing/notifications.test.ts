import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { NotificationProcessorRegistry } from '../../platform/notification-events'
import { createOfferChangedProcessor, createPricingHealthProcessor, lostReasonOf, registerPricingProcessors } from './notifications'

// N-05 报价变化与 N-06 价格健康推送处理器（P4-11）：用内存假库验证“只处理美国站全新商品、没变化不重复写、
// 不认识获得者就不猜是不是我方、原因缺失按结构错误报告、原因是价格才记价格失去资格”。

interface Row {
  asin: string
  sellerSku: string
  hasFeaturedOffer: boolean
  ownIsFeatured: boolean | null
  featuredPrice: number | null
  lostReason: string | null
  source: string
  observedAt: Date
}

function fakeDeps(payload: unknown) {
  const boxes: Row[] = []
  const freshness: unknown[] = []
  const db = {
    sellerAccount: {
      findMany: async () => [{ id: 'st1', sellerId: 'ME' }],
      findFirst: async () => ({ sellerId: 'ME' }),
    },
    listingSnapshot: { findUnique: async () => ({ asin: 'B0TEST0001' }) },
    buyBoxSnapshot: {
      findFirst: async () => [...boxes].reverse().find(row => row.lostReason === null && row.source === 'NOTIFICATION') ?? null,
      createMany: async ({ data }: { data: Row[] }) => {
        boxes.push(...data.map(row => ({ ...row, featuredPrice: row.featuredPrice === null ? null : (row.featuredPrice as number) })))
        return { count: data.length }
      },
    },
    dataFreshness: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => void freshness.push(data), update: async () => undefined, updateMany: async () => undefined },
  }
  const storage = { openRead: async () => Readable.from([Buffer.from(JSON.stringify(payload))]) }
  return { boxes, freshness, deps: { db, storage } as never }
}
const event = { id: 'e1', tenantId: 't1', sellerAccountId: null, notificationType: 'x', payloadObjectKey: 'k' }
const money = (amount: number) => ({ Amount: amount, CurrencyCode: 'USD' })
const offerChanged = (patch: Record<string, unknown> = {}, trigger: Record<string, unknown> = {}) => ({
  notificationType: 'ANY_OFFER_CHANGED',
  eventTime: '2026-10-24T06:00:00Z',
  payload: {
    anyOfferChangedNotification: {
      sellerId: 'ME',
      offerChangeTrigger: { marketplaceId: 'ATVPDKIKX0DER', asin: 'b0test0001', itemCondition: 'new', ...trigger },
      summary: { buyBoxPrices: [{ condition: 'new', landedPrice: money(23.5) }] },
      offers: [
        { sellerId: 'OTHER', isBuyBoxWinner: true, listingPrice: money(23.5), shipping: money(0) },
        { sellerId: 'ME', isBuyBoxWinner: false, listingPrice: money(24.99), shipping: money(0) },
      ],
      ...patch,
    },
  },
})

describe('N-05 报价变化', () => {
  it('写一条推荐报价快照：别家获得时 ownIsFeatured 为 false，价格取全新商品的推荐报价', async () => {
    const { boxes, deps, freshness } = fakeDeps(offerChanged())
    await createOfferChangedProcessor(deps)(event)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ asin: 'B0TEST0001', hasFeaturedOffer: true, ownIsFeatured: false, featuredPrice: 23.5, source: 'NOTIFICATION', lostReason: null })
    expect(freshness).toHaveLength(1)
  })

  it('我方获得时 ownIsFeatured 为 true', async () => {
    const { boxes, deps } = fakeDeps(offerChanged({ offers: [{ sellerId: 'ME', isBuyBoxWinner: true, listingPrice: money(23.5), shipping: money(0) }] }))
    await createOfferChangedProcessor(deps)(event)
    expect(boxes[0]?.ownIsFeatured).toBe(true)
  })

  it('获得者信息缺失：不猜是不是我方（null）；没有推荐报价时 hasFeaturedOffer 为 false', async () => {
    const { boxes, deps } = fakeDeps(offerChanged({ summary: {}, offers: [] }))
    await createOfferChangedProcessor(deps)(event)
    expect(boxes[0]).toMatchObject({ hasFeaturedOffer: false, ownIsFeatured: null, featuredPrice: null })
  })

  it('与上一条没变化：不重复写；价格变了才写', async () => {
    const first = fakeDeps(offerChanged())
    await createOfferChangedProcessor(first.deps)(event)
    await createOfferChangedProcessor(first.deps)(event)
    expect(first.boxes).toHaveLength(1)
  })

  it('不是美国站或不是全新商品：忽略，不写也不报错', async () => {
    const eu = fakeDeps(offerChanged({}, { marketplaceId: 'A1F83G8C2ARO7P' }))
    await createOfferChangedProcessor(eu.deps)(event)
    expect(eu.boxes).toHaveLength(0)
    const used = fakeDeps(offerChanged({}, { itemCondition: 'used' }))
    await createOfferChangedProcessor(used.deps)(event)
    expect(used.boxes).toHaveLength(0)
  })

  it('消息类型不对或缺 asin：按结构错误报告', async () => {
    await expect(createOfferChangedProcessor(fakeDeps({ ...offerChanged(), notificationType: 'OTHER' }).deps)(event)).rejects.toThrow(/期望 ANY_OFFER_CHANGED/)
    await expect(createOfferChangedProcessor(fakeDeps(offerChanged({}, { asin: '' })).deps)(event)).rejects.toThrow(/缺少 asin/)
  })
})

describe('N-06 价格健康', () => {
  const health = (payload: Record<string, unknown>) => ({
    notificationType: 'PRICING_HEALTH',
    eventTime: '2026-10-24T07:00:00Z',
    payload: { sellerId: 'ME', marketplaceId: 'ATVPDKIKX0DER', ...payload },
  })

  it('原因是价格：写 lostReason=PRICE；只有 sku 时由刊登状态反查 asin', async () => {
    const { boxes, deps } = fakeDeps(health({ sku: 'SKU-1', lostEligibilityReason: 'PRICE_TOO_HIGH' }))
    await createPricingHealthProcessor(deps)(event)
    expect(boxes[0]).toMatchObject({ asin: 'B0TEST0001', lostReason: 'PRICE', hasFeaturedOffer: false, ownIsFeatured: false, source: 'NOTIFICATION' })
  })

  it('别的原因记 OTHER；没有原因字段按结构错误报告，不猜', async () => {
    const other = fakeDeps(health({ asin: 'B0TEST0001', reason: 'SHIPPING_SPEED' }))
    await createPricingHealthProcessor(other.deps)(event)
    expect(other.boxes[0]?.lostReason).toBe('OTHER')
    await expect(createPricingHealthProcessor(fakeDeps(health({ asin: 'B0TEST0001' })).deps)(event)).rejects.toThrow(/缺少失去资格的原因/)
    expect(() => lostReasonOf({})).toThrow()
  })

  it('注册到统一注册表：两个类型各一个处理器，重复注册会报错', () => {
    const registry = new NotificationProcessorRegistry()
    registerPricingProcessors(registry, fakeDeps({}).deps)
    expect(() => registerPricingProcessors(registry, fakeDeps({}).deps)).toThrow(/重复注册/)
  })
})
