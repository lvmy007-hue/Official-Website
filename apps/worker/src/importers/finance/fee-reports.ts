import { importRows, type ImportResult, type RowOutcome } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { decimal, validDate, valueFrom } from '../shared'

/** 同一遍文件扫描里附带的逐行处理（P2a-05：仓储费明细与利用率），结果与费用事件的结果合并。 */
export type ExtraRowHandler = (ctx: ImportContext, row: Row, index: number) => Promise<RowOutcome>
const merged = (a: RowOutcome, b: RowOutcome): RowOutcome => (a === 'imported' || b === 'imported' ? 'imported' : a === 'skipped' || b === 'skipped' ? 'skipped' : 'ignored')

/** 仓储费报告：按月份落为月初的费用事件；extra 在同一遍扫描里写库存域的仓储费明细。 */
export function syncStorageFeeReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, marketplaceId: string, extra?: ExtraRowHandler): Promise<ImportResult> {
  const event = async ({ prisma }: ImportContext, row: Row): Promise<RowOutcome> => {
    const asin = String(valueFrom(row, ['asin']) ?? '').trim()
    const month = String(valueFrom(row, ['month-of-charge', 'month_of_charge']) ?? '').trim()
    if (!asin || !month) return 'ignored'
    const amount = decimal(valueFrom(row, ['estimated-monthly-storage-fee', 'estimated_monthly_storage_fee'])) ?? 0
    const currency = String(valueFrom(row, ['currency']) ?? 'USD')
    const sellerSku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '') || undefined
    const sourceEventId = ['storage', asin, month, sellerSku ?? ''].join(':').slice(0, 180)
    const postedAt = validDate(month.length === 7 ? `${month}-01` : month)
    if (!postedAt) return 'skipped'
    const description = `FBA storage ${month}`
    const category = 'STORAGE' // P2b-05：月度仓储费报告固定归入“仓储费”类
    const subtype = 'STORAGE_FEE'
    await prisma.fbaFeeEvent.upsert({
      where: { sellerAccountId_sourceEventId_postedAt: { sellerAccountId, sourceEventId, postedAt } },
      create: {
        tenantId,
        sellerAccountId,
        marketplaceId,
        asin,
        sellerSku,
        eventType: 'STORAGE_FEE',
        amount,
        currency,
        postedAt,
        description,
        sourceEventId,
        feeCategory: category,
        feeSubtype: subtype,
        sourceUpdatedAt: new Date(),
      },
      update: { amount, currency, feeCategory: category, feeSubtype: subtype, sourceUpdatedAt: new Date() },
    })
    return 'imported'
  }
  return importRows(ctx, rows, async (inner, row, index) => merged(await event(inner, row), extra ? await extra(inner, row, index) : 'ignored'), {
    skippedMessage: 'storage fee rows without a valid month were skipped',
    logFields: { tenantId, sellerAccountId },
  })
}
/** 入仓不合规报告：缺少发生日期的行被跳过并汇总告警；extra 在同一遍扫描里写货件接收页的不合规问题（P2a-13）。 */
export function syncNoncomplianceReport(
  ctx: ImportContext,
  rows: AsyncIterable<Row>,
  tenantId: string,
  sellerAccountId: string,
  marketplaceId: string,
  extra?: ExtraRowHandler,
): Promise<ImportResult> {
  const event = async ({ prisma }: ImportContext, row: Row): Promise<RowOutcome> => {
    const shipmentId = String(valueFrom(row, ['fba-shipment-id', 'shipment-id']) ?? '').trim()
    const sku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '').trim()
    const problem = String(valueFrom(row, ['problem-type', 'problem_type']) ?? '').trim()
    if (!shipmentId && !sku) return 'ignored'
    const amount = decimal(valueFrom(row, ['fee-total', 'fee_total'])) ?? 0
    const currency = String(valueFrom(row, ['currency']) ?? 'USD')
    const postedAt = validDate(valueFrom(row, ['issue-reported-date', 'shipment-creation-date']))
    if (!postedAt) return 'skipped'
    const sourceEventId = ['noncompliance', shipmentId, sku, problem, postedAt.toISOString().slice(0, 10)].join(':').slice(0, 180)
    // P2b-05：不合规费固定归入“入仓配置费”类（不按问题文字的关键字猜），子类型取报告里的问题类型
    const category = 'INBOUND_PLACEMENT'
    const subtype = problem ? problem.slice(0, 120) : 'INBOUND_NONCOMPLIANCE'
    await prisma.fbaFeeEvent.upsert({
      where: { sellerAccountId_sourceEventId_postedAt: { sellerAccountId, sourceEventId, postedAt } },
      create: {
        tenantId,
        sellerAccountId,
        marketplaceId,
        asin: String(valueFrom(row, ['asin']) ?? '') || undefined,
        sellerSku: sku || undefined,
        eventType: 'INBOUND_NONCOMPLIANCE',
        amount,
        currency,
        postedAt,
        description: problem || 'Inbound noncompliance',
        sourceEventId,
        feeCategory: category,
        feeSubtype: subtype,
        sourceUpdatedAt: new Date(),
      },
      update: { amount, currency, description: problem || 'Inbound noncompliance', feeCategory: category, feeSubtype: subtype, sourceUpdatedAt: new Date() },
    })
    return 'imported'
  }
  return importRows(ctx, rows, async (inner, row, index) => merged(await event(inner, row), extra ? await extra(inner, row, index) : 'ignored'), {
    skippedMessage: 'noncompliance rows without a valid date were skipped',
    logFields: { tenantId, sellerAccountId },
  })
}
