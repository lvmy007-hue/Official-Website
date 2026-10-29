import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, day, int, isOtherCountry, num, requireColumns, text } from './columns'
import { sourceFields, type InventoryReportScope } from './scope'

// 亚马逊官方补货建议（R-16 GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT）→ AmazonRestockRecommendation。
// 报告没有日期列，快照日期取同步当天；幂等键 (sku, fnsku, snapshotDate)。供 P2a-07 与我方补货计算做双源核对。

const SKU = ['merchant-sku', 'sku', 'seller-sku', 'msku']

export function syncRestockReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId, snapshotDate } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [SKU, ['fnsku']], 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT')
      const sku = text(c, SKU)
      if (!sku || isOtherCountry(c)) return 'ignored'
      const fnsku = text(c, ['fnsku']) ?? ''
      const asin = text(c, ['asin']) ?? ''
      const data = {
        recommendedQty: int(c, ['recommended-replenishment-qty', 'recommended-replenishment-quantity']),
        recommendedShipDate: day(c, ['recommended-ship-date']),
        alertReason: text(c, ['alert']),
        recommendedAction: text(c, ['recommended-action']),
        daysOfSupply: int(c, ['total-days-of-supply-including-units-from-open-shipments', 'total-days-of-supply']),
        daysOfSupplyAtFba: int(c, ['days-of-supply-at-amazon-fulfillment-network']),
        availableQty: int(c, ['available']),
        inboundQty: int(c, ['inbound']),
        unitsSold30d: int(c, ['units-sold-last-30-days']),
        salesLast30d: num(c, ['sales-last-30-days']),
        currency: text(c, ['currency-code', 'currency']),
        ...(asin ? { asin } : {}),
        ...sourceFields(scope),
      } as Prisma.AmazonRestockRecommendationUncheckedUpdateInput
      await prisma.amazonRestockRecommendation.upsert({
        where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate: { tenantId, sellerAccountId, sku, fnsku, snapshotDate } },
        create: { ...(data as Prisma.AmazonRestockRecommendationUncheckedCreateInput), tenantId, sellerAccountId, sku, fnsku, asin, snapshotDate },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'restock recommendation rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
