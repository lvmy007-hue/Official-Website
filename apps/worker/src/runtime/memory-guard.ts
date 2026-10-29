import v8 from 'node:v8'
import { allocateConcurrency, type MemoryBudget } from '@nova/workflow'

// 内存防护（12.5 后台任务）：
// 1. 并发按内存预算设定：流式处理后单个任务的内存与文件大小无关，只与批大小有关，所以预算 / 单任务估算 = 可同时处理的任务数；
// 2. 进程内存守卫：常驻内存（RSS）或堆占用比例连续多次超限，说明出现了内存泄漏或异常任务——
//    不再领取新任务，等在途任务收尾后优雅退出，由守护进程（容器重启策略）拉起干净的新进程，而不是被系统强杀、丢掉在途任务。

export const DEFAULT_RSS_LIMIT_MB = 1500
export const DEFAULT_HEAP_RATIO = 0.85
export const DEFAULT_JOB_MEMORY_MB = 64
/** 预算默认占堆上限的比例：留出余量给连接池、缓冲与垃圾回收。 */
export const DEFAULT_BUDGET_HEAP_SHARE = 0.6
/** 因内存超限而退出时使用的退出码（EX_TEMPFAIL：暂时性失败，请重启）。 */
export const MEMORY_EXIT_CODE = 75

const positive = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) : fallback)

export interface MemorySample {
  rssBytes: number
  heapUsedBytes: number
  heapLimitBytes: number
}

export function sampleProcessMemory(): MemorySample {
  const usage = process.memoryUsage()
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapLimitBytes: v8.getHeapStatistics().heap_size_limit }
}

/** 并发预算：WORKER_MEMORY_BUDGET_MB 优先，否则取堆上限的 60%；单任务估算 JOB_MEMORY_MB（默认 64MB）。 */
export function memoryBudget(env: Record<string, string | undefined> = process.env, heapLimitBytes: number = v8.getHeapStatistics().heap_size_limit): MemoryBudget {
  return {
    budgetMb: positive(env.WORKER_MEMORY_BUDGET_MB, Math.floor((heapLimitBytes / 1024 / 1024) * DEFAULT_BUDGET_HEAP_SHARE)),
    perJobMb: positive(env.JOB_MEMORY_MB, DEFAULT_JOB_MEMORY_MB),
  }
}

/** 按内存预算缩放各队列的并发（每个队列至少保留 1）。 */
export function budgetedConcurrency(requested: Record<string, number>, env: Record<string, string | undefined> = process.env, heapLimitBytes?: number): Record<string, number> {
  return allocateConcurrency(requested, memoryBudget(env, heapLimitBytes))
}

export type MemoryVerdict = { exceeded: false } | { exceeded: true; reason: 'rss' | 'heap'; detail: string }

export interface MemoryGuardOptions {
  rssLimitMb?: number
  heapRatio?: number
  /** 连续多少次采样超限才判定为超限（避免一次瞬时峰值就重启）。 */
  consecutive?: number
  intervalMs?: number
  sample?: () => MemorySample
  /** 判定超限时调用一次：应停止领取新任务并优雅退出。 */
  onExceeded(verdict: Extract<MemoryVerdict, { exceeded: true }>): void
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
  /** 周期性输出内存日志的间隔（毫秒）；0 表示不输出。 */
  reportEveryMs?: number
}

export function memoryGuardOptionsFromEnv(env: Record<string, string | undefined> = process.env): Pick<MemoryGuardOptions, 'rssLimitMb' | 'heapRatio'> {
  const ratio = Number(env.WORKER_HEAP_RATIO)
  return { rssLimitMb: positive(env.WORKER_RSS_LIMIT_MB, DEFAULT_RSS_LIMIT_MB), heapRatio: ratio > 0 && ratio <= 1 ? ratio : DEFAULT_HEAP_RATIO }
}

export class MemoryGuard {
  private strikes = 0
  private triggered = false
  private timer: NodeJS.Timeout | undefined
  private lastReport = 0
  private readonly rssLimitMb: number
  private readonly heapRatio: number
  private readonly consecutive: number
  private readonly sample: () => MemorySample

  constructor(private readonly options: MemoryGuardOptions) {
    this.rssLimitMb = options.rssLimitMb ?? DEFAULT_RSS_LIMIT_MB
    this.heapRatio = options.heapRatio ?? DEFAULT_HEAP_RATIO
    this.consecutive = options.consecutive ?? 3
    this.sample = options.sample ?? sampleProcessMemory
  }

  /** 做一次判定（定时器调用；测试里可直接调用）。判定超限后只触发一次回调。 */
  check(now = Date.now()): MemoryVerdict {
    const sample = this.sample()
    const rssMb = sample.rssBytes / 1024 / 1024
    const heapRatio = sample.heapUsedBytes / sample.heapLimitBytes
    const reportEvery = this.options.reportEveryMs ?? 60_000
    if (reportEvery > 0 && now - this.lastReport >= reportEvery) {
      this.lastReport = now
      this.options.logger.info({ event: 'memory', rssMb: Math.round(rssMb), heapUsedMb: Math.round(sample.heapUsedBytes / 1024 / 1024), heapRatio: Number(heapRatio.toFixed(3)) }, 'worker memory')
    }
    const over: MemoryVerdict =
      rssMb > this.rssLimitMb
        ? { exceeded: true, reason: 'rss', detail: `常驻内存 ${Math.round(rssMb)}MB 超过上限 ${this.rssLimitMb}MB` }
        : heapRatio > this.heapRatio
          ? { exceeded: true, reason: 'heap', detail: `堆占用 ${(heapRatio * 100).toFixed(1)}% 超过上限 ${(this.heapRatio * 100).toFixed(0)}%` }
          : { exceeded: false }
    if (!over.exceeded) {
      this.strikes = 0
      return over
    }
    this.strikes += 1
    this.options.logger.warn({ event: 'memory_over_limit', strikes: this.strikes, of: this.consecutive, reason: over.reason }, over.detail)
    if (this.strikes >= this.consecutive && !this.triggered) {
      this.triggered = true
      this.options.logger.error({ event: 'memory_guard_triggered', reason: over.reason }, `${over.detail}：停止领取新任务，等在途任务收尾后退出并由守护进程重启`)
      this.options.onExceeded(over)
    }
    return over
  }

  start(): this {
    if (this.timer) return this
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 10_000)
    this.timer.unref()
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  get isTriggered() {
    return this.triggered
  }
}
