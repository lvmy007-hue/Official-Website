import { FBA_FEE_ESTIMATE_REPORT_TYPE, REFERRAL_FEE_PREVIEW_REPORT_TYPE, lengthToCm, sortedSides, weightToKg } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import { importRows, type ImportResult, type RowOutcome } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, num, requireColumns, text } from '../inventory/columns'

// 费用核查的基准报告（P2b-06，importers.md R-23、R-24）→ FeeBaseline：每个 SKU 每天一行，两份报告各写自己的列（互不覆盖）。
// R-23 预估配送费报告：亚马逊测量的尺寸与重量（换算成厘米与千克）、尺寸分段、单件预期配送费；写入时带上前一次快照的尺寸分段，用来发现“尺寸分段变化”。
// R-24 佣金预览报告：售价与单件预估佣金。
// 列名按官方文档整理，没有真实报告样例，未对真实店铺实测：缺少关键列时整份报告失败（PARSE_HEADER），不当作“没有数据”。
// 报告里没给的数值保持为空，不当 0；自发货（fulfilled-by 为 Merchant）的行不属于费用核查范围。

export interface FeeBaselineScope {
  tenantId: string
  sellerAccountId: string
  /** 快照日：企业数据口径时区的“今天”（UTC 零点的日期）。 */
  snapshotDate: Date
  reportJobId?: string | null
}

export type RowsImporter = (ctx: ImportContext, rows: AsyncIterable<Row>) => Promise<ImportResult>

export function feeBaselineImporterFor(reportType: string, scope: FeeBaselineScope): RowsImporter | null {
  if (reportType === FBA_FEE_ESTIMATE_REPORT_TYPE) return (ctx, rows) => syncFeeEstimateReport(ctx, rows, scope)
  if (reportType === REFERRAL_FEE_PREVIEW_REPORT_TYPE) return (ctx, rows) => syncReferralPreviewReport(ctx, rows, scope)
  return null
}

const isMerchantFulfilled = (value: string | undefined) => (value ?? '').toLowerCase().includes('merchant')

async function writeBaseline(db: PrismaClient, scope: FeeBaselineScope, sku: string, asin: string | undefined, currency: string, fields: Omit<Prisma.FeeBaselineUncheckedUpdateInput, 'sku' | 'asin'>) {
  const { tenantId, sellerAccountId, snapshotDate } = scope
  const data = { currency, ...(asin ? { asin } : {}), ...fields, sourceReportJobId: scope.reportJobId ?? undefined }
  await db.feeBaseline.upsert({
    where: { sellerAccountId_sku_snapshotDate: { sellerAccountId, sku, snapshotDate } },
    create: { ...(data as Prisma.FeeBaselineUncheckedCreateInput), tenantId, sellerAccountId, sku, snapshotDate },
    update: data,
  })
}

/** R-23：亚马逊测量尺寸与重量、尺寸分段、单件预期配送费。 */
export function syncFeeEstimateReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: FeeBaselineScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId, snapshotDate } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index): Promise<RowOutcome> => {
      const c = cells(row)
      if (index === 0)
        requireColumns(
          c,
          [
            ['sku', 'seller-sku', 'merchant-sku'],
            ['expected-fulfillment-fee-per-unit', 'product-size-tier'],
          ],
          FBA_FEE_ESTIMATE_REPORT_TYPE,
        )
      const sku = text(c, ['sku', 'seller-sku', 'merchant-sku'])
      if (!sku || isMerchantFulfilled(text(c, ['fulfilled-by']))) return 'ignored'
      const unit = text(c, ['unit-of-dimension'])
      const sides = sortedSides(lengthToCm(num(c, ['longest-side']), unit), lengthToCm(num(c, ['median-side']), unit), lengthToCm(num(c, ['shortest-side']), unit))
      const weightKg = weightToKg(num(c, ['item-package-weight']), text(c, ['unit-of-weight']))
      const sizeTier = text(c, ['product-size-tier'])
      const fee = num(c, ['expected-fulfillment-fee-per-unit'])
      if (!sides && weightKg === null && !sizeTier && fee === undefined) return 'ignored'
      // 前一次快照里的尺寸分段：不同就是“尺寸分段变化”（同一天重复导入时查的是更早的快照，结果不变）
      const previous = sizeTier
        ? await prisma.feeBaseline.findFirst({
            where: { tenantId, sellerAccountId, sku, snapshotDate: { lt: snapshotDate }, sizeTier: { not: null } },
            orderBy: { snapshotDate: 'desc' },
            select: { sizeTier: true },
          })
        : null
      await writeBaseline(prisma, scope, sku, text(c, ['asin']), text(c, ['currency']) ?? 'USD', {
        ...(sizeTier ? { sizeTier, prevSizeTier: previous?.sizeTier ?? null } : {}),
        ...(sides ? { lengthCm: sides.longestCm, widthCm: sides.medianCm, heightCm: sides.shortestCm } : {}),
        ...(weightKg !== null ? { weightKg } : {}),
        ...(fee !== undefined ? { expectedFulfillmentFee: fee } : {}),
      })
      return 'imported'
    },
    { skippedMessage: 'estimated fee rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

/** R-24：售价与单件预估佣金。 */
export function syncReferralPreviewReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: FeeBaselineScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index): Promise<RowOutcome> => {
      const c = cells(row)
      if (index === 0) {
        requireColumns(
          c,
          [
            ['sku', 'seller-sku', 'merchant-sku'],
            ['estimated-referral-fee-per-unit', 'estimated-referral-fee-per-item', 'estimated-referral-fee'],
          ],
          REFERRAL_FEE_PREVIEW_REPORT_TYPE,
        )
      }
      const sku = text(c, ['sku', 'seller-sku', 'merchant-sku'])
      if (!sku || isMerchantFulfilled(text(c, ['fulfilled-by']))) return 'ignored'
      const fee = num(c, ['estimated-referral-fee-per-unit', 'estimated-referral-fee-per-item', 'estimated-referral-fee'])
      if (fee === undefined) return 'ignored'
      const price = num(c, ['sales-price', 'your-price', 'price'])
      await writeBaseline(prisma, scope, sku, text(c, ['asin']), text(c, ['currency']) ?? 'USD', {
        expectedReferralFee: fee,
        ...(price !== undefined ? { salesPrice: price } : {}),
      })
      return 'imported'
    },
    { skippedMessage: 'referral fee preview rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
