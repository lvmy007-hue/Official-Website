import { BA_SQP_ASIN_LIMIT, BA_PERIOD_INVALID, isBrandReportType, periodKindOf } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'

// 品牌分析报告（R-35 至 R-39）的申请参数：reportPeriod（WEEK / MONTH / QUARTER，由起止日推出）与日期（只带日期，不带时间）。
// 搜索查询表现报告另需 asin 参数（空格分隔，一次最多 200 个）。**参数名对照官方文档整理，没有对真实店铺核对**。

export const SQP_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'

export interface BrandReportRequest {
  reportOptions: Record<string, string>
  dataStartTime: string
  dataEndTime: string
}

const dayText = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null)

/** 不是品牌分析报告返回 null；窗口不是对齐的周、月、季时抛不可重试错误（BA_PERIOD_INVALID）。 */
export function brandReportRequest(reportType: string, from: Date | null | undefined, to: Date | null | undefined, asins: readonly string[]): BrandReportRequest | null {
  if (!isBrandReportType(reportType)) return null
  const start = dayText(from)
  const end = dayText(to)
  const kind = periodKindOf(start, end)
  if (!start || !end || !kind) throw new NonRetryableError(BA_PERIOD_INVALID, '品牌分析报告的时间范围必须正好是一个自然周（周日至周六）、自然月或自然季度')
  const reportOptions: Record<string, string> = { reportPeriod: kind }
  if (reportType === SQP_REPORT_TYPE) {
    const list = [...new Set(asins)].slice(0, BA_SQP_ASIN_LIMIT)
    if (list.length === 0) throw new NonRetryableError('SCOPE_UNAVAILABLE', '店铺还没有同步到商品，无法为搜索查询表现报告指定 ASIN')
    reportOptions.asin = list.join(' ')
  }
  return { reportOptions, dataStartTime: start, dataEndTime: end }
}
