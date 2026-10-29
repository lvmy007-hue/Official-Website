import type { Prisma, PrismaClient } from '@prisma/client'
import { importRows, type ImportResult, type RowOutcome } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, day, monthStartOf, num, requireColumns, text, type Cells } from './columns'
import { sourceFields, type InventoryReportScope } from './scope'

// 仓储类费用报告（R-20 月度仓储费与利用率、R-21 超限费、R-22 长期仓储费）→ StorageFeeRecord、StorageCapacitySnapshot。
// 金额按报告原样保存（正数为费用）；费用类型 STORAGE / OVERAGE / LONGTERM / UTILIZATION。幂等键 (chargeMonth, fnsku, fulfillmentCenter, feeKind)。
// 旧的费用事件写入（FbaFeeEvent，财务汇总在用）由 importers/finance/fee-reports.ts 继续负责，两处在同一个导入器里各写各的。

type FeeKind = 'STORAGE' | 'OVERAGE' | 'LONGTERM' | 'UTILIZATION'
type Db = Pick<PrismaClient, 'storageFeeRecord' | 'storageCapacitySnapshot'>

async function writeFee(
  db: Db,
  scope: InventoryReportScope,
  fee: { chargeMonth: Date; feeKind: FeeKind; fnsku: string; fulfillmentCenter: string; asin: string; sku: string; amount: number; currency: string; volume?: number; rate?: number },
) {
  const { tenantId, sellerAccountId } = scope
  const { chargeMonth, feeKind, fnsku, fulfillmentCenter, ...rest } = fee
  const data = { ...rest, ...sourceFields(scope) } as Prisma.StorageFeeRecordUncheckedUpdateInput
  await db.storageFeeRecord.upsert({
    where: { tenantId_sellerAccountId_chargeMonth_fnsku_fulfillmentCenter_feeKind: { tenantId, sellerAccountId, chargeMonth, fnsku, fulfillmentCenter, feeKind } },
    create: { ...(data as Prisma.StorageFeeRecordUncheckedCreateInput), tenantId, sellerAccountId, chargeMonth, fnsku, fulfillmentCenter, feeKind },
    update: data,
  })
}

const identity = (c: Cells) => ({
  fnsku: text(c, ['fnsku', 'fulfillment-channel-sku']),
  fulfillmentCenter: text(c, ['fulfillment-center']) ?? '',
  asin: text(c, ['asin']) ?? '',
  sku: text(c, ['sku', 'seller-sku', 'msku']) ?? '',
  currency: text(c, ['currency', 'currency-code']) ?? 'USD',
})

/** R-20 的逐行处理：月度仓储费（基础费）、利用率附加费与仓储利用率。供费用事件导入器在同一遍文件扫描里复用。 */
export function storageFeeRowHandler(scope: InventoryReportScope) {
  const { tenantId, sellerAccountId } = scope
  return async ({ prisma }: ImportContext, row: Row, index: number): Promise<RowOutcome> => {
    const c = cells(row)
    if (index === 0) requireColumns(c, [['month-of-charge'], ['fnsku', 'asin']], 'GET_FBA_STORAGE_FEE_CHARGES_DATA')
    const who = identity(c)
    const month = day(c, ['month-of-charge'])
    if (!who.fnsku) return 'ignored'
    if (!month) return 'skipped'
    const chargeMonth = monthStartOf(month)
    const volume = num(c, ['estimated-total-item-volume', 'item-volume'])
    const base = num(c, ['base-monthly-storage-fee', 'estimated-monthly-storage-fee'])
    if (base !== undefined) await writeFee(prisma, scope, { ...who, fnsku: who.fnsku, chargeMonth, feeKind: 'STORAGE', amount: base, volume, rate: num(c, ['monthly-storage-rate', 'storage-rate']) })
    const surcharge = num(c, ['utilization-surcharge-fee'])
    if (surcharge !== undefined && surcharge !== 0)
      await writeFee(prisma, scope, { ...who, fnsku: who.fnsku, chargeMonth, feeKind: 'UTILIZATION', amount: surcharge, volume, rate: num(c, ['utilization-surcharge-rate']) })
    // 利用率：报告按尺寸分段给出账户的利用率；分段含“oversize”的归入超大件，其余归入标准尺寸
    const ratio = num(c, ['storage-utilization-ratio'])
    if (ratio !== undefined) {
      const storageType = (text(c, ['product-size-tier']) ?? '').toLowerCase().includes('oversize') ? 'OVERSIZE' : 'STANDARD'
      const data = { utilizationPct: ratio, ...sourceFields(scope) } as Prisma.StorageCapacitySnapshotUncheckedUpdateInput
      await prisma.storageCapacitySnapshot.upsert({
        where: { tenantId_sellerAccountId_snapshotDate_storageType: { tenantId, sellerAccountId, snapshotDate: chargeMonth, storageType } },
        create: { ...(data as Prisma.StorageCapacitySnapshotUncheckedCreateInput), tenantId, sellerAccountId, snapshotDate: chargeMonth, storageType, sourceKind: 'REPORT' },
        update: data,
      })
    }
    return base !== undefined || surcharge !== undefined || ratio !== undefined ? 'imported' : 'ignored'
  }
}

export function syncStorageFeeRecords(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  return importRows(ctx, rows, storageFeeRowHandler(scope), {
    skippedMessage: 'storage fee rows without a valid month were skipped',
    logFields: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId },
  })
}

/** R-21：超限费。 */
export function syncOverageFeeReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['fnsku', 'asin', 'sku']], 'GET_FBA_OVERAGE_FEE_CHARGES_DATA')
      const who = identity(c)
      const amount = num(c, ['estimated-overage-fee', 'overage-fee', 'total-overage-fee', 'fee-amount', 'amount'])
      if (!who.fnsku || amount === undefined) return 'ignored'
      const month = day(c, ['month-of-charge', 'charge-month', 'month', 'snapshot-date']) ?? scope.snapshotDate
      await writeFee(prisma, scope, { ...who, fnsku: who.fnsku, chargeMonth: monthStartOf(month), feeKind: 'OVERAGE', amount, volume: num(c, ['overage-volume', 'item-volume']) })
      return 'imported'
    },
    { skippedMessage: 'overage fee rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

/** R-22：长期仓储费（6 个月与 12 个月档合计）。 */
export function syncLongTermFeeReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['fnsku', 'sku']], 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA')
      const who = identity(c)
      if (!who.fnsku) return 'ignored'
      const twelve = num(c, ['12-mo-long-terms-storage-fee', '12-mo-long-term-storage-fee'])
      const six = num(c, ['6-mo-long-terms-storage-fee', '6-mo-long-term-storage-fee'])
      if (twelve === undefined && six === undefined) return 'ignored'
      const month = day(c, ['snapshot-date']) ?? scope.snapshotDate
      await writeFee(prisma, scope, { ...who, fnsku: who.fnsku, chargeMonth: monthStartOf(month), feeKind: 'LONGTERM', amount: (twelve ?? 0) + (six ?? 0), volume: num(c, ['per-unit-volume']) })
      return 'imported'
    },
    { skippedMessage: 'long-term storage fee rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
