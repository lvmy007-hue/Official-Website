import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, int, intColumns, requireColumns, text, type Cells } from './columns'
import { sourceFields, type InventoryReportScope } from './scope'

// 库存快照类报告（importers.md R-09、R-10、R-11、R-14、R-15）：各写 InventoryDailySnapshot 的一个来源分行。
// 不同来源报告不同的列，没有给的列保持为空（不是 0）；同一天同一来源重复导入按 (sku, fnsku, snapshotDate, source) 覆盖本来源给出的列。

export type SnapshotSource = 'MYI_ALL' | 'MYI_UNSUPPRESSED' | 'AFN' | 'RESERVED' | 'STRANDED'

export const SNAPSHOT_REPORT_TYPES: Readonly<Record<string, SnapshotSource>> = {
  GET_FBA_MYI_ALL_INVENTORY_DATA: 'MYI_ALL',
  GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: 'MYI_UNSUPPRESSED',
  GET_AFN_INVENTORY_DATA: 'AFN',
  GET_RESERVED_INVENTORY_DATA: 'RESERVED',
  GET_STRANDED_INVENTORY_UI_DATA: 'STRANDED',
}

const SKU = ['sku', 'seller-sku', 'merchant-sku', 'msku']
const FNSKU = ['fnsku', 'fulfillment-channel-sku']
const ASIN = ['asin']

const MYI_QTY = {
  sellable: ['afn-fulfillable-quantity'],
  unsellable: ['afn-unsellable-quantity'],
  reserved: ['afn-reserved-quantity'],
  researching: ['afn-researching-quantity'],
}
const MYI_INBOUND = [['afn-inbound-working-quantity'], ['afn-inbound-shipped-quantity'], ['afn-inbound-receiving-quantity']]
const RESERVED_QTY = {
  reserved: ['reserved-qty', 'reserved-quantity'],
  reservedCustomerOrder: ['reserved-customerorders', 'reserved-customer-orders', 'reserved-customer-order'],
  reservedTransfer: ['reserved-fc-transfers', 'reserved-fc-transfer'],
  reservedProcessing: ['reserved-fc-processing'],
}

type Values = Record<string, number | string | undefined>

/** 按来源取出本报告给出的列；返回 null 表示这一行与本系统无关（例如没有亚马逊物流库存的自发货商品）。 */
function valuesOf(source: SnapshotSource, c: Cells): Values | null {
  if (source === 'MYI_ALL' || source === 'MYI_UNSUPPRESSED') {
    const quantities = intColumns(c, MYI_QTY)
    const inbound = MYI_INBOUND.map(names => int(c, names)).filter((value): value is number => value !== undefined)
    const listed = (text(c, ['afn-listing-exists']) ?? '').toLowerCase() === 'yes'
    const total = int(c, ['afn-total-quantity'])
    // 只有自发货库存的商品没有亚马逊物流库存：不写入，避免出现一排“可售 0”
    if (!listed && !total && Object.values(quantities).every(value => !value) && inbound.every(value => !value)) return null
    return { ...quantities, ...(inbound.length > 0 ? { inbound: inbound.reduce((sum, value) => sum + value, 0) } : {}) }
  }
  if (source === 'AFN') {
    const quantity = int(c, ['quantity-available', 'quantity'])
    if (quantity === undefined) return {}
    const unsellable = (text(c, ['warehouse-condition-code', 'detailed-disposition']) ?? '').toUpperCase().includes('UNSELLABLE')
    return unsellable ? { unsellable: quantity } : { sellable: quantity }
  }
  if (source === 'RESERVED') return intColumns(c, RESERVED_QTY)
  const stranded = int(c, ['stranded-quantity', 'stranded-qty', 'quantity', 'total-quantity'])
  return { ...(stranded !== undefined ? { stranded } : {}), strandedReason: text(c, ['stranded-reason', 'reason', 'status-primary']) }
}

const REQUIRED: Record<SnapshotSource, string[][]> = {
  MYI_ALL: [SKU],
  MYI_UNSUPPRESSED: [SKU],
  AFN: [SKU],
  RESERVED: [SKU],
  STRANDED: [SKU],
}

export function syncSnapshotReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope, source: SnapshotSource): Promise<ImportResult> {
  const { tenantId, sellerAccountId, snapshotDate } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, REQUIRED[source], source)
      const sku = text(c, SKU)
      if (!sku) return 'ignored'
      const values = valuesOf(source, c)
      if (values === null || Object.values(values).every(value => value === undefined)) return 'ignored' // 本行没有给出本来源的任何数量
      const fnsku = text(c, FNSKU) ?? ''
      const asin = text(c, ASIN) ?? ''
      const data = { ...values, ...(asin ? { asin } : {}), ...sourceFields(scope) } as Prisma.InventoryDailySnapshotUncheckedUpdateInput
      await prisma.inventoryDailySnapshot.upsert({
        where: { tenantId_sellerAccountId_sku_fnsku_snapshotDate_source: { tenantId, sellerAccountId, sku, fnsku, snapshotDate, source } },
        create: { ...(data as Prisma.InventoryDailySnapshotUncheckedCreateInput), tenantId, sellerAccountId, sku, fnsku, snapshotDate, source, asin },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'inventory snapshot rows were skipped', logFields: { tenantId, sellerAccountId, source } },
  )
}
