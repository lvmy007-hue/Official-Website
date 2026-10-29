import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'
import { Readable } from 'node:stream'
import { recordFreshness } from '../../freshness/record'
import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { NtfSchemaError, parseItemInventoryEvent, parseItemSalesEvent, parsePageTrafficEvent } from './hourly-parse'

// 小时推送写入（P2a-03）：读对象存储消息体 → 解析 → 按 (asin, hourStart) upsert；sourceUpdatedAt 较新才覆盖。
// 店铺归属：优先用事件上的 sellerAccountId；否则用 payload.accountId 对 SellerAccount.sellerId 反查（同租户）。

export async function readJson(storage: Pick<ObjectStorage, 'openRead'>, key: string): Promise<unknown> {
  const chunks: Buffer[] = []
  const stream: Readable = await storage.openRead(key)
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new NtfSchemaError('消息体不是合法 JSON')
  }
}

export async function resolveSellerAccountId(db: Pick<PrismaClient, 'sellerAccount'>, tenantId: string, eventSellerAccountId: string | null, accountIds: readonly string[]): Promise<string | null> {
  if (eventSellerAccountId) return eventSellerAccountId
  const unique = [...new Set(accountIds.filter(Boolean))]
  if (unique.length === 0) return null
  const rows = await db.sellerAccount.findMany({
    where: { tenantId, sellerId: { in: unique } },
    select: { id: true, sellerId: true },
    take: 20,
  })
  if (rows.length === 1) return rows[0].id
  // 同一通知里多个 accountId 或找不到店铺：无法安全写入，抛结构化错误
  if (rows.length === 0) throw Object.assign(new Error('SELLER_ACCOUNT_UNRESOLVED'), { code: 'SELLER_ACCOUNT_UNRESOLVED' })
  throw Object.assign(new Error('SELLER_ACCOUNT_AMBIGUOUS'), { code: 'SELLER_ACCOUNT_AMBIGUOUS' })
}

type UpsertSales = {
  tenantId: string
  sellerAccountId: string
  asin: string
  hourStart: Date
  units: number
  salesAmount: number
  currency: string
  isLateArrival: boolean
  sourceUpdatedAt: Date
}

async function upsertSales(db: Pick<PrismaClient, 'hourlySalesEvent'>, row: UpsertSales) {
  const existing = await db.hourlySalesEvent.findFirst({
    where: { tenantId: row.tenantId, sellerAccountId: row.sellerAccountId, asin: row.asin, hourStart: row.hourStart },
    select: { id: true, sourceUpdatedAt: true, hourStart: true },
  })
  if (existing) {
    if (existing.sourceUpdatedAt >= row.sourceUpdatedAt) return
    await db.hourlySalesEvent.update({
      where: { id_hourStart: { id: existing.id, hourStart: existing.hourStart } },
      data: {
        units: row.units,
        salesAmount: row.salesAmount,
        currency: row.currency,
        isLateArrival: row.isLateArrival,
        sourceUpdatedAt: row.sourceUpdatedAt,
      },
    })
    return
  }
  await db.hourlySalesEvent.create({
    data: {
      tenantId: row.tenantId,
      sellerAccountId: row.sellerAccountId,
      asin: row.asin,
      hourStart: row.hourStart,
      units: row.units,
      salesAmount: row.salesAmount,
      currency: row.currency,
      orders: 0,
      isLateArrival: row.isLateArrival,
      sourceUpdatedAt: row.sourceUpdatedAt,
    },
  })
}

async function upsertTraffic(
  db: Pick<PrismaClient, 'hourlyTrafficEvent'>,
  row: { tenantId: string; sellerAccountId: string; asin: string; hourStart: Date; pageViews: number; isLateArrival: boolean; sourceUpdatedAt: Date },
) {
  const existing = await db.hourlyTrafficEvent.findFirst({
    where: { tenantId: row.tenantId, sellerAccountId: row.sellerAccountId, asin: row.asin, hourStart: row.hourStart },
    select: { id: true, sourceUpdatedAt: true, hourStart: true },
  })
  if (existing) {
    if (existing.sourceUpdatedAt >= row.sourceUpdatedAt) return
    await db.hourlyTrafficEvent.update({
      where: { id_hourStart: { id: existing.id, hourStart: existing.hourStart } },
      data: { pageViews: row.pageViews, isLateArrival: row.isLateArrival, sourceUpdatedAt: row.sourceUpdatedAt },
    })
    return
  }
  await db.hourlyTrafficEvent.create({
    data: {
      tenantId: row.tenantId,
      sellerAccountId: row.sellerAccountId,
      asin: row.asin,
      hourStart: row.hourStart,
      pageViews: row.pageViews,
      isLateArrival: row.isLateArrival,
      sourceUpdatedAt: row.sourceUpdatedAt,
    },
  })
}

async function upsertInventory(
  db: Pick<PrismaClient, 'hourlyInventoryEvent'>,
  row: { tenantId: string; sellerAccountId: string; asin: string; hourStart: Date; availableQty: number; isLateArrival: boolean; sourceUpdatedAt: Date },
) {
  const existing = await db.hourlyInventoryEvent.findFirst({
    where: { tenantId: row.tenantId, sellerAccountId: row.sellerAccountId, asin: row.asin, hourStart: row.hourStart },
    select: { id: true, sourceUpdatedAt: true, hourStart: true },
  })
  if (existing) {
    if (existing.sourceUpdatedAt >= row.sourceUpdatedAt) return
    await db.hourlyInventoryEvent.update({
      where: { id_hourStart: { id: existing.id, hourStart: existing.hourStart } },
      data: { availableQty: row.availableQty, isLateArrival: row.isLateArrival, sourceUpdatedAt: row.sourceUpdatedAt },
    })
    return
  }
  await db.hourlyInventoryEvent.create({
    data: {
      tenantId: row.tenantId,
      sellerAccountId: row.sellerAccountId,
      asin: row.asin,
      hourStart: row.hourStart,
      availableQty: row.availableQty,
      isLateArrival: row.isLateArrival,
      sourceUpdatedAt: row.sourceUpdatedAt,
    },
  })
}

export type HourlyProcessorDeps = {
  db: PrismaClient
  storage: Pick<ObjectStorage, 'openRead'>
}

export function createSalesProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const raw = await readJson(deps.storage, event.payloadObjectKey)
    const rows = parseItemSalesEvent(raw)
    const sellerAccountId = await resolveSellerAccountId(
      deps.db,
      event.tenantId,
      event.sellerAccountId,
      rows.map(r => r.accountId),
    )
    if (!sellerAccountId) return
    for (const row of rows) {
      await upsertSales(deps.db, {
        tenantId: event.tenantId,
        sellerAccountId,
        asin: row.asin,
        hourStart: row.hourStart,
        units: row.units,
        salesAmount: row.salesAmount,
        currency: row.currency,
        isLateArrival: row.isLateArrival,
        sourceUpdatedAt: row.sourceUpdatedAt,
      })
    }
    await recordFreshness(deps.db, {
      tenantId: event.tenantId,
      sellerAccountId,
      sourceKey: 'ntf.item-sales',
      ok: true,
      rowCount: rows.length,
      dataThrough: rows.reduce<Date | null>((max, row) => (!max || row.hourStart > max ? row.hourStart : max), null),
    })
  }
}

export function createTrafficProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const raw = await readJson(deps.storage, event.payloadObjectKey)
    const rows = parsePageTrafficEvent(raw)
    const sellerAccountId = await resolveSellerAccountId(
      deps.db,
      event.tenantId,
      event.sellerAccountId,
      rows.map(r => r.accountId),
    )
    if (!sellerAccountId) return
    for (const row of rows) {
      await upsertTraffic(deps.db, {
        tenantId: event.tenantId,
        sellerAccountId,
        asin: row.asin,
        hourStart: row.hourStart,
        pageViews: row.pageViews,
        isLateArrival: row.isLateArrival,
        sourceUpdatedAt: row.sourceUpdatedAt,
      })
    }
    await recordFreshness(deps.db, {
      tenantId: event.tenantId,
      sellerAccountId,
      sourceKey: 'ntf.page-traffic',
      ok: true,
      rowCount: rows.length,
      dataThrough: rows.reduce<Date | null>((max, row) => (!max || row.hourStart > max ? row.hourStart : max), null),
    })
  }
}

export function createInventoryProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const raw = await readJson(deps.storage, event.payloadObjectKey)
    const rows = parseItemInventoryEvent(raw)
    const sellerAccountId = await resolveSellerAccountId(
      deps.db,
      event.tenantId,
      event.sellerAccountId,
      rows.map(r => r.accountId),
    )
    if (!sellerAccountId) return
    for (const row of rows) {
      await upsertInventory(deps.db, {
        tenantId: event.tenantId,
        sellerAccountId,
        asin: row.asin,
        hourStart: row.hourStart,
        availableQty: row.availableQty,
        isLateArrival: row.isLateArrival,
        sourceUpdatedAt: row.sourceUpdatedAt,
      })
    }
    await recordFreshness(deps.db, {
      tenantId: event.tenantId,
      sellerAccountId,
      sourceKey: 'ntf.item-inventory',
      ok: true,
      rowCount: rows.length,
      dataThrough: rows.reduce<Date | null>((max, row) => (!max || row.hourStart > max ? row.hourStart : max), null),
    })
  }
}

export function registerHourlyNotificationProcessors(
  registry: { register(type: string, processor: NotificationProcessor): { register(type: string, processor: NotificationProcessor): unknown } },
  deps: HourlyProcessorDeps,
) {
  registry.register('ITEM_SALES_EVENT_CHANGE', createSalesProcessor(deps))
  registry.register('DETAIL_PAGE_TRAFFIC_EVENT', createTrafficProcessor(deps))
  registry.register('ITEM_INVENTORY_EVENT_CHANGE', createInventoryProcessor(deps))
}
