import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import type { ImportContext, JsonObject } from '../../types'
import { countOf } from '../shared'

// 亚马逊物流库存接口（FBA Inventory API v1，importers.md I-05）：逐页写入 FbaInventoryRecord（当前值）与 InventoryDailySnapshot（来源 API 的当日快照）。
// 不再判断“健康/低库存”：库存健康由规则引擎按版本计算（P2a-06），同步器只搬运亚马逊给出的数量。

/** 企业数据口径日期（UTC 零点的日期）：调用方按企业时区算好传入；缺省取 UTC 今天。 */
const utcToday = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export async function syncInventory(ctx: ImportContext, client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string, snapshotDate: Date = utcToday()) {
  const { prisma } = ctx
  let nextToken: string | undefined
  let imported = 0
  do {
    const response = await client.getInventory(marketplaceId, nextToken)
    const payload = (response.payload ?? response) as JsonObject
    const summaries = Array.isArray(payload.inventorySummaries) ? (payload.inventorySummaries as JsonObject[]) : []
    for (const item of summaries) {
      const sellerSku = String(item.sellerSku ?? '').trim()
      const asin = String(item.asin ?? '').trim()
      if (!sellerSku || !asin) continue
      const details = (item.inventoryDetails ?? {}) as JsonObject
      const reservedDetails = (details.reservedQuantity ?? {}) as JsonObject
      const unfulfillableDetails = (details.unfulfillableQuantity ?? {}) as JsonObject
      const fulfillable = Number(details.fulfillableQuantity ?? 0)
      const reserved = Number(reservedDetails.totalReservedQuantity ?? item.totalReservedQuantity ?? 0)
      const inboundWorking = countOf(details.inboundWorkingQuantity)
      const inboundShipped = countOf(details.inboundShippedQuantity)
      const inboundReceiving = countOf(details.inboundReceivingQuantity)
      const unfulfillable = Number(unfulfillableDetails.totalUnfulfillableQuantity ?? 0)
      const researching = Number(((details.researchingQuantity ?? {}) as JsonObject).totalResearchingQuantity ?? 0)
      const fnsku = typeof item.fnsku === 'string' ? item.fnsku : undefined
      const now = new Date()
      const current = {
        asin,
        fnsku,
        fulfillableQuantity: fulfillable,
        reservedQuantity: reserved,
        inboundWorkingQuantity: inboundWorking,
        inboundShippedQuantity: inboundShipped,
        inboundReceivingQuantity: inboundReceiving,
        unfulfillableQuantity: unfulfillable,
        researchQuantity: researching,
        source: 'API',
        sourceUpdatedAt: now,
      }
      await prisma.fbaInventoryRecord.upsert({
        where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId, marketplaceId, sellerSku } },
        create: { tenantId, sellerAccountId, marketplaceId, sellerSku, ...current },
        update: current,
      })
      const snapshot = {
        asin,
        sellable: fulfillable,
        inbound: inboundWorking + inboundShipped + inboundReceiving,
        reserved,
        unsellable: unfulfillable,
        researching,
        reservedCustomerOrder: countOf(reservedDetails.pendingCustomerOrderQuantity),
        reservedTransfer: countOf(reservedDetails.pendingTransshipmentQuantity),
        reservedProcessing: countOf(reservedDetails.fcProcessingQuantity),
        sourceUpdatedAt: now,
      }
      await prisma.inventoryDailySnapshot.upsert({
        where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate_source: { tenantId, sellerAccountId, sku: sellerSku, fnsku: fnsku ?? '', snapshotDate, source: 'API' } },
        create: { tenantId, sellerAccountId, sku: sellerSku, fnsku: fnsku ?? '', snapshotDate, source: 'API', ...snapshot },
        update: snapshot,
      })
    }
    imported += summaries.length
    const pagination = (payload.pagination ?? {}) as JsonObject
    const token = payload.nextToken ?? pagination.nextToken ?? response.nextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  return imported
}
