import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../../connectors/http-error'
import { ORDERS_DATASETS, ORDERS_DATASETS_WITHOUT_PII } from '../../connectors/sp-api-v2'
import { parseOrder } from './v2026-parse'
import type { ParsedOrder } from './v2026-types'
import { syncOrdersV2026 } from './v2026-sync'
import { piiExpiry, writeOrder } from './v2026-write'

// 订单新版接口（Orders API v2026-01-01）：官方格式样例经真实解析器、写入器写入记录型数据库替身，断言表、幂等键、金额拆分与买家信息规则。
// 样例的金额取自官方迁移指南的算法：合计 29.16 = 商品 27.00 + 运费 2.00 − 折扣 2.00 + 税 2.16（税里折扣对应的税为 −0.24）。

type Call = { model: string; op: string; args: any }

function recorder(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const prisma: PrismaClient = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
        return new Proxy(
          {},
          {
            get(_inner, op: string) {
              return async (args: any) => {
                calls.push({ model, op, args })
                const key = `${model}.${op}`
                if (key in overrides) return overrides[key]
                if (op === 'upsert') return { id: `${model}-1`, purchaseDate: args?.create?.purchaseDate, ...(args?.create ?? {}) }
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const of = (model: string, op = 'upsert') => calls.filter(call => call.model === model && call.op === op)
  return { prisma, logger, calls, of }
}

const secrets = () => ({ sealBuyerPii: vi.fn(async (plain: string) => `sealed(${plain.length})`) })

const money = (amount: string) => ({ amount, currencyCode: 'USD' })
function sampleOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: '902-1845936-5435065',
    createdTime: '2026-09-10T08:00:00Z',
    lastUpdatedTime: '2026-09-11T10:30:00Z',
    programs: ['AMAZON_BUSINESS'],
    associatedOrders: [{ orderId: '902-0000000-0000001', associationType: 'REPLACEMENT_ORIGINAL_ID' }],
    salesChannel: { channelName: 'Amazon.com', marketplaceId: 'ATVPDKIKX0DER' },
    buyer: { buyerEmail: 'jane@marketplace.amazon.com', buyerName: 'Jane Doe' },
    recipient: { deliveryAddress: { name: 'Jane Doe', addressLine1: '1 Main St', city: 'Austin', stateOrRegion: 'TX', postalCode: '78701', countryCode: 'US', phone: '5125550100' } },
    proceeds: { grandTotal: money('29.16') },
    fulfillment: {
      fulfillmentStatus: 'SHIPPED',
      fulfilledBy: 'AMAZON',
      shipByWindow: { latestDateTime: '2026-09-12T08:00:00Z' },
      deliverByWindow: { earliestDateTime: '2026-09-13T08:00:00Z', latestDateTime: '2026-09-15T08:00:00Z' },
    },
    packages: [
      {
        packageReferenceId: '1',
        carrier: 'UPS',
        trackingNumber: '1Z999AA10123456784',
        shippingService: 'Ground',
        shipTime: '2026-09-11T09:00:00Z',
        packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'IN_TRANSIT' },
      },
    ],
    orderItems: [
      {
        orderItemId: '57727828203034',
        quantityOrdered: 1,
        product: { asin: 'B0TEST0001', sellerSku: 'SKU-1', title: 'Widget', condition: { conditionType: 'NEW' } },
        fulfillment: { quantityFulfilled: 1 },
        proceeds: {
          breakdowns: [
            { type: 'ITEM', subtotal: money('27.00') },
            { type: 'SHIPPING', subtotal: money('2.00') },
            {
              type: 'DISCOUNT',
              subtotal: money('2.00'),
              detailedBreakdowns: [
                { subtype: 'ITEM', value: money('1.60') },
                { subtype: 'SHIPPING', value: money('0.40') },
              ],
            },
            {
              type: 'TAX',
              subtotal: money('2.16'),
              detailedBreakdowns: [
                { subtype: 'ITEM', value: money('2.00') },
                { subtype: 'SHIPPING', value: money('0.40') },
                { subtype: 'DISCOUNT', value: money('0.24') },
              ],
            },
          ],
        },
      },
    ],
    ...overrides,
  }
}

const parsed = (raw: Record<string, unknown>): ParsedOrder => {
  const order = parseOrder(raw)
  if ('skipped' in order) throw new Error(`订单被跳过：${order.skipped}`)
  return order
}
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = new Date('2026-09-20T00:00:00Z')

describe('订单新版接口解析', () => {
  it('订单头、履约、包裹、替换订单、买家信息按官方字段映射', () => {
    const order = parsed(sampleOrder())
    expect(order).toMatchObject({
      amazonOrderId: '902-1845936-5435065',
      marketplaceId: 'ATVPDKIKX0DER',
      fulfillmentStatus: 'SHIPPED',
      status: 'Shipped',
      fulfillment: 'AFN',
      currency: 'USD',
      amount: 29.16,
      isReplacement: true,
      replacedOrderId: '902-0000000-0000001',
      programs: ['AMAZON_BUSINESS'],
    })
    expect(order.purchaseDate.toISOString()).toBe('2026-09-10T08:00:00.000Z')
    expect(order.lastUpdated.toISOString()).toBe('2026-09-11T10:30:00.000Z')
    expect(order.latestShipDate?.toISOString()).toBe('2026-09-12T08:00:00.000Z')
    expect(order.earliestDelivery?.toISOString()).toBe('2026-09-13T08:00:00.000Z')
    expect(order.shippedAt?.toISOString()).toBe('2026-09-11T09:00:00.000Z')
    expect(order.packages).toEqual([
      { packageId: '1', carrier: 'UPS', trackingNumber: '1Z999AA10123456784', shippingService: 'Ground', packageStatus: 'IN_TRANSIT', shipDate: new Date('2026-09-11T09:00:00Z') },
    ])
    expect(order.pii).toMatchObject({ buyerName: 'Jane Doe', buyerEmail: 'jane@marketplace.amazon.com', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', buyerPhone: '5125550100' })
    expect(order.cancellation).toBeUndefined()
  })

  it('订单行的金额拆成逐项明细，合计等于订单总额；折扣为负，税里折扣对应的税为负', () => {
    const order = parsed(sampleOrder())
    const item = order.items[0]
    expect(item).toMatchObject({
      orderItemId: '57727828203034',
      asin: 'B0TEST0001',
      sellerSku: 'SKU-1',
      quantityOrdered: 1,
      quantityShipped: 1,
      itemPrice: 27,
      promotionDiscount: 2,
      taxAmount: 2.16,
      condition: 'NEW',
    })
    const byKey = Object.fromEntries(item.charges.map(charge => [charge.componentKey, charge.amount]))
    expect(byKey).toEqual({ ITEM: 27, SHIPPING: 2, 'DISCOUNT:ITEM': -1.6, 'DISCOUNT:SHIPPING': -0.4, 'TAX:ITEM': 2, 'TAX:SHIPPING': 0.4, 'TAX:DISCOUNT': -0.24 })
    expect(item.charges.reduce((sum, charge) => sum + charge.amount, 0)).toBeCloseTo(29.16, 6)
    expect(item.charges.find(charge => charge.componentKey === 'DISCOUNT:ITEM')?.chargeKind).toBe('PROMOTION')
  })

  it('细分项之和对不上小计时退回小计一行，保证明细合计等于接口给出的合计', () => {
    const order = parsed(
      sampleOrder({
        orderItems: [{ orderItemId: 'i1', quantityOrdered: 1, proceeds: { breakdowns: [{ type: 'TAX', subtotal: money('2.16'), detailedBreakdowns: [{ subtype: 'ITEM', value: money('1.00') }] }] } }],
      }),
    )
    expect(order.items[0].charges).toEqual([{ orderItemId: 'i1', chargeKind: 'TAX', componentKey: 'TAX', amount: 2.16, currency: 'USD' }])
  })

  it('未知状态原样保留；取消订单带取消方与原因；没有买家信息权限时没有买家信息', () => {
    const order = parsed(
      sampleOrder({
        buyer: undefined,
        recipient: undefined,
        fulfillment: { fulfillmentStatus: 'CANCELLED' },
        packages: [],
        orderItems: [{ orderItemId: 'i1', quantityOrdered: 1, cancellation: { requester: 'BUYER', cancelReason: 'CUSTOMER_REQUEST' } }],
      }),
    )
    expect(order.status).toBe('Canceled')
    expect(order.cancellation).toMatchObject({ cancelledBy: 'BUYER', reasonCode: 'CUSTOMER_REQUEST' })
    expect(order.cancellation?.cancelledAt?.toISOString()).toBe('2026-09-11T10:30:00.000Z')
    expect(order.pii).toBeUndefined()
    expect(parsed(sampleOrder({ fulfillment: { fulfillmentStatus: 'BRAND_NEW_STATE' } })).status).toBe('BRAND_NEW_STATE')
  })

  it('缺订单号、缺下单时间（分区列不能用当前时间兜底）、非美国站的订单返回跳过原因', () => {
    expect(parseOrder(sampleOrder({ orderId: '' }))).toEqual({ skipped: 'NO_ORDER_ID' })
    expect(parseOrder(sampleOrder({ createdTime: undefined }))).toEqual({ skipped: 'NO_PURCHASE_DATE' })
    expect(parseOrder(sampleOrder({ createdTime: 'not-a-date' }))).toEqual({ skipped: 'NO_PURCHASE_DATE' })
    expect(parseOrder(sampleOrder({ salesChannel: { marketplaceId: 'A1F83G8C2ARO7P' } }))).toEqual({ skipped: 'NOT_US_MARKETPLACE' })
  })
})

describe('买家信息保留期', () => {
  const purchaseDate = new Date('2026-09-10T00:00:00Z')
  const now = new Date('2026-09-20T00:00:00Z')
  it('已取消或下单超过 90 天立即到期；已发货为发货后 30 天；其余为下单后 90 天', () => {
    expect(piiExpiry({ status: 'Canceled', purchaseDate, now })).toEqual(now)
    expect(piiExpiry({ status: 'Shipped', purchaseDate: new Date('2026-05-01T00:00:00Z'), shippedAt: new Date('2026-05-02T00:00:00Z'), now })).toEqual(now)
    expect(piiExpiry({ status: 'Shipped', purchaseDate, shippedAt: new Date('2026-09-11T00:00:00Z'), now }).toISOString()).toBe('2026-10-11T00:00:00.000Z')
    expect(piiExpiry({ status: 'Unshipped', purchaseDate, now }).toISOString()).toBe('2026-12-09T00:00:00.000Z')
  })

  it('企业可以把发货后的保留期缩短（P5-10），但不能超过亚马逊要求的 30 天；未发货的上限不受影响', () => {
    const shippedAt = new Date('2026-09-11T00:00:00Z')
    expect(piiExpiry({ status: 'Shipped', purchaseDate, shippedAt, now, retentionDays: 7 }).toISOString()).toBe('2026-09-18T00:00:00.000Z')
    expect(piiExpiry({ status: 'Shipped', purchaseDate, shippedAt, now, retentionDays: 45 }).toISOString()).toBe('2026-10-11T00:00:00.000Z')
    expect(piiExpiry({ status: 'Unshipped', purchaseDate, now, retentionDays: 7 }).toISOString()).toBe('2026-12-09T00:00:00.000Z')
  })
})

describe('订单新版接口写入', () => {
  it('一个订单写入订单头、状态历史、订单行、逐项金额、包裹；买家信息加密后写入，保留期按发货后 30 天', async () => {
    const { prisma, logger, of } = recorder()
    const box = secrets()
    const outcome = await writeOrder({ prisma, logger, secrets: box } as never, scope, parsed(sampleOrder()), NOW)
    expect(outcome).toBe('written')

    const order = of('order')[0].args
    expect(order.where.sellerAccountId_amazonOrderId_purchaseDate).toMatchObject({ sellerAccountId: 'sa1', amazonOrderId: '902-1845936-5435065' })
    expect(order.create).toMatchObject({
      tenantId: 't1',
      status: 'Shipped',
      fulfillmentStatus: 'SHIPPED',
      fulfillment: 'AFN',
      amount: 29.16,
      itemCount: 1,
      isReplacement: true,
      replacedOrderId: '902-0000000-0000001',
      programs: ['AMAZON_BUSINESS'],
      salesChannel: 'Amazon.com',
      piiCiphertext: expect.stringMatching(/^sealed/),
    })
    expect(order.create.piiExpiresAt.toISOString()).toBe('2026-10-11T09:00:00.000Z')
    expect(order.create.sourceUpdatedAt.toISOString()).toBe('2026-09-11T10:30:00.000Z')
    expect(order.create.sourceRecordId).toBe('902-1845936-5435065')
    expect(box.sealBuyerPii).toHaveBeenCalledTimes(1)
    expect(JSON.parse(box.sealBuyerPii.mock.calls[0][0] as string)).toMatchObject({ buyerEmail: 'jane@marketplace.amazon.com' })
    expect(JSON.stringify(of('order'))).not.toContain('jane@marketplace')

    expect(of('orderStatusHistory')[0].args.create).toMatchObject({ status: 'Shipped', source: 'API', orderId: 'order-1' })
    expect(of('orderItem')[0].args.where.sellerAccountId_orderItemId_orderPurchaseDate).toMatchObject({ orderItemId: '57727828203034' })
    expect(of('orderItem')[0].args.create).toMatchObject({ itemPrice: 27, promotionDiscount: 2, taxAmount: 2.16, fulfillmentNetwork: 'AMAZON' })
    expect(of('orderCharge', 'deleteMany')).toHaveLength(1)
    expect(of('orderCharge', 'createMany')[0].args.data).toHaveLength(7)
    expect(of('orderPackage')[0].args.where.sellerAccountId_orderId_packageId_trackingNumber).toMatchObject({ packageId: '1', trackingNumber: '1Z999AA10123456784' })
    expect(of('orderCancellation')).toHaveLength(0)
  })

  it('幂等：同一订单写两次，幂等键完全相同（重复拉取不产生重复记录）', async () => {
    const { prisma, logger, of } = recorder()
    const order = parsed(sampleOrder())
    await writeOrder({ prisma, logger, secrets: secrets() } as never, scope, order, NOW)
    await writeOrder({ prisma, logger, secrets: secrets() } as never, scope, order, NOW)
    const keys = (model: string, field: string) => of(model).map(call => JSON.stringify(call.args.where[field]))
    expect(new Set(keys('order', 'sellerAccountId_amazonOrderId_purchaseDate')).size).toBe(1)
    expect(new Set(keys('orderItem', 'sellerAccountId_orderItemId_orderPurchaseDate')).size).toBe(1)
    expect(new Set(keys('orderPackage', 'sellerAccountId_orderId_packageId_trackingNumber')).size).toBe(1)
    expect(new Set(keys('orderStatusHistory', 'orderId_status_sourceUpdatedAt')).size).toBe(1)
  })

  it('来源版本比库里已有的更旧时跳过，不覆盖较新的数据', async () => {
    const { prisma, logger, calls } = recorder({ 'order.findUnique': { sourceUpdatedAt: new Date('2026-09-12T00:00:00Z'), piiCiphertext: null, shippedAt: null } })
    const outcome = await writeOrder({ prisma, logger, secrets: secrets() } as never, scope, parsed(sampleOrder()), NOW)
    expect(outcome).toBe('stale')
    expect(calls.filter(call => call.op === 'upsert' || call.op === 'createMany')).toHaveLength(0)
  })

  it('取消订单：写取消记录；买家信息已到期则不写入也不加密', async () => {
    const { prisma, logger, of } = recorder()
    const box = secrets()
    const cancelled = parsed(
      sampleOrder({
        fulfillment: { fulfillmentStatus: 'CANCELLED' },
        packages: [],
        orderItems: [{ orderItemId: 'i1', quantityOrdered: 1, cancellation: { requester: 'SELLER', cancelReason: 'OUT_OF_STOCK' } }],
      }),
    )
    await writeOrder({ prisma, logger, secrets: box } as never, scope, cancelled, NOW)
    expect(of('orderCancellation')[0].args.create).toMatchObject({ cancelledBy: 'SELLER', reasonCode: 'OUT_OF_STOCK' })
    expect(of('order')[0].args.create.cancelledBy).toBe('SELLER')
    expect(of('order')[0].args.create.piiCiphertext).toBeUndefined()
    expect(box.sealBuyerPii).not.toHaveBeenCalled()
  })

  it('没有买家信息（无权限）时，已有的买家信息密文保持原样（update 不带密文字段）', async () => {
    const { prisma, logger, of } = recorder({ 'order.findUnique': { sourceUpdatedAt: new Date('2026-09-10T00:00:00Z'), piiCiphertext: 'old-cipher', shippedAt: null } })
    await writeOrder({ prisma, logger, secrets: secrets() } as never, scope, parsed(sampleOrder({ buyer: undefined, recipient: undefined })), NOW)
    expect('piiCiphertext' in of('order')[0].args.update).toBe(false)
    expect(of('order')[0].args.update.piiExpiresAt).toBeInstanceOf(Date)
  })
})

describe('订单新版接口同步', () => {
  const window = { after: '2026-09-01T00:00:00Z', before: '2026-09-08T00:00:00Z' }

  it('逐页取数、逐页一个事务；翻页带同样的时间窗与数据集；跳过的订单计数并告警', async () => {
    const { prisma, logger } = recorder()
    const searchOrders = vi
      .fn()
      .mockResolvedValueOnce({ orders: [sampleOrder(), sampleOrder({ orderId: '' })], pagination: { nextToken: 'p2' } })
      .mockResolvedValueOnce({ orders: [sampleOrder({ orderId: '902-0000000-0000002' })] })
    const digests: string[] = []
    const result = await syncOrdersV2026({ prisma, logger, secrets: secrets() } as never, { searchOrders }, scope, { window, onDigest: digest => digests.push(digest.amazonOrderId), now: () => NOW })
    expect(result).toMatchObject({ imported: 2, skipped: 1, stale: 0, pages: 2, piiRestricted: false })
    expect(digests).toEqual(['902-1845936-5435065', '902-0000000-0000002'])
    expect(searchOrders.mock.calls[0][0]).toMatchObject({ createdAfter: window.after, createdBefore: window.before, includedData: ORDERS_DATASETS })
    expect(searchOrders.mock.calls[1][0]).toMatchObject({ createdAfter: window.after, createdBefore: window.before, paginationToken: 'p2' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('买家信息保留天数取企业设置（P5-10）：设置了 7 天，发货后 7 天到期；没有设置按 30 天', async () => {
    const searchOrders = vi.fn(async () => ({ orders: [sampleOrder()] }))
    const custom = recorder({ 'tenantSetting.findFirst': { valueJson: { rawReportDays: 400, exportFileDays: 7, customerInfoDays: 7 } } })
    await syncOrdersV2026({ prisma: custom.prisma, logger: custom.logger, secrets: secrets() } as never, { searchOrders }, scope, { window, now: () => NOW })
    expect(custom.of('order')[0].args.create.piiExpiresAt.toISOString()).toBe('2026-09-18T09:00:00.000Z')
    const plain = recorder()
    await syncOrdersV2026({ prisma: plain.prisma, logger: plain.logger, secrets: secrets() } as never, { searchOrders }, scope, { window, now: () => NOW })
    expect(plain.of('order')[0].args.create.piiExpiresAt.toISOString()).toBe('2026-10-11T09:00:00.000Z')
  })

  it('店铺没有买家信息权限（403）：去掉买家数据集重试，订单照常写入并标注无权限', async () => {
    const { prisma, logger } = recorder()
    const denied = new UpstreamHttpError('SP_API_403', 403, undefined, 'api')
    const searchOrders = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce({ orders: [sampleOrder({ buyer: undefined, recipient: undefined })] })
    const result = await syncOrdersV2026({ prisma, logger, secrets: secrets() } as never, { searchOrders }, scope, { window, now: () => NOW })
    expect(result).toMatchObject({ imported: 1, piiRestricted: true })
    expect(searchOrders.mock.calls[1][0].includedData).toEqual(ORDERS_DATASETS_WITHOUT_PII)
    expect(searchOrders.mock.calls[1][0].includedData).not.toContain('BUYER')
  })

  it('其他错误原样抛出（交给任务重试），不被当成无权限吞掉', async () => {
    const { prisma, logger } = recorder()
    const searchOrders = vi.fn().mockRejectedValue(new UpstreamHttpError('SP_API_500', 500, undefined, 'api'))
    await expect(syncOrdersV2026({ prisma, logger, secrets: secrets() } as never, { searchOrders }, scope, { window })).rejects.toMatchObject({ status: 500 })
  })

  it('增量：按“最后更新时间”从上次成功时间前推 2 天；首次回补按下单时间分段', async () => {
    const { prisma, logger } = recorder()
    const searchOrders = vi.fn().mockResolvedValue({ orders: [] })
    const since = new Date('2026-09-10T00:00:00Z')
    await syncOrdersV2026({ prisma, logger, secrets: secrets() } as never, { searchOrders }, scope, { since })
    expect(searchOrders.mock.calls[0][0]).toMatchObject({ lastUpdatedAfter: '2026-09-08T00:00:00.000Z' })
    expect(searchOrders.mock.calls[0][0].createdAfter).toBeUndefined()
    searchOrders.mockClear()
    await syncOrdersV2026({ prisma, logger, secrets: secrets() } as never, { searchOrders }, scope, {})
    expect(searchOrders.mock.calls.length).toBeGreaterThan(1)
    expect(searchOrders.mock.calls[0][0].createdAfter).toBeTruthy()
  })
})
