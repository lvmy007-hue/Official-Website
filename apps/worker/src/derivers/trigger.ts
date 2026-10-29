import { PROFIT_DERIVE_TASK, SALES_TRAFFIC_DATASETS } from '@nova/api-contracts'
import { DERIVE_QUEUE_NAME, enqueueDerivedFor, type DeriveQueue, type DerivePayload } from './derive'
import { SUMMARY_TASKS } from './summary-tasks'

// 同步成功后提交日汇总、广告日汇总与利润日表刷新（P2a-01、P2b-09、P3-04）。
// 刷新范围：同步任务有时间窗（历史回补分段）就用时间窗；没有（增量、定时）就取最近 16 天——订单状态会变、财务交易会从递延变为已释放，
// 近期的数据需要被重新计算。两端各放宽一天，覆盖企业时区与 UTC 的日期差。

const DAY_MS = 86_400_000
export const RECENT_DAYS = 16
const day = (time: number) => new Date(time).toISOString().slice(0, 10)

/** 同步触发的派生任务：日汇总，加上利润日表（订单、财务、广告任何一个变化都要重算利润）。名称与来源要和 profit/run.ts 的 PROFIT_SOURCES 一致。 */
const TRIGGERED_TASKS: ReadonlyArray<{ name: string; sources: readonly string[] }> = [...SUMMARY_TASKS, { name: PROFIT_DERIVE_TASK, sources: ['orders', 'finance', 'ads'] }]
export const derivedTasksForSource = { forSource: (source: string) => TRIGGERED_TASKS.filter(task => task.sources.includes(source)) }

/** 同步任务的数据域 → 原始数据来源；没有对应派生数据的数据域返回 null。 */
export const derivedSourceOfDomain = (domain: string | null | undefined): string | null => (domain === 'orders' || domain === 'finance' || domain === 'ads' ? domain : null)

const SALES_TRAFFIC_SOURCE = 'sales-traffic'
const datasetOf = (context: unknown): string | null => {
  const dataset = (context as { dataset?: unknown } | null | undefined)?.dataset
  return typeof dataset === 'string' ? dataset : null
}

/** 同步任务 → 原始数据来源：先看数据域；数据中心查询的数据域是 general，要看它查的数据集（销售与流量的三个数据集来源是 sales-traffic，P4-01）。 */
export function derivedSourceOf(domain: string | null | undefined, context: unknown): string | null {
  // 任务自己声明不改指标（广告实体同步，P5-12A）：不触发汇总与利润重算
  if ((context as { skipSummaries?: unknown } | null | undefined)?.skipSummaries === true) return null
  const dataset = datasetOf(context)
  if (dataset && (SALES_TRAFFIC_DATASETS as readonly string[]).includes(dataset)) return SALES_TRAFFIC_SOURCE
  return derivedSourceOfDomain(domain)
}

/** 销售与流量查询覆盖的日期（任务参数里的窗口或单日）；参数不合法返回 null。官方日期原样当作汇总日期，不放宽。 */
function salesTrafficRange(context: unknown): { dateFrom: string; dateTo: string } | null {
  const params = (context as { params?: Record<string, unknown> } | null | undefined)?.params
  const pattern = /^\d{4}-\d{2}-\d{2}$/
  const from = typeof params?.startDate === 'string' ? params.startDate : typeof params?.date === 'string' ? params.date : null
  const to = typeof params?.endDate === 'string' ? params.endDate : typeof params?.date === 'string' ? params.date : null
  return from && to && pattern.test(from) && pattern.test(to) && from <= to ? { dateFrom: from, dateTo: to } : null
}

export function summaryRangeFor(context: unknown, now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const dataset = datasetOf(context)
  if (dataset && (SALES_TRAFFIC_DATASETS as readonly string[]).includes(dataset)) {
    const range = salesTrafficRange(context)
    if (range) return range
  }
  const window = (context as { window?: { after?: string; before?: string } } | null | undefined)?.window
  const after = window?.after ? Date.parse(window.after) : NaN
  const before = window?.before ? Date.parse(window.before) : NaN
  if (Number.isFinite(after) && Number.isFinite(before) && after <= before) return { dateFrom: day(after - DAY_MS), dateTo: day(before + DAY_MS) }
  return { dateFrom: day(now.getTime() - (RECENT_DAYS - 1) * DAY_MS), dateTo: day(now.getTime() + DAY_MS) }
}

export interface QueueLookup {
  get(name: string): DeriveQueue
}

/** 提交失败不影响同步本身（汇总可由下一次同步或定时重算补上），返回提交了的任务名。 */
export async function enqueueSummariesAfterSync(
  queues: QueueLookup,
  input: { tenantId: string; domain: string | null | undefined; context: unknown; requestId: string; now?: Date },
): Promise<string[]> {
  const source = derivedSourceOf(input.domain, input.context)
  if (!source) return []
  try {
    const range = summaryRangeFor(input.context, input.now)
    return await enqueueDerivedFor(queues.get(DERIVE_QUEUE_NAME), derivedTasksForSource, { tenantId: input.tenantId, source, requestId: input.requestId, ...range })
  } catch {
    return []
  }
}

export type { DerivePayload }
