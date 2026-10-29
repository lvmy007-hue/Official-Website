import { get } from '../../datakiosk/json'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { asinOf, dateOnly, fraction, price, qty, readPeriod, type BrandReportOptions } from './parse'

// 品牌分析·重复购买（importers.md R-39，GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT，JSON）→ BrandRepeatPurchase（P4-04）。
// 报告形状：{ reportSpecification, dataByAsin: [{ startDate, endDate, asin, orders, uniqueCustomers, repeatCustomersPctTotal,
//   repeatPurchaseRevenue: { amount, currencyCode }, repeatPurchaseRevenuePctTotal }] }：每行是“一个 ASIN × 一个周期”的复购表现。
// 官方给的是“复购买家占全部买家的比例”（不是复购订单占比），页面按这个口径写。
// **字段名对照官方样例整理，没有对真实店铺核对**；官方没给的值是 null（不补 0）。

export function readRepeatRow(row: Row, options: BrandReportOptions) {
  const period = readPeriod(row, options)
  const asin = asinOf(row.asin)
  if (!period || !asin) return null
  const revenue = price(get(row, 'repeatPurchaseRevenue'))
  const values = {
    orders: qty(get(row, 'orders')),
    uniqueCustomers: qty(get(row, 'uniqueCustomers')),
    repeatCustomersPct: fraction(get(row, 'repeatCustomersPctTotal')),
    repeatRevenue: revenue?.amount ?? null,
    repeatRevenuePct: fraction(get(row, 'repeatPurchaseRevenuePctTotal')),
    currency: revenue?.currency ?? null,
  }
  return { period, asin, values }
}

export function syncRepeatPurchaseReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: BrandReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const scope = { tenantId, sellerAccountId }
  return importRows(
    ctx,
    rows,
    async (inner, row) => {
      const parsed = readRepeatRow(row, options)
      if (!parsed) return 'skipped'
      const { period, asin, values } = parsed
      const periodStart = dateOnly(period.start)
      const data = { ...values, periodEnd: dateOnly(period.end), sourceReportJobId: options.reportJobId ?? null, sourceUpdatedAt: now, syncedAt: now }
      await inner.prisma.brandRepeatPurchase.upsert({
        where: { tenantId_sellerAccountId_reportPeriod_periodStart_asin: { ...scope, reportPeriod: period.kind, periodStart, asin } },
        create: { ...scope, reportPeriod: period.kind, periodStart, asin, ...data },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'brand repeat purchase rows without a usable period or asin were skipped', logFields: scope },
  )
}
