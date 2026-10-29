import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, int, num, parseTime, requireColumns, text } from '../inventory/columns'

// 官方赔付明细报告（importers.md R-27，GET_FBA_REIMBURSEMENTS_DATA）→ ReimbursementRecord（P2b-03，CR-002）。
// 每行是亚马逊已经赔付的一笔（按赔付编号、SKU、FNSKU 拆行）；金额合计可为负（赔付冲回，原赔付编号在 original-reimbursement-id 列）。
// 幂等键：(卖家, 赔付编号, SKU, FNSKU)；同一份报告重复导入只覆盖报告给出的列，不动已经写下的匹配结果（matchedCaseId 等）。
// 报告没有买家信息，也不读取商品名称；case-id 是亚马逊案件编号，用来自动匹配我方案件。

export interface ReimbursementReportOptions {
  reportJobId?: string | null
}

export function syncReimbursementsReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: ReimbursementReportOptions = {}): Promise<ImportResult> {
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['reimbursement-id'], ['approval-date'], ['amount-total', 'amount-per-unit']], 'GET_FBA_REIMBURSEMENTS_DATA')
      const reimbursementId = text(c, ['reimbursement-id'])
      if (!reimbursementId) return 'ignored'
      // 没有批准日期的行不能入账（不用当前时间兜底）；没有金额的行同理
      const approvedAt = parseTime(text(c, ['approval-date']))
      const quantity = int(c, ['quantity-reimbursed-total'])
      const perUnit = num(c, ['amount-per-unit'])
      const amount = num(c, ['amount-total']) ?? (perUnit !== undefined && quantity !== undefined ? Math.round(perUnit * quantity * 100) / 100 : undefined)
      const sku = text(c, ['sku', 'merchant-sku'])
      if (!approvedAt || amount === undefined || !sku) return 'skipped'
      const fnsku = text(c, ['fnsku']) ?? ''
      const data = {
        asin: text(c, ['asin']) ?? null,
        reason: (text(c, ['reason']) ?? '').slice(0, 120),
        quantity: Math.max(0, quantity ?? 0),
        amount,
        currency: (text(c, ['currency-unit', 'currency']) ?? 'USD').toUpperCase().slice(0, 8),
        approvedAt,
        originalOrderId: text(c, ['amazon-order-id']) ?? null,
        amazonCaseId: text(c, ['case-id'])?.slice(0, 40) ?? null,
        sourceReportJobId: options.reportJobId ?? undefined,
      }
      await prisma.reimbursementRecord.upsert({
        where: { sellerAccountId_reimbursementId_sku_fnsku: { sellerAccountId, reimbursementId, sku, fnsku } },
        create: { ...data, tenantId, sellerAccountId, reimbursementId, sku, fnsku },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'reimbursement rows without an approval date, amount or SKU were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
