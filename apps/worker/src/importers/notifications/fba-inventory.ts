import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { recordFreshness } from '../../freshness/record'
import { tenantTimeZone } from '../../derivers/summary-sql'
import { localDay } from '../shared'
import { NtfSchemaError } from './hourly-parse'
import { readJson, resolveSellerAccountId, type HourlyProcessorDeps } from './hourly-write'

// 亚马逊物流库存变化推送（FBA_INVENTORY_AVAILABILITY_CHANGES，importers.md N-04，P2a-05）。
// 推送只携带“可售数量”的变化：写进当日 API 来源的库存快照里的 sellable，其余列保持 I-05 刷新写入的值（不是 0，也不是猜的）；
// 完整数量（在途、预留、不可售）仍由每 30 分钟的库存同步补齐。字段名按官方文档整理，未经真实推送验证（CR-028 已披露）：
// 容忍两种形态——行内直接带 marketplaceId + 可售数量，或带按站点列出的数组 fulfillmentInventoryByMarketplace。

const US = 'ATVPDKIKX0DER'

export type FbaInventoryChange = {
  accountId: string
  sku: string
  fnsku: string
  asin: string
  marketplaceId: string
  sellable: number
  sourceUpdatedAt: Date
}

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const quantity = (row: Record<string, unknown>) => {
  for (const key of ['fulfillableQuantity', 'availableQuantity', 'sellableQuantity']) {
    const value = row[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  }
  return null
}

export function parseFbaInventoryChanges(raw: unknown): FbaInventoryChange[] {
  const root = obj(raw)
  if (!root) throw new NtfSchemaError('通知根对象必须是对象')
  const type = text(root.notificationType)
  if (type !== 'FBA_INVENTORY_AVAILABILITY_CHANGES') throw new NtfSchemaError(`期望 FBA_INVENTORY_AVAILABILITY_CHANGES，收到 ${type || '空'}`)
  const eventTime = new Date(text(root.eventTime))
  if (Number.isNaN(eventTime.getTime())) throw new NtfSchemaError('eventTime 不是合法时间')
  const payload = obj(root.payload)
  if (!payload) throw new NtfSchemaError('payload 必须是对象')
  const container = payload.fbaInventoryAvailabilityChanges ?? payload.fbaInventoryAvailabilityChange
  const list = Array.isArray(container) ? container : container ? [container] : null
  if (!list) throw new NtfSchemaError('payload 里没有 fbaInventoryAvailabilityChanges')
  const rows: FbaInventoryChange[] = []
  for (const item of list) {
    const row = obj(item)
    if (!row) throw new NtfSchemaError('库存变化行必须是对象')
    const accountId = text(row.sellerId ?? row.accountId)
    const sku = text(row.sku ?? row.sellerSku ?? row.msku)
    if (!accountId || !sku) throw new NtfSchemaError('库存变化行缺少 sellerId 或 sku')
    const base = { accountId, sku, fnsku: text(row.fnSku ?? row.fnsku), asin: text(row.asin), sourceUpdatedAt: eventTime }
    const byMarket = Array.isArray(row.fulfillmentInventoryByMarketplace) ? row.fulfillmentInventoryByMarketplace : null
    if (byMarket) {
      for (const entry of byMarket) {
        const market = obj(entry)
        const sellable = market ? quantity(market) : null
        if (market && sellable !== null && text(market.marketplaceId) === US) rows.push({ ...base, marketplaceId: US, sellable })
      }
      continue
    }
    const sellable = quantity(row)
    const marketplaceId = text(row.marketplaceId) || US
    if (sellable !== null && marketplaceId === US) rows.push({ ...base, marketplaceId, sellable }) // 没有数量的行不写（不把“没报”当 0）
  }
  return rows
}

export function createFbaInventoryProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const rows = parseFbaInventoryChanges(await readJson(deps.storage, event.payloadObjectKey))
    const sellerAccountId = await resolveSellerAccountId(
      deps.db,
      event.tenantId,
      event.sellerAccountId,
      rows.map(row => row.accountId),
    )
    if (!sellerAccountId || rows.length === 0) return
    const snapshotDate = localDay(await tenantTimeZone(deps.db, event.tenantId))
    for (const row of rows) {
      const where = { tenantId_sellerAccountId_sku_fnsku_snapshotDate_source: { tenantId: event.tenantId, sellerAccountId, sku: row.sku, fnsku: row.fnsku, snapshotDate, source: 'API' } }
      const existing = await deps.db.inventoryDailySnapshot.findUnique({ where, select: { id: true, sourceUpdatedAt: true, snapshotDate: true } })
      if (existing && existing.sourceUpdatedAt >= row.sourceUpdatedAt) continue // 较旧的推送不覆盖较新的数据
      if (existing)
        await deps.db.inventoryDailySnapshot.update({
          where: { id_snapshotDate: { id: existing.id, snapshotDate: existing.snapshotDate } },
          data: { sellable: row.sellable, sourceUpdatedAt: row.sourceUpdatedAt },
        })
      else {
        await deps.db.inventoryDailySnapshot.create({
          data: {
            tenantId: event.tenantId,
            sellerAccountId,
            sku: row.sku,
            fnsku: row.fnsku,
            asin: row.asin,
            snapshotDate,
            source: 'API',
            sellable: row.sellable,
            sourceUpdatedAt: row.sourceUpdatedAt,
          },
        })
      }
    }
    await recordFreshness(deps.db, {
      tenantId: event.tenantId,
      sellerAccountId,
      sourceKey: 'ntf.fba-inventory',
      ok: true,
      rowCount: rows.length,
      dataThrough: rows.reduce<Date | null>((max, row) => (!max || row.sourceUpdatedAt > max ? row.sourceUpdatedAt : max), null),
    })
  }
}

export function registerFbaInventoryProcessor(registry: { register(type: string, processor: NotificationProcessor): unknown }, deps: HourlyProcessorDeps) {
  registry.register('FBA_INVENTORY_AVAILABILITY_CHANGES', createFbaInventoryProcessor(deps))
}
