import { SALES_TAX_CURRENCY, SALES_TAX_GROUP_LIMIT, SALES_TAX_REPORT_TYPE, normalizeJurisdiction, normalizeTaxKind, normalizeTaxState } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { BATCH_TX_TIMEOUT_MS, importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, num, parseDay, requireColumns, text } from '../inventory/columns'

// 销售税报告（importers.md R-33，GET_FLAT_FILE_SALES_TAX_DATA，P2b-12）→ SalesTaxSummary。
// 报告每行是一个订单商品的税额，没有必要也不应该逐行存：按（日期、州、辖区、税种）在内存里汇总，整份读完再一次写库。
// 报告里有订单号、收货城市与邮编等列：这里一概不读取、不写库、不进日志，只读州（汇总的维度）、辖区、税种、日期与两个金额列。
// 写入是“先删后写”：删掉这份报告覆盖的日期范围内同店铺同来源的旧汇总再写新的，同一份报告或更大范围的新报告重复导入都不会翻倍。
// 列名按官方文档整理，没有拿真实报告核对（见 CR-050）；缺少州、税额、日期三组关键列之一，整份报告按“格式变化”失败（PARSE_HEADER）。

export interface SalesTaxReportOptions {
  reportJobId?: string | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

const STATE = ['ship-to-state', 'ship-state', 'tax-state', 'jurisdiction-state', 'state']
const JURISDICTION = ['jurisdiction-name', 'jurisdiction', 'tax-jurisdiction']
const KIND = ['tax-type', 'tax-kind']
const TAXABLE = ['taxable-amount', 'taxable-sales', 'taxable-sales-amount']
const TAX = ['tax-amount', 'tax-collected', 'tax-collected-amount', 'sales-tax-collected', 'total-tax']
// 日期优先取下单日（与订单接口按下单时间汇总的口径一致），没有再取报告日、发货日
const DATE = ['purchase-date', 'order-date', 'reporting-date', 'shipment-date', 'transaction-date', 'date']
const CHUNK = 1000
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

interface Group {
  taxPeriod: Date
  state: string
  jurisdictionKey: string
  taxKind: string
  taxCollected: number
  taxableSales: number | null
  lineCount: number
}

export async function syncSalesTaxReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: SalesTaxReportOptions = {}): Promise<ImportResult> {
  const groups = new Map<string, Group>()
  const result = await importRows(
    ctx,
    rows,
    async (_inner, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [STATE, TAX, DATE], SALES_TAX_REPORT_TYPE)
      const state = normalizeTaxState(text(c, STATE))
      const tax = num(c, TAX)
      const taxPeriod = parseDay(text(c, DATE))
      if (!state || tax === undefined || !taxPeriod) return 'skipped'
      const jurisdictionKey = normalizeJurisdiction(text(c, JURISDICTION))
      const taxKind = normalizeTaxKind(text(c, KIND))
      const key = `${taxPeriod.toISOString().slice(0, 10)}|${state}|${jurisdictionKey}|${taxKind}`
      let group = groups.get(key)
      if (!group) {
        if (groups.size >= SALES_TAX_GROUP_LIMIT) throw new NonRetryableError('TAX_REPORT_TOO_LARGE', `销售税报告的汇总分组超过 ${SALES_TAX_GROUP_LIMIT} 个，拒绝导入`)
        group = { taxPeriod, state, jurisdictionKey, taxKind, taxCollected: 0, taxableSales: null, lineCount: 0 }
        groups.set(key, group)
      }
      group.taxCollected += tax
      const taxable = num(c, TAXABLE)
      if (taxable !== undefined) group.taxableSales = (group.taxableSales ?? 0) + taxable
      group.lineCount += 1
      return 'imported'
    },
    { skippedMessage: 'sales tax rows without state, tax amount or date were skipped', logFields: { tenantId, sellerAccountId } },
  )
  if (groups.size === 0) return result

  const list = [...groups.values()]
  // 分组最多 20 万个：不能把它们展开成 Math.min 的参数（参数个数有上限）
  const first = new Date(list.reduce((min, group) => Math.min(min, group.taxPeriod.getTime()), Infinity))
  const last = new Date(list.reduce((max, group) => Math.max(max, group.taxPeriod.getTime()), -Infinity))
  const now = options.now ?? new Date()
  await ctx.prisma.$transaction(
    async tx => {
      await tx.salesTaxSummary.deleteMany({ where: { tenantId, sellerAccountId, source: 'TAX_LIBRARY', taxPeriod: { gte: first, lte: last } } })
      for (let start = 0; start < list.length; start += CHUNK) {
        await tx.salesTaxSummary.createMany({
          data: list.slice(start, start + CHUNK).map(group => ({
            tenantId,
            sellerAccountId,
            taxPeriod: group.taxPeriod,
            state: group.state,
            jurisdictionKey: group.jurisdictionKey,
            taxKind: group.taxKind,
            source: 'TAX_LIBRARY',
            taxableSales: group.taxableSales === null ? null : round6(group.taxableSales),
            taxCollected: round6(group.taxCollected),
            lineCount: group.lineCount,
            currency: SALES_TAX_CURRENCY,
            sourceReportJobId: options.reportJobId ?? null,
            syncedAt: now,
          })),
        })
      }
    },
    { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 },
  )
  return result
}
