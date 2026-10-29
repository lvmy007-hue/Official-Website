import { Prisma } from '@prisma/client'
import { AwdApi, isAwdNotEnrolled } from '../../connectors/awd-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import { skuDetailsOf } from './packages'
import { parseAwdInventory, parseAwdOrder, parseShipment, parseShipmentSummaries } from './parse'

// 上游仓储同步器（importers.md I-08，P2a-08）：库存快照 → AwdInventory；入库货件（含按 SKU 的预期与接收数量）→ AwdInboundShipment、AwdShipmentItem；
// 入库订单 → AwdInboundOrder。官方没有“列出入库订单”的操作：订单编号来自货件，外加我方已提交且未结束的订单，逐个按编号读取。
// “不适用”：店铺没有开通上游仓储 → 返回 notApplicable，不写任何行、不补 0；缺少角色（403）等其他错误原样抛出，不被吞掉。

export interface AwdSyncScope {
  tenantId: string
  sellerAccountId: string
}
export interface AwdSyncOptions {
  /** 企业数据口径的“今天”（UTC 零点的日期）：库存快照日期。 */
  today: Date
}
export type AwdSyncResult =
  { notApplicable: true; reason: 'NOT_ENROLLED'; imported: 0 } | { notApplicable: false; imported: number; inventory: number; shipments: number; orders: number; skipped: number; incomplete: boolean }

/** 单次同步最多翻页与逐个读取的数量：超过时收尾并标注“可能不完整”，下次增量继续。 */
export const MAX_PAGES = 100
export const MAX_DETAILS = 300
const OPEN_ORDER_STATUSES = ['DRAFT', 'VALIDATING', 'CONFIRMED']
const json = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue))

async function syncInventory(ctx: ImportContext, api: AwdApi, scope: AwdSyncScope, today: Date, sourceUpdatedAt: Date) {
  const { prisma } = ctx
  const seen = new Set<string>()
  let skipped = 0
  let incomplete = false
  let nextToken: string | undefined
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      incomplete = true
      break
    }
    const parsed = parseAwdInventory(await api.listInventory(nextToken))
    skipped += parsed.skipped
    for (const row of parsed.rows) {
      seen.add(row.sku)
      const data = {
        onhandQty: row.onhandQty,
        availableQty: row.availableQty,
        reservedForReplenishment: row.reservedForReplenishment,
        inboundToAwdQty: row.inboundToAwdQty,
        outboundToFbaInTransit: row.outboundToFbaInTransit,
        expiryDate: row.expiryDate,
        expirationJson: json(row.expirations.length ? row.expirations : null),
        sourceUpdatedAt,
      }
      await prisma.awdInventory.upsert({
        where: { tenantId_sellerAccountId_sku_snapshotDate: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, sku: row.sku, snapshotDate: today } },
        create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, snapshotDate: today, sku: row.sku, ...data },
        update: data,
      })
    }
    if (!parsed.nextToken) break
    nextToken = parsed.nextToken
  }
  // 翻页完整时，今天已写入但这次没有返回的 SKU（库存已清零移出）删掉，避免把旧数字当成今天的快照
  if (!incomplete) {
    const stale = await prisma.awdInventory.findMany({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, snapshotDate: today },
      select: { id: true, sku: true },
      take: 20_000,
    })
    const ids = stale.filter(row => !seen.has(row.sku)).map(row => row.id)
    if (ids.length) await prisma.awdInventory.deleteMany({ where: { id: { in: ids } } })
  }
  return { count: seen.size, skipped, incomplete }
}

async function syncShipments(ctx: ImportContext, api: AwdApi, scope: AwdSyncScope, sourceUpdatedAt: Date) {
  const { prisma } = ctx
  // 增量起点 = 已入库货件里最新的亚马逊更新时间（留 1 天重叠）。列表按更新时间从旧到新取：单次到上限收尾时，已处理的永远是更旧的一批，
  // 起点只会前进，不会漏掉没处理的货件。
  const latest = await prisma.awdInboundShipment.aggregate({ where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId }, _max: { amazonUpdatedAt: true } })
  const updatedAfter = latest._max.amazonUpdatedAt ? new Date(latest._max.amazonUpdatedAt.getTime() - 86_400_000).toISOString() : undefined
  const summaries = new Map<string, { orderId: string | null }>()
  let skipped = 0
  let incomplete = false
  let nextToken: string | undefined
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      incomplete = true
      break
    }
    const parsed = parseShipmentSummaries(await api.listShipments({ updatedAfter, nextToken }))
    skipped += parsed.skipped
    for (const summary of parsed.summaries) summaries.set(summary.shipmentId, { orderId: summary.orderId })
    if (!parsed.nextToken) break
    nextToken = parsed.nextToken
  }
  const orderIds = new Set<string>()
  let count = 0
  for (const shipmentId of summaries.keys()) {
    if (count >= MAX_DETAILS) {
      incomplete = true
      break
    }
    const parsed = parseShipment(await api.getShipment(shipmentId))
    skipped += parsed.skipped
    const shipment = parsed.shipment
    if (!shipment) continue
    if (shipment.orderId) orderIds.add(shipment.orderId)
    const data = {
      orderId: shipment.orderId,
      externalReferenceId: shipment.externalReferenceId,
      status: shipment.status,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      destinationRegion: shipment.destinationRegion,
      destinationAddressJson: json(shipment.destinationAddress),
      shipBy: shipment.shipBy,
      warehouseReferenceId: shipment.warehouseReferenceId,
      amazonCreatedAt: shipment.amazonCreatedAt,
      amazonUpdatedAt: shipment.amazonUpdatedAt,
      sourceUpdatedAt,
    }
    await prisma.awdInboundShipment.upsert({
      where: { tenantId_sellerAccountId_shipmentId: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId } },
      create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId, ...data },
      update: data,
    })
    for (const item of shipment.items) {
      const itemData = { expectedQty: item.expectedQty, receivedQty: item.receivedQty, unit: item.unit, sourceUpdatedAt }
      await prisma.awdShipmentItem.upsert({
        where: { tenantId_sellerAccountId_shipmentId_sku: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId, sku: item.sku } },
        create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId, sku: item.sku, ...itemData },
        update: itemData,
      })
    }
    count += 1
  }
  return { count, orderIds, skipped, incomplete }
}

async function syncOrders(ctx: ImportContext, api: AwdApi, scope: AwdSyncScope, orderIds: Set<string>, sourceUpdatedAt: Date) {
  const { prisma, logger } = ctx
  // 我方已提交且未结束的订单也要刷新状态（草稿 → 校验中 → 已确认）；订单没有货件之前，只能这样发现状态变化
  const open = await prisma.awdInboundOrder.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, orderId: { not: null }, status: { in: OPEN_ORDER_STATUSES } },
    select: { orderId: true },
    take: 2000,
  })
  for (const row of open) if (row.orderId) orderIds.add(row.orderId)
  let count = 0
  let skipped = 0
  let incomplete = false
  for (const orderId of orderIds) {
    if (count >= MAX_DETAILS) {
      incomplete = true
      break
    }
    let body
    try {
      body = await api.getOrder(orderId)
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.source === 'api' && error.status === 404) {
        skipped += 1
        continue
      }
      throw error
    }
    const parsed = parseAwdOrder(body)
    skipped += parsed.skipped
    if (parsed.unknownStatus !== null) logger.warn({ ...scope, orderId, status: parsed.unknownStatus }, 'awd order has an unknown status; kept as is')
    const order = parsed.order
    if (!order) continue
    const existing = await prisma.awdInboundOrder.findFirst({ where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, orderId } })
    const shipments = await prisma.awdInboundShipment.findMany({ where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, orderId }, select: { shipmentId: true }, take: 50 })
    const shipmentIds = shipments.map(row => row.shipmentId)
    const received = shipmentIds.length
      ? await prisma.awdShipmentItem.aggregate({
          where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId: { in: shipmentIds }, receivedQty: { not: null }, unit: 'PRODUCT_UNITS' },
          _sum: { receivedQty: true },
        })
      : null
    const data = {
      status: order.status,
      externalReferenceId: order.externalReferenceId ?? existing?.externalReferenceId ?? null,
      expectedUnits: order.expectedUnits,
      receivedUnits: received?._sum.receivedQty ?? null,
      packageDeliveryMode: order.deliveryMode,
      originAddressJson: json(order.originAddress),
      packagesJson: json(order.packages),
      preferredRegion: order.preferredRegion,
      destinationRegion: order.destinationRegion,
      amazonCreatedAt: order.amazonCreatedAt,
      amazonUpdatedAt: order.amazonUpdatedAt,
      sourceUpdatedAt,
    }
    // 有后台写入在途的订单由写入流程负责落状态，同步不抢写
    if (existing && !existing.pendingAction) await prisma.awdInboundOrder.update({ where: { id: existing.id }, data: { ...data, lastErrorCode: null, lastErrorMessage: null } })
    else if (!existing) await prisma.awdInboundOrder.create({ data: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, orderId, ...data } })
    // 有效期与预处理信息在订单里，补进该订单货件的明细
    for (const [sku, detail] of skuDetailsOf(order.packagesRaw)) {
      if (!shipmentIds.length) break
      await prisma.awdShipmentItem.updateMany({
        where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, shipmentId: { in: shipmentIds }, sku },
        data: { expiryDate: detail.expiryDate ? new Date(`${detail.expiryDate}T00:00:00Z`) : null, prepInfoJson: json(detail.prep) },
      })
    }
    count += 1
  }
  return { count, skipped, incomplete }
}

export async function syncAwd(ctx: ImportContext, api: AwdApi, scope: AwdSyncScope, options: AwdSyncOptions): Promise<AwdSyncResult> {
  const sourceUpdatedAt = new Date()
  // 1. 库存：第一页就报“没开通” → 不适用
  let inventory
  try {
    inventory = await syncInventory(ctx, api, scope, options.today, sourceUpdatedAt)
  } catch (error) {
    if (isAwdNotEnrolled(error)) return { notApplicable: true, reason: 'NOT_ENROLLED', imported: 0 }
    throw error
  }
  const shipments = await syncShipments(ctx, api, scope, sourceUpdatedAt)
  const orders = await syncOrders(ctx, api, scope, shipments.orderIds, sourceUpdatedAt)
  const skipped = inventory.skipped + shipments.skipped + orders.skipped
  const incomplete = inventory.incomplete || shipments.incomplete || orders.incomplete
  if (skipped > 0) ctx.logger.warn({ ...scope, skipped }, 'awd rows skipped: missing identifiers or unparsable packages')
  if (incomplete) ctx.logger.warn({ ...scope }, 'awd sync reached the page or detail limit; remaining rows are picked up by the next incremental sync')
  return { notApplicable: false, imported: inventory.count + shipments.count + orders.count, inventory: inventory.count, shipments: shipments.count, orders: orders.count, skipped, incomplete }
}
