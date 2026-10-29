// 日汇总表增量刷新的派生任务骨架（P1-27）。
// 原始数据（订单、结算、广告、库存）写入之后，按“来源 + 日期范围”触发对应的汇总任务重新计算那几天的数据。
// 约定：
//   1. 每个汇总任务的 refresh 必须幂等：对同一租户、同一日期范围重复执行，结果完全相同（先删除该范围再写入，放在同一事务内）；
//   2. 同一租户、同一任务、同一日期范围同时只保留一个排队中的任务（任务编号由这三项决定，重复提交自动合并）；
//   3. 日期范围按 UTC 日历日，闭区间，最长 1100 天，与查询接口的范围限制一致；
//   4. 具体汇总表与任务由后续工作包注册，本文件不包含任何业务计算，也不读取任何租户数据。

export const DERIVE_QUEUE_NAME = 'derive'
export const DERIVE_MAX_RANGE_DAYS = 1100
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface DeriveRange {
  dateFrom: string
  dateTo: string
}
export interface DerivePayload extends DeriveRange {
  tenantId: string
  task: string
  requestId: string
  traceparent?: string
}

export interface DeriveContext extends DeriveRange {
  tenantId: string
}
export interface DeriveResult {
  rows: number
}

export interface DeriveTask {
  /** 任务名称，全局唯一，如 `daily_sales`。 */
  readonly name: string
  /** 该任务依赖的原始数据来源，如 `orders`、`finance`、`ads`、`inventory`。 */
  readonly sources: readonly string[]
  refresh(context: DeriveContext): Promise<DeriveResult>
}

export class DeriveRangeError extends Error {}
export class DeriveTaskNotFoundError extends Error {}

function parseUtcDay(value: string): number {
  if (!DATE_PATTERN.test(value)) throw new DeriveRangeError(`invalid date: ${value}`)
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new DeriveRangeError(`invalid date: ${value}`)
  return time
}

export function validateDeriveRange(range: DeriveRange): DeriveRange {
  const from = parseUtcDay(range.dateFrom)
  const to = parseUtcDay(range.dateTo)
  if (from > to) throw new DeriveRangeError('dateFrom must not be after dateTo')
  if ((to - from) / DAY_MS + 1 > DERIVE_MAX_RANGE_DAYS) throw new DeriveRangeError(`range must not exceed ${DERIVE_MAX_RANGE_DAYS} days`)
  return { dateFrom: range.dateFrom, dateTo: range.dateTo }
}

/** 任务编号：同租户、同任务、同范围一致，用于队列去重。队列任务编号不允许出现冒号，用下划线连接。 */
export function deriveJobId(payload: Pick<DerivePayload, 'tenantId' | 'task' | 'dateFrom' | 'dateTo'>): string {
  return ['derive', payload.tenantId, payload.task, payload.dateFrom, payload.dateTo].join('_')
}

export class DeriveRegistry {
  private readonly tasks = new Map<string, DeriveTask>()

  register(task: DeriveTask): void {
    if (!/^[a-z][a-z0-9_]*$/.test(task.name)) throw new Error(`invalid derive task name: ${task.name}`)
    if (this.tasks.has(task.name)) throw new Error(`derive task already registered: ${task.name}`)
    if (task.sources.length === 0) throw new Error(`derive task has no source: ${task.name}`)
    this.tasks.set(task.name, task)
  }

  get(name: string): DeriveTask | undefined {
    return this.tasks.get(name)
  }
  list(): DeriveTask[] {
    return [...this.tasks.values()]
  }
  forSource(source: string): DeriveTask[] {
    return this.list().filter(task => task.sources.includes(source))
  }
}

export interface DeriveQueue {
  add(
    name: string,
    data: DerivePayload,
    options: { jobId: string; attempts: number; backoff: { type: 'exponential'; delay: number }; removeOnComplete: boolean | number; removeOnFail: number },
  ): Promise<unknown>
}

export interface SourceChange extends DeriveRange {
  tenantId: string
  source: string
  requestId: string
  traceparent?: string
}

/** 某个来源的原始数据发生变化后，为依赖它的所有汇总任务提交刷新；没有依赖任务时什么都不做。返回提交的任务名称。 */
export async function enqueueDerivedFor(queue: DeriveQueue, registry: { forSource(source: string): ReadonlyArray<{ name: string }> }, change: SourceChange): Promise<string[]> {
  const range = validateDeriveRange(change)
  const queued: string[] = []
  for (const task of registry.forSource(change.source)) {
    const payload: DerivePayload = { tenantId: change.tenantId, task: task.name, requestId: change.requestId, ...range, ...(change.traceparent ? { traceparent: change.traceparent } : {}) }
    await queue.add('derive', payload, { jobId: deriveJobId(payload), attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 2000 })
    queued.push(task.name)
  }
  return queued
}

export interface DeriveLogger {
  info(fields: Record<string, unknown>, message: string): void
}

export async function runDerive(registry: DeriveRegistry, payload: DerivePayload, logger: DeriveLogger): Promise<DeriveResult> {
  const task = registry.get(payload.task)
  if (!task) throw new DeriveTaskNotFoundError(`derive task not registered: ${payload.task}`)
  const range = validateDeriveRange(payload)
  const startedAt = Date.now()
  const result = await task.refresh({ tenantId: payload.tenantId, ...range })
  logger.info(
    { event: 'derive_refreshed', task: task.name, tenantId: payload.tenantId, requestId: payload.requestId, ...range, rows: result.rows, durationMs: Date.now() - startedAt },
    'derived data refreshed',
  )
  return result
}
