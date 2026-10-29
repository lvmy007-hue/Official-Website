import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AwdPackageInput } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import { AwdApi, isAwdNotEnrolled } from '../../connectors/awd-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import { fromAmazonPackages, skuDetailsOf, toAmazonPackages } from './packages'
import { parseAwdInventory, parseAwdOrder, parseShipment, parseShipmentSummaries } from './parse'
import { syncAwd } from './sync'

// 上游仓储（I-08）：官方格式的响应样例（apps/worker/fixtures/awd）→ 解析结果、写入的表与幂等键；
// 不适用与缺角色的区分；分页；缺失的字段保持 null，不补 0；包装格式在“我方格式”与“亚马逊格式”之间无损往返。

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../fixtures/awd', name), 'utf8')) as Record<string, unknown>
const TODAY = new Date('2026-10-22T00:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const http = (status: number, message = '') => new UpstreamHttpError(`SP_API_${status}_${message}`, status, undefined, 'api')

describe('响应解析', () => {
  it('库存：字段搬运；没给的是 null（不补 0）；有效期取“有在库数量”的最早到期日；没有 SKU 的行计入跳过', () => {
    const page = parseAwdInventory(fixture('inventory.json'))
    expect(page.skipped).toBe(1)
    expect(page.nextToken).toBe('TOKEN-2')
    expect(page.rows[0]).toMatchObject({
      sku: 'SKU-A',
      onhandQty: 480,
      availableQty: 400,
      reservedForReplenishment: 50,
      inboundToAwdQty: 120,
      outboundToFbaInTransit: 30,
      expiryDate: new Date('2027-01-10T00:00:00Z'),
    })
    expect(page.rows[0].expirations).toHaveLength(3)
    expect(page.rows[1]).toMatchObject({ sku: 'SKU-B', onhandQty: 0, availableQty: 0, reservedForReplenishment: null, outboundToFbaInTransit: null, expiryDate: null })
    expect(page.rows[2]).toMatchObject({ sku: 'SKU-C', onhandQty: 75, availableQty: null, inboundToAwdQty: null })
  })

  it('货件列表：没有货件编号的行计入跳过；响应包一层 payload 也能解析', () => {
    const page = parseShipmentSummaries(fixture('shipments.json'))
    expect(page.skipped).toBe(1)
    expect(page.summaries).toEqual([
      { shipmentId: 'SHIP-1', orderId: 'ORD-1', updatedAt: new Date('2026-10-20T08:00:00Z') },
      { shipmentId: 'SHIP-2', orderId: 'ORD-2', updatedAt: new Date('2026-10-21T09:30:00Z') },
    ])
    expect(parseShipmentSummaries({ payload: fixture('shipments.json') }).summaries).toHaveLength(2)
  })

  it('货件详情：按 SKU 的预期与接收数量；没给接收数量的是 null；未知状态记为 UNKNOWN 而不是丢行', () => {
    const { shipment, skipped } = parseShipment(fixture('shipment-detail.json'))
    expect(skipped).toBe(1)
    expect(shipment).toMatchObject({ shipmentId: 'SHIP-1', orderId: 'ORD-1', status: 'RECEIVING', carrier: 'ABCD', trackingNumber: 'TRACK-1', destinationRegion: 'us-east' })
    expect(shipment?.items).toEqual([
      { sku: 'SKU-A', expectedQty: 120, receivedQty: 40, unit: 'PRODUCT_UNITS' },
      { sku: 'SKU-B', expectedQty: 60, receivedQty: null, unit: 'PRODUCT_UNITS' },
    ])
    expect(parseShipment({ ...fixture('shipment-detail.json'), shipmentStatus: 'SOMETHING_NEW' }).shipment?.status).toBe('UNKNOWN')
    expect(parseShipment({}).shipment).toBeNull()
  })

  it('入库订单：总件数按“箱数 × 每箱件数”与托盘里的箱累加；包装方式混合；订单状态未知时不猜测', () => {
    const { order } = parseAwdOrder(fixture('order.json'))
    expect(order).toMatchObject({ orderId: 'ORD-1', status: 'CONFIRMED', expectedUnits: 180, deliveryMode: 'MIXED', shipmentId: 'SHIP-1', preferredRegion: 'us-east', destinationRegion: 'us-east' })
    const unknown = parseAwdOrder({ ...fixture('order.json'), orderStatus: 'PAUSED' })
    expect(unknown.order).toBeNull()
    expect(unknown.unknownStatus).toBe('PAUSED')
  })

  it('订单里有解析不了的包装时不给总件数（宁可不显示也不显示不完整的数字）', () => {
    const body = fixture('order.json')
    const broken = { ...body, packagesToInbound: [...(body.packagesToInbound as unknown[]), { count: 1, distributionPackage: { type: 'BOX' } }] }
    const parsed = parseAwdOrder(broken)
    expect(parsed.skipped).toBe(1)
    expect(parsed.order?.expectedUnits).toBeNull()
  })
})

describe('包装格式转换', () => {
  const ours: AwdPackageInput[] = [
    {
      type: 'CASE',
      count: 10,
      measurements: { weight: { value: 12.5, unit: 'POUNDS' }, dimensions: { length: 20, width: 15, height: 10, unit: 'INCHES' } },
      products: [{ sku: 'SKU-A', quantity: 12, expiration: '2027-06-30' }],
    },
  ]

  it('发往亚马逊：预处理方与贴标方固定为卖家（没有“由亚马逊处理”的取值）；到期日补成日期时间', () => {
    const body = JSON.stringify(toAmazonPackages(ours))
    expect(body).toContain('"prepOwner":"SELF"')
    expect(body).toContain('"labelOwner":"SELF"')
    expect(body).not.toContain('AMAZON')
    expect(body).toContain('"expiration":"2027-06-30T00:00:00Z"')
  })

  it('往返无损；有效期与预处理信息按 SKU 取出（同一 SKU 取最早到期日）', () => {
    expect(fromAmazonPackages(toAmazonPackages(ours))).toEqual({ packages: ours, skipped: 0 })
    const details = skuDetailsOf([
      ...(fixture('order.json').packagesToInbound as unknown[]),
      ...toAmazonPackages([{ ...ours[0], products: [{ sku: 'SKU-A', quantity: 1, expiration: '2027-01-01' }] }]),
    ])
    expect(details.get('SKU-A')?.expiryDate).toBe('2027-01-01')
    expect(details.get('SKU-B')?.expiryDate).toBeNull()
  })
})

describe('连接器与“未开通”判断', () => {
  it('路径、参数与官方模型一致：库存与货件详情带明细开关；写操作的方法与请求体正确', async () => {
    const request = vi.fn(async () => null)
    const api = new AwdApi({ request } as unknown as AmazonSpApiClient)
    await api.listInventory('T1')
    await api.getShipment('SHIP 1')
    await api.listShipments({ updatedAfter: '2026-10-01T00:00:00Z', nextToken: 'N' })
    await api.updateOrder('ORD-1', { a: 1 })
    await api.confirmOrder('ORD-1')
    await api.cancelOrder('ORD-1')
    await api.updateTransport('SHIP-1', { carrierCode: 'ABCD', bookingId: 'BK-1' })
    const calls = request.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(calls[0][0]).toEqual({ path: '/awd/2024-05-09/inventory', query: { details: 'SHOW', maxResults: '200', nextToken: 'T1' } })
    expect(calls[1][0]).toEqual({ path: '/awd/2024-05-09/inboundShipments/SHIP%201', query: { skuQuantities: 'SHOW' } })
    expect(calls[2][0]).toMatchObject({ path: '/awd/2024-05-09/inboundShipments', query: { sortBy: 'UPDATED_AT', sortOrder: 'ASCENDING', updatedAfter: '2026-10-01T00:00:00Z', nextToken: 'N' } })
    expect(calls[3][0]).toEqual({ method: 'PUT', path: '/awd/2024-05-09/inboundOrders/ORD-1', body: { a: 1 } })
    expect(calls[4][0]).toEqual({ method: 'POST', path: '/awd/2024-05-09/inboundOrders/ORD-1/confirmation' })
    expect(calls[5][0]).toEqual({ method: 'POST', path: '/awd/2024-05-09/inboundOrders/ORD-1/cancellation' })
    expect(calls[6][0]).toEqual({
      method: 'PUT',
      path: '/awd/2024-05-09/inboundShipments/SHIP-1/transport',
      body: { trackingDetails: [{ bookingId: 'BK-1', carrierCode: { carrierCodeType: 'SCAC', carrierCodeValue: 'ABCD' } }] },
    })
  })

  it('创建订单返回编号；标签请求只取 PDF；没有下载链接时给 null', async () => {
    const request = vi.fn(async (options: { method?: string }) => (options.method === 'POST' ? { orderId: 'ORD-9' } : { labelStatus: 'GENERATING' }))
    const api = new AwdApi({ request } as unknown as AmazonSpApiClient)
    expect(await api.createOrder({ x: 1 })).toEqual({ orderId: 'ORD-9' })
    expect(await api.getLabels('SHIP-1')).toEqual({ labelStatus: 'GENERATING', url: null })
    expect((request.mock.calls[1] as unknown as [{ query: unknown }])[0].query).toEqual({ pageType: 'PLAIN_PAPER', formatType: 'PDF' })
  })

  it('只有 404 与带“未开通”字样的 400 算未开通；403、429、5xx 与授权服务的错误都不算', () => {
    expect(isAwdNotEnrolled(http(404))).toBe(true)
    expect(isAwdNotEnrolled(http(400, 'Seller is not enrolled in AWD'))).toBe(true)
    expect(isAwdNotEnrolled(http(400, 'Invalid maxResults'))).toBe(false)
    expect(isAwdNotEnrolled(http(403))).toBe(false)
    expect(isAwdNotEnrolled(http(429))).toBe(false)
    expect(isAwdNotEnrolled(http(503))).toBe(false)
    expect(isAwdNotEnrolled(new UpstreamHttpError('x', 404, undefined, 'lwa'))).toBe(false)
    expect(isAwdNotEnrolled(new Error('boom'))).toBe(false)
  })
})

// 数据库替身：按“模型.操作”登记返回值，其余操作返回 null；记录全部调用
type Loose = ReturnType<typeof JSON.parse>
function stubContext(handlers: Record<string, (args: Loose) => unknown> = {}) {
  const calls: Array<{ key: string; args: Loose }> = []
  const prisma = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_i, op: string) => async (args: Loose) => {
              calls.push({ key: `${model}.${op}`, args })
              return handlers[`${model}.${op}`]?.(args) ?? null
            },
          },
        ),
    },
  ) as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  const of = (key: string) => calls.filter(call => call.key === key)
  return { ctx, calls, of, warn }
}

const stubApi = (overrides: Record<string, unknown> = {}) => {
  const api = {
    listInventory: vi.fn(async (token?: string) => (token ? { inventory: [{ sku: 'SKU-D', totalOnhandQuantity: 5 }] } : fixture('inventory.json'))),
    listShipments: vi.fn(async () => fixture('shipments.json')),
    getShipment: vi.fn(async (id: string) => (id === 'SHIP-1' ? fixture('shipment-detail.json') : { shipmentId: id, orderId: 'ORD-2', shipmentStatus: 'CREATED', shipmentSkuQuantities: [] })),
    getOrder: vi.fn(async (id: string) => (id === 'ORD-1' ? fixture('order.json') : Promise.reject(http(404, 'not found')))),
    ...overrides,
  }
  return { api, as: api as unknown as AwdApi }
}
const handlers = {
  'awdInventory.findMany': () => [{ id: 'old-1', sku: 'SKU-OLD' }],
  'awdInboundShipment.aggregate': () => ({ _max: { amazonUpdatedAt: null } }),
  'awdInboundOrder.findMany': () => [],
  'awdInboundShipment.findMany': () => [{ shipmentId: 'SHIP-1' }],
  'awdShipmentItem.aggregate': () => ({ _sum: { receivedQty: 40 } }),
}

describe('同步上游仓储', () => {
  it('库存分页写入（快照日期 + 幂等键）、删除今天已不存在的 SKU；货件与明细、订单与有效期补全', async () => {
    const { ctx, of } = stubContext(handlers)
    const { api, as } = stubApi()
    const result = await syncAwd(ctx, as, scope, { today: TODAY })
    expect(result).toMatchObject({ notApplicable: false, inventory: 4, shipments: 2, orders: 1, incomplete: false, skipped: 4 })
    expect(api.listInventory.mock.calls.map(call => call[0])).toEqual([undefined, 'TOKEN-2'])
    const inventory = of('awdInventory.upsert')
    expect(inventory).toHaveLength(4)
    expect(inventory[0].args.where).toEqual({ tenantId_sellerAccountId_sku_snapshotDate: { tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-A', snapshotDate: TODAY } })
    expect(inventory[2].args.create).toMatchObject({ sku: 'SKU-C', onhandQty: 75, availableQty: null, inboundToAwdQty: null })
    expect(of('awdInventory.deleteMany')[0].args).toEqual({ where: { id: { in: ['old-1'] } } })
    expect(of('awdInboundShipment.upsert').map(call => call.args.create.shipmentId)).toEqual(['SHIP-1', 'SHIP-2'])
    expect(of('awdShipmentItem.upsert').map(call => [call.args.create.sku, call.args.create.expectedQty, call.args.create.receivedQty])).toEqual([
      ['SKU-A', 120, 40],
      ['SKU-B', 60, null],
    ])
    const created = of('awdInboundOrder.create')
    expect(created).toHaveLength(1)
    expect(created[0].args.data).toMatchObject({ orderId: 'ORD-1', status: 'CONFIRMED', expectedUnits: 180, receivedUnits: 40, packageDeliveryMode: 'MIXED' })
    // 有效期来自订单里的包装：SKU-A 2027-06-30，SKU-B 没有
    const enrich = of('awdShipmentItem.updateMany').map(call => [call.args.where.sku, call.args.data.expiryDate])
    expect(enrich).toEqual([
      ['SKU-A', new Date('2027-06-30T00:00:00Z')],
      ['SKU-B', null],
    ])
  })

  it('增量：已入库货件里最新的更新时间减 1 天作为起点；已有订单更新、有后台写入在途的订单不被同步覆盖', async () => {
    const latest = new Date('2026-10-20T08:00:00Z')
    const { ctx, of } = stubContext({
      ...handlers,
      'awdInboundShipment.aggregate': () => ({ _max: { amazonUpdatedAt: latest } }),
      'awdInboundOrder.findFirst': () => ({ id: 'row-1', pendingAction: 'CONFIRM', externalReferenceId: 'NOVA-REF-1' }),
    })
    const { api, as } = stubApi()
    await syncAwd(ctx, as, scope, { today: TODAY })
    expect(api.listShipments).toHaveBeenCalledWith({ updatedAfter: '2026-10-19T08:00:00.000Z', nextToken: undefined })
    expect(of('awdInboundOrder.update')).toHaveLength(0)
    expect(of('awdInboundOrder.create')).toHaveLength(0)
  })

  it('没有开通上游仓储（库存 404）：不适用，什么都不写；缺少角色（403）与限流错误原样抛出', async () => {
    const empty = stubContext(handlers)
    expect(await syncAwd(empty.ctx, stubApi({ listInventory: vi.fn(async () => Promise.reject(http(404))) }).as, scope, { today: TODAY })).toEqual({
      notApplicable: true,
      reason: 'NOT_ENROLLED',
      imported: 0,
    })
    expect(empty.calls).toHaveLength(0)
    const denied = stubContext(handlers)
    await expect(syncAwd(denied.ctx, stubApi({ listInventory: vi.fn(async () => Promise.reject(http(403))) }).as, scope, { today: TODAY })).rejects.toMatchObject({ status: 403 })
    await expect(syncAwd(denied.ctx, stubApi({ listShipments: vi.fn(async () => Promise.reject(http(429))) }).as, scope, { today: TODAY })).rejects.toMatchObject({ status: 429 })
  })

  it('我方已提交且未结束的订单也会刷新状态（订单还没有货件时靠这个发现状态变化）', async () => {
    const { ctx } = stubContext({ ...handlers, 'awdInboundOrder.findMany': () => [{ orderId: 'ORD-OPEN' }] })
    const { api, as } = stubApi({ listShipments: vi.fn(async () => ({ shipments: [] })) })
    await syncAwd(ctx, as, scope, { today: TODAY })
    expect(api.getOrder.mock.calls.map(call => call[0])).toEqual(['ORD-OPEN'])
  })
})
