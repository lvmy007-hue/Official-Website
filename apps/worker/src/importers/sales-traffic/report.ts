import { type SalesTrafficAsinGranularity } from '@nova/api-contracts'
import { upsertAsinRow, upsertDailyRow } from '../../datakiosk/sales-traffic-write'
import { readReportAsinRow, readReportDateRow } from '../../datakiosk/sales-traffic-parse'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { recordSourceDiffs } from './diff'

// 销售与流量报告（importers.md R-34，GET_SALES_AND_TRAFFIC_REPORT，JSON）→ SalesTrafficDaily / SalesTrafficAsinDaily（source = REPORT，P4-01）。
// 这是数据中心（D-01、D-02）的补充来源：写入的行与数据中心的行并存（唯一键含来源），页面与汇总优先读数据中心；导入后对同键数据做差异核对，
// 超过阈值只记录（SalesTrafficDiff），不覆盖任何一边。
// 报告整份是一个 JSON 对象：{ reportSpecification, salesAndTrafficByDate: [{ date, salesByDate, trafficByDate }],
//   salesAndTrafficByAsin: [{ parentAsin, childAsin, sku, salesByAsin, trafficByAsin }] }；流式读取器按“一条记录”整份读入，超过 500 万字符会以明确的错误失败。
// ASIN 部分没有日期列：只有报告窗口恰好是一天时才导入（日期取申请窗口的那一天），否则跳过并计入 skipped，不猜日期。
// **字段名对照官方样例，没有对真实店铺核对**；缺失字段一律是“官方没给”（null）。

export interface SalesTrafficReportOptions {
  reportJobId?: string | null
  /** 报告申请的窗口；ASIN 部分只在两端是同一个 UTC 日时导入。 */
  from?: Date | null
  to?: Date | null
  /** 申请时的 ASIN 汇总粒度（createReport 固定为 CHILD）。 */
  asinGranularity?: SalesTrafficAsinGranularity
  /** 测试用：固定“现在”。 */
  now?: Date
}

type Tagged = Row & { kind: 'date' | 'asin' }

const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const dayText = (date: Date) => date.toISOString().slice(0, 10)

/** 窗口恰好是一个 UTC 日时返回日期文本，否则 null。 */
export function singleReportDay(from?: Date | null, to?: Date | null): string | null {
  if (!from || !to) return null
  return dayText(from) === dayText(to) ? dayText(from) : null
}

async function* flatten(rows: AsyncIterable<Row>): AsyncGenerator<Tagged> {
  for await (const doc of rows) {
    for (const item of Array.isArray(doc.salesAndTrafficByDate) ? doc.salesAndTrafficByDate : []) if (isRow(item)) yield { ...item, kind: 'date' }
    for (const item of Array.isArray(doc.salesAndTrafficByAsin) ? doc.salesAndTrafficByAsin : []) if (isRow(item)) yield { ...item, kind: 'asin' }
  }
}

export async function syncSalesTrafficReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: SalesTrafficReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const meta = { source: 'REPORT' as const, now, reportJobId: options.reportJobId ?? null }
  const scope = { tenantId, sellerAccountId }
  const day = singleReportDay(options.from, options.to)
  const granularity = options.asinGranularity ?? 'CHILD'
  const dates = new Map<string, Date>()
  const result = await importRows(
    ctx,
    flatten(rows),
    async (inner, row) => {
      if (row.kind === 'date') {
        const parsed = readReportDateRow(row)
        if (!parsed) return 'skipped'
        await upsertDailyRow(inner.prisma, scope, 'DAY', parsed, meta)
        dates.set(parsed.date, new Date(`${parsed.date}T00:00:00Z`))
        return 'imported'
      }
      const parsed = day ? readReportAsinRow(row, granularity, day) : null
      if (!parsed) return 'skipped'
      await upsertAsinRow(inner.prisma, scope, granularity, parsed, meta)
      dates.set(parsed.date, new Date(`${parsed.date}T00:00:00Z`))
      return 'imported'
    },
    { skippedMessage: 'sales and traffic report rows without a usable date, identity or window were skipped', logFields: scope },
  )
  // 核对在导入之后做，范围是这份报告写到的日期；失败不影响导入结果（差异记录下一次报告导入时重算）
  await recordSourceDiffs(ctx.prisma, scope, [...dates.values()], ctx.logger, now).catch(error =>
    ctx.logger.error({ ...scope, error: error instanceof Error ? error.message : String(error) }, 'sales traffic diff check failed'),
  )
  return result
}
