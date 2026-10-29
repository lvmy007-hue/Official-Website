import { returnDispositionView } from '@nova/api-contracts'
import { loadRetentionPolicy } from '../../platform/tenant-policy'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, int, parseTime, requireColumns, text } from '../inventory/columns'
import { sealComment } from './comment-vault'
import { backfillReturnOrderDates, registerNewReasons } from './order-dates'

// 客户退货报告（importers.md R-26，GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA）→ FbaReturnCase（P2b-02）。
// 幂等键：(卖家, 订单, ASIN, SKU, FNSKU, 退货件编号, 退货时间)；同一份报告重复导入只覆盖报告给出的列。
// 报告里的买家备注（customer-comments）是自由文本，可能含电话与地址：加密后保存（comment-vault.ts，P6-14），明文不落库；这份报告没有买家姓名与地址，也不读取。
// 不写：status（我方处理状态）、reimbursementStatus 与 reimbursementCaseId（赔付中心 P2b-03 维护）、refundAmount（报告没有退款金额，退款来自财务交易）。

export interface ReturnsReportOptions {
  reportJobId?: string | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))

export async function syncReturnsReport(
  ctx: ImportContext,
  rows: AsyncIterable<Row>,
  tenantId: string,
  sellerAccountId: string,
  marketplaceId: string,
  options: ReturnsReportOptions = {},
): Promise<ImportResult> {
  const touchedOrders = new Set<string>()
  const touchedReasons = new Set<string | null>()
  let skippedComments = 0
  // 保留天数：企业可以在设置里缩短（P5-10）；没有加密能力时不读，也不会保存备注
  const retentionDays = ctx.secrets ? (await loadRetentionPolicy(ctx.prisma, tenantId))?.customerInfoDays : undefined
  const result = await importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0)
        requireColumns(
          c,
          [
            ['order-id', 'amazon-order-id'],
            ['return-date', 'return-request-date'],
          ],
          'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
        )
      const amazonOrderId = text(c, ['order-id', 'amazon-order-id'])
      if (!amazonOrderId) return 'ignored'
      // 没有退货时间的行不能入键（不用当前时间兜底，否则每次导入都会产生新记录）
      const returnDate = parseTime(text(c, ['return-date', 'return-request-date']))
      if (!returnDate) return 'skipped'
      const asin = text(c, ['asin', 'product-id']) ?? 'UNKNOWN'
      const sellerSku = text(c, ['sku', 'seller-sku']) ?? 'UNKNOWN'
      const fnsku = text(c, ['fnsku']) ?? ''
      const licensePlateNumber = text(c, ['license-plate-number', 'lpn']) ?? ''
      const detailed = text(c, ['detailed-disposition', 'disposition'])
      const group = returnDispositionView(detailed).group
      const reason = text(c, ['reason', 'return-reason'])
      // 买家备注（P6-14）：加密后才落库（密文、保留期、个人信息类别），明文不进库；报告没给备注的行不动旧值
      const rawComment = text(c, ['customer-comments'])
      const sealed = await sealComment(ctx.secrets, rawComment, { returnDate, retentionDays, now: options.now ?? new Date() })
      if (rawComment && !sealed) skippedComments += 1
      const data = {
        quantity: int(c, ['quantity', 'return-quantity']) ?? 1,
        ...optional('detailedDisposition', detailed),
        ...optional('disposition', group === 'UNKNOWN' ? undefined : group),
        ...optional('reason', reason),
        ...optional('reportStatus', text(c, ['status'])),
        ...optional('fulfillmentCenterId', text(c, ['fulfillment-center-id'])),
        ...(sealed ?? {}),
        sourceUpdatedAt: options.now ?? new Date(),
        sourceReportJobId: options.reportJobId ?? undefined,
      }
      await prisma.fbaReturnCase.upsert({
        where: { sellerAccountId_amazonOrderId_asin_sellerSku_fnsku_licensePlateNumber_returnDate: { sellerAccountId, amazonOrderId, asin, sellerSku, fnsku, licensePlateNumber, returnDate } },
        create: { ...data, tenantId, sellerAccountId, marketplaceId, amazonOrderId, asin, sellerSku, fnsku, licensePlateNumber, returnDate },
        update: data,
      })
      touchedOrders.add(amazonOrderId)
      touchedReasons.add(reason ?? null)
      return 'imported'
    },
    { skippedMessage: 'customer return rows without a return date were skipped', logFields: { tenantId, sellerAccountId } },
  )
  if (skippedComments > 0) ctx.logger.warn({ tenantId, sellerAccountId, skippedComments }, 'customer return comments were not stored (past retention, or no encryption available)')
  await enrich(ctx, tenantId, sellerAccountId, touchedOrders, touchedReasons, retentionDays)
  return result
}

/** 回填下单与发货时间、登记新原因代码（P6-13）；失败只记日志，退货明细已经写入，下次导入会再做一遍。 */
async function enrich(ctx: ImportContext, tenantId: string, sellerAccountId: string, orders: ReadonlySet<string>, reasons: ReadonlySet<string | null>, retentionDays?: number) {
  try {
    const dates = await backfillReturnOrderDates(ctx.prisma, tenantId, sellerAccountId, orders, retentionDays)
    const added = await registerNewReasons(ctx.prisma, tenantId, reasons, ctx.logger)
    ctx.logger.info({ tenantId, sellerAccountId, ...dates, newReasons: added.length }, 'customer return rows enriched with order dates')
  } catch (error) {
    ctx.logger.warn({ tenantId, sellerAccountId, err: error instanceof Error ? error.message : String(error) }, 'customer return enrichment failed; it will be retried on the next import')
  }
}
