import { classifySettlementLine, parseReportTime } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, int, num, requireColumns, text, type Cells } from '../inventory/columns'

// 结算报告（importers.md R-28，GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2）→ FbaSettlement（汇总）+ SettlementLine（明细，P2b-07）。
// 一份报告 = 一张结算单：带结算周期、打款日、打款总额的行是“汇总行”（有的报告每行都重复这几列），带金额的行是“明细行”。
// 汇总列只写报告里给了的（缺的不覆盖，更不写 0）；明细按（结算单, 行序号）幂等写入，行序号是报告里数据行的位置，同一份报告重复导入不会重复。
// 明细不再写进财务交易表：财务交易表是财务接口的数据，三方核对需要把它和结算报告分开比；这一点与冻结的“source=SETTLEMENT”不同，见 CR-045。
// 不读买家与收件人相关的列（这份报告本来也没有）。

export interface SettlementReportOptions {
  reportJobId?: string | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

/** 报告里的列名按文档整理，没有拿真实报告核对；缺少结算单编号列整份报告按“格式变化”失败。 */
const ORDER = ['order-id', 'amazon-order-id']
const POSTED = ['posted-date-time', 'posted-date', 'transaction-date']

function headerOf(c: Cells) {
  const start = parseReportTime(text(c, ['settlement-start-date']))
  const end = parseReportTime(text(c, ['settlement-end-date']))
  const deposit = parseReportTime(text(c, ['deposit-date']))
  const total = num(c, ['total-amount'])
  return { start, end, deposit, total, isHeader: Boolean(start || end || deposit || total !== undefined) }
}

export function syncSettlementReport(
  ctx: ImportContext,
  rows: AsyncIterable<Row>,
  tenantId: string,
  sellerAccountId: string,
  marketplaceId: string,
  options: SettlementReportOptions = {},
): Promise<ImportResult> {
  const settlements = new Map<string, string>() // 结算单编号 → 系统编号：同一份报告里只在第一次与汇总行时写结算单
  const currencies = new Map<string, string>() // 汇总行给出的币种，明细行没写币种时沿用
  let current: string | null = null
  const now = options.now ?? new Date()
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['settlement-id']], 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2')
      // 明细行的结算单编号列可能是空的（跟随它上面最近的汇总行）
      const externalSettlementId = text(c, ['settlement-id']) ?? current
      if (!externalSettlementId) return 'ignored'
      current = externalSettlementId
      const header = headerOf(c)
      const rowCurrency = text(c, ['currency', 'currency-code'])
      if (rowCurrency && header.isHeader) currencies.set(externalSettlementId, rowCurrency)
      const currency = rowCurrency ?? currencies.get(externalSettlementId)

      let settlementId = settlements.get(externalSettlementId)
      if (!settlementId || header.isHeader) {
        const sortAt = header.deposit ?? header.end
        const data = {
          ...(header.start ? { settlementStartDate: header.start } : {}),
          ...(header.end ? { settlementEndDate: header.end } : {}),
          ...(header.deposit ? { depositDate: header.deposit } : {}),
          ...(header.total !== undefined ? { totalAmount: header.total, disbursementAmount: header.total > 0 && header.deposit ? header.total : null } : {}),
          ...(sortAt ? { sortAt } : {}),
          ...(currency ? { currency } : {}),
          ...(header.isHeader ? { raw: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue } : {}),
          sourceUpdatedAt: now,
          sourceReportJobId: options.reportJobId ?? undefined,
        }
        const settlement = await prisma.fbaSettlement.upsert({
          where: { sellerAccountId_externalSettlementId: { sellerAccountId, externalSettlementId } },
          create: { ...data, tenantId, sellerAccountId, marketplaceId, externalSettlementId },
          update: data,
        })
        settlementId = settlement.id
        settlements.set(externalSettlementId, settlementId)
      }

      const amount = num(c, ['amount'])
      if (amount === undefined) return 'imported'
      const transactionType = text(c, ['transaction-type']) ?? ''
      const amountType = text(c, ['amount-type']) ?? ''
      const amountDescription = text(c, ['amount-description']) ?? ''
      const line = {
        transactionType,
        amountType,
        amountDescription,
        category: classifySettlementLine({ transactionType, amountType, amountDescription }),
        amazonOrderId: text(c, ORDER) ?? null,
        shipmentId: text(c, ['shipment-id']) ?? null,
        sku: text(c, ['sku']) ?? null,
        quantity: int(c, ['quantity-purchased', 'quantity']) ?? null,
        postedAt: parseReportTime(text(c, POSTED)),
        amount,
        currency: currency ?? 'USD',
        sourceReportJobId: options.reportJobId ?? null,
      }
      const lineNo = index + 1
      await prisma.settlementLine.upsert({
        where: { settlementId_lineNo: { settlementId, lineNo } },
        create: { ...line, tenantId, sellerAccountId, settlementId, lineNo },
        update: line,
      })
      return 'imported'
    },
    { skippedMessage: 'settlement rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
