import { REPORT_RANGE_MAX_DAYS, periodKindOf, type ReportPeriod } from '@nova/api-contracts'
import { appError } from '../../platform/http'

// 创建报告任务时的数据周期检查（P5-03）：按目录里登记的周期类型。
//   SNAPSHOT  当前快照，不带日期；
//   RANGE     起止日期，开始不晚于结束，最长 REPORT_RANGE_MAX_DAYS 天，结束不晚于企业时区的今天；
//   BA_PERIOD 品牌分析：必须正好是一个已经结束的自然周（周日至周六）、自然月或自然季度。
// 日期都是 YYYY-MM-DD 文本，用 UTC 日期换算天数，不受服务器时区影响。

const DAY_MS = 86_400_000
const BA_MESSAGE = '品牌分析报告的时间范围必须是完整的自然周（周日至周六）、自然月或自然季度'

const fail = (field: 'from' | 'to', message: string) => appError('REPORT_PERIOD_INVALID', message, { fieldErrors: { [field]: [message] } })
const validDay = (value: string) => {
  const time = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function validateReportPeriod(period: ReportPeriod, from: string | null | undefined, to: string | null | undefined, today: string): { from: string | null; to: string | null } {
  if (period === 'SNAPSHOT') {
    if (from || to) throw fail(from ? 'from' : 'to', '这个报告是当前快照，不需要选择日期')
    return { from: null, to: null }
  }
  if (!from) throw fail('from', '请选择开始日期')
  if (!to) throw fail('to', '请选择结束日期')
  if (!validDay(from)) throw fail('from', '开始日期不是有效日期')
  if (!validDay(to)) throw fail('to', '结束日期不是有效日期')
  if (from > to) throw fail('from', '开始日期不能晚于结束日期')
  if (period === 'BA_PERIOD') {
    if (!periodKindOf(from, to)) throw fail('to', BA_MESSAGE)
    if (to >= today) throw fail('to', '这个周期还没有结束，请选择已经结束的周期')
    return { from, to }
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1
  if (days > REPORT_RANGE_MAX_DAYS) throw fail('to', `时间范围最长 ${REPORT_RANGE_MAX_DAYS} 天（当前 ${days} 天）`)
  if (to > today) throw fail('to', '结束日期不能晚于今天（企业时区）')
  return { from, to }
}

/** 以今天（企业时区的日期文本）往前数：结束是昨天，开始是结束往前 days - 1 天。 */
export function recentWindow(today: string, days: number): { from: string; to: string } {
  const base = Date.parse(`${today}T00:00:00Z`)
  const day = (offset: number) => new Date(base + offset * DAY_MS).toISOString().slice(0, 10)
  return { from: day(-days), to: day(-1) }
}
