import type { PrismaClient } from '@prisma/client'
import type { DeriveRegistry, DeriveTask } from './derive'
import { ADS_SUMMARY_TASK, refreshAdsDailySummary } from './ads-summary-sql'
import { refreshAsinDailySummary, refreshStoreDailySummary } from './summary-sql'

// 日汇总的派生任务（P2a-01、P3-04）：经营日汇总、ASIN 日汇总、广告日汇总。
// 来源登记决定“哪些原始数据变化会触发刷新”：订单变化刷新两张表，财务交易变化只刷新经营日汇总（退款与费用），
// 广告指标变化刷新广告日汇总，并刷新经营日汇总里的广告花费与广告销售额（经营日汇总直接读广告指标，两个任务之间没有先后依赖）。
// 销售与流量（P4-01，来源 sales-traffic）变化刷新经营日汇总与 ASIN 日汇总：官方订购销售额、件数、会话数覆盖订单表的估算。

export const SUMMARY_TASKS: ReadonlyArray<{ name: string; sources: readonly string[] }> = [
  { name: 'store_daily_summary', sources: ['orders', 'finance', 'ads', 'sales-traffic'] },
  { name: 'asin_daily_summary', sources: ['orders', 'sales-traffic'] },
  { name: ADS_SUMMARY_TASK, sources: ['ads'] },
]

/** 只用于“按来源找任务”：不依赖数据库，供同步监听器提交刷新时使用。 */
export const summaryTasksForSource = { forSource: (source: string) => SUMMARY_TASKS.filter(task => task.sources.includes(source)) }

type SummaryDb = Pick<PrismaClient, '$transaction' | 'tenant'>

export function createSummaryTasks(db: SummaryDb): DeriveTask[] {
  const refreshers = { store_daily_summary: refreshStoreDailySummary, asin_daily_summary: refreshAsinDailySummary, [ADS_SUMMARY_TASK]: refreshAdsDailySummary }
  return SUMMARY_TASKS.map(spec => ({
    name: spec.name,
    sources: spec.sources,
    refresh: async context => ({ rows: await refreshers[spec.name as keyof typeof refreshers](db, { tenantId: context.tenantId, dateFrom: context.dateFrom, dateTo: context.dateTo }) }),
  }))
}

export function registerSummaryTasks(registry: DeriveRegistry, db: SummaryDb) {
  for (const task of createSummaryTasks(db)) registry.register(task)
}
