import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, hashOf, int, intColumns, isOtherCountry, parseDay, parseTime, requireColumns, text } from './columns'
import { sourceFields, type InventoryReportScope } from './scope'

// 库存台账（R-12 GET_LEDGER_DETAIL_VIEW_DATA、R-13 GET_LEDGER_SUMMARY_VIEW_DATA）。
// 只负责导入：台账平衡校验（LEDGER_NOT_BALANCED 标记与预警）在 P2a-09 实现，这里原样保留全部数据。

/**
 * 明细：幂等键是行内容哈希。同一天内完全相同的两行（亚马逊允许）用“同内容出现序号”区分，序号随日期切换重置——
 * 报告按日期排序（官方默认）时，同一份数据无论按哪个时间窗重新拉取，哈希都一致，不会重复写入。
 */
export function syncLedgerDetailReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  let currentDay = ''
  let seen = new Map<string, number>()
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['date'], ['fnsku'], ['quantity']], 'GET_LEDGER_DETAIL_VIEW_DATA')
      if (isOtherCountry(c)) return 'ignored'
      const eventDate = parseDay(text(c, ['date']))
      const fnsku = text(c, ['fnsku'])
      const quantity = int(c, ['quantity'])
      if (!fnsku) return 'ignored'
      if (!eventDate || quantity === undefined) return 'skipped'
      const natural = [
        eventDate.toISOString().slice(0, 10),
        text(c, ['date-and-time']),
        fnsku,
        text(c, ['fulfillment-center']),
        text(c, ['disposition']),
        text(c, ['reason']),
        text(c, ['event-type']),
        text(c, ['reference-id']),
        quantity,
      ]
      const dayKey = eventDate.toISOString().slice(0, 10)
      if (dayKey !== currentDay) {
        currentDay = dayKey
        seen = new Map()
      }
      const base = hashOf(...natural)
      const occurrence = seen.get(base) ?? 0
      seen.set(base, occurrence + 1)
      const rowHash = hashOf(base, occurrence)
      const data = {
        eventDate,
        eventTime: parseTime(text(c, ['date-and-time'])),
        fnsku,
        asin: text(c, ['asin']) ?? '',
        sku: text(c, ['msku', 'sku']) ?? '',
        fulfillmentCenter: text(c, ['fulfillment-center']) ?? '',
        disposition: text(c, ['disposition']) ?? '',
        reasonCode: text(c, ['reason']) ?? '',
        eventType: text(c, ['event-type']) ?? '',
        referenceId: text(c, ['reference-id']),
        quantity,
        country: text(c, ['country']),
        reconciledQty: int(c, ['reconciled-quantity']),
        unreconciledQty: int(c, ['unreconciled-quantity']),
        ...sourceFields(scope),
      } as Prisma.InventoryLedgerEntryUncheckedUpdateInput
      await prisma.inventoryLedgerEntry.upsert({
        where: { tenantId_sellerAccountId_rowHash: { tenantId, sellerAccountId, rowHash } },
        create: { ...(data as Prisma.InventoryLedgerEntryUncheckedCreateInput), tenantId, sellerAccountId, rowHash },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'ledger detail rows without a valid date or quantity were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

const SUMMARY_QTY = {
  startingQty: ['starting-warehouse-balance'],
  inTransitQty: ['in-transit-between-warehouses'],
  receipts: ['receipts'],
  customerShipments: ['customer-shipments'],
  customerReturns: ['customer-returns'],
  vendorReturns: ['vendor-returns'],
  transfers: ['warehouse-transfer-in-out', 'warehouse-transfer'],
  found: ['found'],
  lost: ['lost'],
  damaged: ['damaged'],
  disposed: ['disposed'],
  other: ['other-events'],
  endingQty: ['ending-warehouse-balance'],
  unknownEvents: ['unknown-events'],
}

/** 汇总：幂等键 (date, fnsku, location, disposition, aggregation)，aggregation 是创建报告时的汇总粒度。 */
export function syncLedgerSummaryReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope, aggregation: 'DAILY' | 'WEEKLY' | 'MONTHLY' = 'DAILY'): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['date'], ['fnsku'], ['ending-warehouse-balance']], 'GET_LEDGER_SUMMARY_VIEW_DATA')
      const fnsku = text(c, ['fnsku'])
      if (!fnsku) return 'ignored'
      const date = parseDay(text(c, ['date']))
      if (!date) return 'skipped'
      const fulfillmentCenter = text(c, ['location', 'fulfillment-center']) ?? ''
      const disposition = text(c, ['disposition']) ?? ''
      const data = {
        asin: text(c, ['asin']) ?? '',
        sku: text(c, ['msku', 'sku']) ?? '',
        ...intColumns(c, SUMMARY_QTY),
        ...sourceFields(scope),
      } as Prisma.InventoryLedgerSummaryUncheckedUpdateInput
      await prisma.inventoryLedgerSummary.upsert({
        where: { tenantId_sellerAccountId_date_fnsku_fulfillmentCenter_disposition_aggregation: { tenantId, sellerAccountId, date, fnsku, fulfillmentCenter, disposition, aggregation } },
        create: { ...(data as Prisma.InventoryLedgerSummaryUncheckedCreateInput), tenantId, sellerAccountId, date, fnsku, fulfillmentCenter, disposition, aggregation },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'ledger summary rows without a valid date were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
