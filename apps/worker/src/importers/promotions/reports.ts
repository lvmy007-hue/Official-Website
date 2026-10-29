import { COUPON_REPORT_TYPE, PROMOTION_REPORT_TYPE } from '@nova/api-contracts'
import { importRows } from '../../streaming/batch'
import type { RowsImporter } from '../inventory/registry'
import { cells, day, int, num, requireColumns, text } from '../inventory/columns'

// 促销绩效报告（importers.md R-40，GET_PROMOTION_PERFORMANCE_REPORT）与优惠券绩效报告（R-41，GET_COUPON_PERFORMANCE_REPORT）。
// 列名依据亚马逊文档的描述按别名整理，尚未拿到真实报告逐列核对（CR-080 未验证清单）：关键列（映射编号、日期）一个别名都对不上就以 PARSE_HEADER 失败并留存原始文件，
// 不把整份报告当成“没有数据”；其余列没给就存空（不是 0）。幂等键：促销 = 映射编号 × ASIN × 日；优惠券 = 映射编号 × 日，重复导入覆盖。
// 映射编号与促销接口返回的 trackingId 按文本相等关联（官方文档把两者都称为映射编号，这一对应关系同样未用真实数据核对）。

type Scope = { tenantId: string; sellerAccountId: string }
type Options = { reportJobId?: string | null }

const DATE = ['date', 'report-date', 'metric-date', 'day', 'order-date']
const CURRENCY = ['currency', 'currency-code', 'currency-unit']
const SALES = ['sales', 'revenue', 'product-sales', 'ordered-product-sales', 'gross-revenue']
const REDEMPTIONS = ['redemptions', 'number-of-redemptions', 'coupon-redemptions']
const currencyOf = (value: string | undefined) => (value ?? 'USD').toUpperCase().slice(0, 8)

export const PROMOTION_COLUMNS = {
  id: ['promotion-id', 'tracking-id', 'mapping-id', 'promotion-tracking-id'],
  date: DATE,
  asin: ['asin', 'child-asin'],
  units: ['units-sold', 'units', 'units-ordered', 'number-of-units'],
  sales: SALES,
  redemptions: REDEMPTIONS,
} as const
export const COUPON_COLUMNS = {
  id: ['coupon-id', 'promotion-id', 'tracking-id', 'mapping-id'],
  date: DATE,
  clips: ['clips', 'number-of-clips', 'coupon-clips'],
  redemptions: REDEMPTIONS,
  budgetSpent: ['budget-spent', 'budget-used', 'amount-spent', 'spend'],
  sales: SALES,
} as const

export function promotionReportImporter(scope: Scope, options: Options = {}): RowsImporter {
  const { tenantId, sellerAccountId } = scope
  return (ctx, rows) =>
    importRows(
      ctx,
      rows,
      async ({ prisma }, row, index) => {
        const c = cells(row)
        if (index === 0) requireColumns(c, [PROMOTION_COLUMNS.id, PROMOTION_COLUMNS.date], PROMOTION_REPORT_TYPE)
        const mappingId = text(c, PROMOTION_COLUMNS.id)
        const metricDate = day(c, PROMOTION_COLUMNS.date)
        if (!mappingId || !metricDate) return 'skipped' // 没有映射编号或日期的行不能归到某个促销某一天，不用报告日期兜底
        const units = int(c, PROMOTION_COLUMNS.units)
        const sales = num(c, PROMOTION_COLUMNS.sales)
        const redemptions = int(c, PROMOTION_COLUMNS.redemptions)
        if (units === undefined && sales === undefined && redemptions === undefined) return 'skipped'
        const asin = text(c, PROMOTION_COLUMNS.asin)?.toUpperCase() ?? ''
        const data = {
          units: units === undefined ? null : Math.max(0, units),
          sales: sales ?? null,
          redemptions: redemptions === undefined ? null : Math.max(0, redemptions),
          currency: currencyOf(text(c, CURRENCY)),
          sourceReportJobId: options.reportJobId ?? undefined,
          sourceUpdatedAt: new Date(),
          syncedAt: new Date(),
        }
        await prisma.promotionMetric.upsert({
          where: { tenantId_sellerAccountId_mappingId_asin_metricDate: { tenantId, sellerAccountId, mappingId, asin, metricDate } },
          create: { ...data, tenantId, sellerAccountId, mappingId, asin, metricDate },
          update: data,
        })
        return 'imported'
      },
      { skippedMessage: 'promotion performance rows without a mapping id, date or any metric were skipped', logFields: { tenantId, sellerAccountId } },
    )
}

export function couponReportImporter(scope: Scope, options: Options = {}): RowsImporter {
  const { tenantId, sellerAccountId } = scope
  return (ctx, rows) =>
    importRows(
      ctx,
      rows,
      async ({ prisma }, row, index) => {
        const c = cells(row)
        if (index === 0) requireColumns(c, [COUPON_COLUMNS.id, COUPON_COLUMNS.date], COUPON_REPORT_TYPE)
        const mappingId = text(c, COUPON_COLUMNS.id)
        const metricDate = day(c, COUPON_COLUMNS.date)
        if (!mappingId || !metricDate) return 'skipped'
        const clips = int(c, COUPON_COLUMNS.clips)
        const redemptions = int(c, COUPON_COLUMNS.redemptions)
        const budgetSpent = num(c, COUPON_COLUMNS.budgetSpent)
        const sales = num(c, COUPON_COLUMNS.sales)
        if (clips === undefined && redemptions === undefined && budgetSpent === undefined && sales === undefined) return 'skipped'
        const data = {
          clips: clips === undefined ? null : Math.max(0, clips),
          redemptions: redemptions === undefined ? null : Math.max(0, redemptions),
          budgetSpent: budgetSpent ?? null,
          sales: sales ?? null,
          currency: currencyOf(text(c, CURRENCY)),
          sourceReportJobId: options.reportJobId ?? undefined,
          sourceUpdatedAt: new Date(),
          syncedAt: new Date(),
        }
        await prisma.couponMetric.upsert({
          where: { tenantId_sellerAccountId_mappingId_metricDate: { tenantId, sellerAccountId, mappingId, metricDate } },
          create: { ...data, tenantId, sellerAccountId, mappingId, metricDate },
          update: data,
        })
        return 'imported'
      },
      { skippedMessage: 'coupon performance rows without a coupon id, date or any metric were skipped', logFields: { tenantId, sellerAccountId } },
    )
}
