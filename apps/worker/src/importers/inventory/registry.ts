import type { ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { syncNoncomplianceReport, syncStorageFeeReport } from '../finance/fee-reports'
import { noncomplianceRowHandler } from '../inbound/noncompliance-rows'
import { syncLedgerDetailReport, syncLedgerSummaryReport } from './ledger-reports'
import { syncPlanningReport, syncRecommendedRemovalReport } from './planning-reports'
import { syncRemovalOrderReport, syncRemovalShipmentReport } from './removal-reports'
import { syncRestockReport } from './restock-report'
import type { InventoryReportScope } from './scope'
import { SNAPSHOT_REPORT_TYPES, syncSnapshotReport } from './snapshot-reports'
import { storageFeeRowHandler, syncLongTermFeeReport, syncOverageFeeReport } from './storage-fee-reports'

// 库存与费用类报告的导入器注册（importers.md 第三节 3.2，R-08 至 R-22）：报告类型 → 逐行导入器。
// 不属于本域的类型返回 null，由分发层继续按其他域匹配。

export type RowsImporter = (ctx: ImportContext, rows: AsyncIterable<Row>) => Promise<ImportResult>

export const INVENTORY_REPORT_TYPES: readonly string[] = [
  ...Object.keys(SNAPSHOT_REPORT_TYPES),
  'GET_FBA_INVENTORY_PLANNING_DATA',
  'GET_FBA_RECOMMENDED_REMOVAL_DATA',
  'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
  'GET_LEDGER_DETAIL_VIEW_DATA',
  'GET_LEDGER_SUMMARY_VIEW_DATA',
  'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA',
  'GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA',
  'GET_FBA_STORAGE_FEE_CHARGES_DATA',
  'GET_FBA_OVERAGE_FEE_CHARGES_DATA',
  'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA',
  'GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA',
]

export function inventoryImporterFor(reportType: string, scope: InventoryReportScope, marketplaceId: string): RowsImporter | null {
  const source = SNAPSHOT_REPORT_TYPES[reportType]
  if (source) return (ctx, rows) => syncSnapshotReport(ctx, rows, scope, source)
  switch (reportType) {
    case 'GET_FBA_INVENTORY_PLANNING_DATA':
      return (ctx, rows) => syncPlanningReport(ctx, rows, scope)
    case 'GET_FBA_RECOMMENDED_REMOVAL_DATA':
      return (ctx, rows) => syncRecommendedRemovalReport(ctx, rows, scope)
    case 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT':
      return (ctx, rows) => syncRestockReport(ctx, rows, scope)
    case 'GET_LEDGER_DETAIL_VIEW_DATA':
      return (ctx, rows) => syncLedgerDetailReport(ctx, rows, scope)
    case 'GET_LEDGER_SUMMARY_VIEW_DATA':
      return (ctx, rows) => syncLedgerSummaryReport(ctx, rows, scope, 'DAILY')
    case 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA':
      return (ctx, rows) => syncRemovalOrderReport(ctx, rows, scope)
    case 'GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA':
      return (ctx, rows) => syncRemovalShipmentReport(ctx, rows, scope)
    case 'GET_FBA_STORAGE_FEE_CHARGES_DATA':
      // 同一遍文件扫描里写两处：财务用的费用事件（既有）与库存域的仓储费明细、利用率（P2a-05）
      return (ctx, rows) => syncStorageFeeReport(ctx, rows, scope.tenantId, scope.sellerAccountId, marketplaceId, storageFeeRowHandler(scope))
    case 'GET_FBA_OVERAGE_FEE_CHARGES_DATA':
      return (ctx, rows) => syncOverageFeeReport(ctx, rows, scope)
    case 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA':
      return (ctx, rows) => syncLongTermFeeReport(ctx, rows, scope)
    case 'GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA':
      // 同一遍文件扫描里写两处：财务用的费用事件（既有）与货件接收页的不合规问题（P2a-13）
      return (ctx, rows) => syncNoncomplianceReport(ctx, rows, scope.tenantId, scope.sellerAccountId, marketplaceId, noncomplianceRowHandler(scope))
    default:
      return null
  }
}
