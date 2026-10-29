import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, day, int, intColumns, numColumns, requireColumns, text, textColumns } from './columns'
import { AGE_COLUMNS, AIS_COLUMNS, FNSKU_NAMES, PLANNING_INT_COLUMNS, PLANNING_NUM_COLUMNS, PLANNING_TEXT_COLUMNS, SKU_NAMES } from './planning-fields'
import { sourceFields, type InventoryReportScope } from './scope'

// 库存规划报告（R-08）→ InventoryPlanningSnapshot（全字段）+ InventoryAgeSnapshot（库龄分段与库龄附加费预估）。
// 推荐移除报告（R-17）→ 同一张规划快照表，只写 removalReport* 三列（标注来源为本报告），不覆盖 R-08 自带的“建议移除量”。
// 报告自带 snapshot-date 列时用它，没有则用同步当天（企业数据口径时区）。幂等键 (sku, fnsku, snapshotDate)。

const KEY = (c: ReturnType<typeof cells>, scope: InventoryReportScope) => ({
  sku: text(c, SKU_NAMES),
  fnsku: text(c, FNSKU_NAMES) ?? '',
  asin: text(c, ['asin']) ?? '',
  snapshotDate: day(c, ['snapshot-date']) ?? scope.snapshotDate,
})

export function syncPlanningReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [SKU_NAMES], 'GET_FBA_INVENTORY_PLANNING_DATA')
      const { sku, fnsku, asin, snapshotDate } = KEY(c, scope)
      if (!sku) return 'ignored'
      const ages = intColumns(c, AGE_COLUMNS)
      const surcharges = numColumns(c, AIS_COLUMNS)
      const shipIn = day(c, ['recommended-ship-in-date'])
      const data = {
        ...intColumns(c, PLANNING_INT_COLUMNS),
        ...numColumns(c, PLANNING_NUM_COLUMNS),
        ...textColumns(c, PLANNING_TEXT_COLUMNS),
        ...ages,
        ...(shipIn ? { recommendedShipInDate: shipIn } : {}),
        ...(asin ? { asin } : {}),
        ...sourceFields(scope),
      } as Prisma.InventoryPlanningSnapshotUncheckedUpdateInput
      await prisma.inventoryPlanningSnapshot.upsert({
        where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate: { tenantId, sellerAccountId, sku, fnsku, snapshotDate } },
        create: { ...(data as Prisma.InventoryPlanningSnapshotUncheckedCreateInput), tenantId, sellerAccountId, sku, fnsku, asin, snapshotDate },
        update: data,
      })
      // 库龄快照：报告没有任何库龄列时不写（空表示“没有给”，不能写成全 0）
      if (Object.keys(ages).length > 0) {
        const surcharge = Object.values(surcharges)
        const age = {
          ...ages,
          ...(surcharge.length > 0 ? { ageSurchargeEstimate: surcharge.reduce((sum, value) => sum + value, 0) } : {}),
          ...sourceFields(scope),
        } as Prisma.InventoryAgeSnapshotUncheckedUpdateInput
        await prisma.inventoryAgeSnapshot.upsert({
          where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate: { tenantId, sellerAccountId, sku, fnsku, snapshotDate } },
          create: { ...(age as Prisma.InventoryAgeSnapshotUncheckedCreateInput), tenantId, sellerAccountId, sku, fnsku, snapshotDate },
          update: age,
        })
      }
      return 'imported'
    },
    { skippedMessage: 'inventory planning rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

export function syncRecommendedRemovalReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [SKU_NAMES], 'GET_FBA_RECOMMENDED_REMOVAL_DATA')
      const { sku, fnsku, asin, snapshotDate } = KEY(c, scope)
      const quantity = int(c, ['recommended-removal-quantity', 'recommended-removal-qty', 'removal-quantity'])
      if (!sku || quantity === undefined) return 'ignored'
      const data = {
        removalReportQty: quantity,
        removalReportReason: text(c, ['recommended-removal-reason', 'removal-reason', 'reason', 'recommended-action']),
        removalReportUpdatedAt: scope.now ?? new Date(),
        ...(asin ? { asin } : {}),
        ...sourceFields(scope),
      } as Prisma.InventoryPlanningSnapshotUncheckedUpdateInput
      await prisma.inventoryPlanningSnapshot.upsert({
        where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate: { tenantId, sellerAccountId, sku, fnsku, snapshotDate } },
        create: { ...(data as Prisma.InventoryPlanningSnapshotUncheckedCreateInput), tenantId, sellerAccountId, sku, fnsku, asin, snapshotDate },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'recommended removal rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
