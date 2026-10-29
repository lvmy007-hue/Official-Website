// 死信（12.3）：重试用尽或不可重试的任务不静默丢弃，而是留下完整现场（队列、任务名、载荷、错误码、重试次数），
// 由有权限的人在同步中心查看并“重放”。重放只会成功一次：并发重放同一条死信，只有一个能入队。

export interface DeadLetterEntry {
  id: string
  tenantId: string
  queue: string
  jobName: string
  /** 任务载荷（JSON 文本）。任务载荷只含内部编号，不含令牌与买家个人信息；写入前强制校验。 */
  payloadRef: string
  errorCode: string
  errorDetail: string
  attempts: number
  runId: string | null
  syncJobId: string | null
  createdAt: Date
  replayedAt: Date | null
  replayedBy: string | null
}

export type NewDeadLetter = Omit<DeadLetterEntry, 'id' | 'createdAt' | 'replayedAt' | 'replayedBy'>

export interface DeadLetterStore {
  add(entry: NewDeadLetter, now: Date): Promise<DeadLetterEntry>
  list(tenantId: string, filter: { queue?: string; includeReplayed?: boolean; limit?: number }): Promise<DeadLetterEntry[]>
  get(tenantId: string, id: string): Promise<DeadLetterEntry | null>
  /** 仅当尚未重放时标记并返回 true：用作并发重放的互斥。 */
  markReplayed(tenantId: string, id: string, userId: string, now: Date): Promise<boolean>
  /** 入队失败时回退标记，让这条死信可以再次重放。 */
  unmarkReplayed(tenantId: string, id: string): Promise<void>
}

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|buyer|email|phone|address|recipient|ssn/i

/** 载荷里不得出现令牌/个人信息字段：命中即拒绝写入死信（宁可丢现场也不泄漏）。 */
export function assertSafePayload(payload: unknown, path = 'payload'): void {
  if (payload === null || typeof payload !== 'object') return
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`死信载荷 ${path}.${key} 含疑似敏感字段，拒绝写入`)
    assertSafePayload(value, `${path}.${key}`)
  }
}

/** 错误详情去敏并截断：抹掉 Bearer 令牌、亚马逊刷新令牌、长串密钥。 */
export function sanitizeErrorDetail(detail: string, maxLength = 1500): string {
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/Atz[ra]\|[A-Za-z0-9._~+/=|-]+/g, '[已隐藏的亚马逊令牌]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[已隐藏]')
    .slice(0, maxLength)
}

export interface Enqueue {
  (target: { queue: string; jobName: string; payload: unknown; jobId: string; priority?: number }): Promise<void>
}

export class MemoryDeadLetterStore implements DeadLetterStore {
  readonly rows = new Map<string, DeadLetterEntry>()
  private seq = 0
  async add(entry: NewDeadLetter, now: Date) {
    const row: DeadLetterEntry = { ...entry, id: `dl_${++this.seq}`, createdAt: now, replayedAt: null, replayedBy: null }
    this.rows.set(row.id, row)
    return { ...row }
  }
  async list(tenantId: string, filter: { queue?: string; includeReplayed?: boolean; limit?: number }) {
    return [...this.rows.values()]
      .filter(row => row.tenantId === tenantId && (!filter.queue || row.queue === filter.queue) && (filter.includeReplayed || row.replayedAt === null))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit ?? 50)
      .map(row => ({ ...row }))
  }
  async get(tenantId: string, id: string) {
    const row = this.rows.get(id)
    return row && row.tenantId === tenantId ? { ...row } : null
  }
  async markReplayed(tenantId: string, id: string, userId: string, now: Date) {
    const row = this.rows.get(id)
    if (!row || row.tenantId !== tenantId || row.replayedAt) return false
    row.replayedAt = now
    row.replayedBy = userId
    return true
  }
  async unmarkReplayed(tenantId: string, id: string) {
    const row = this.rows.get(id)
    if (row && row.tenantId === tenantId) {
      row.replayedAt = null
      row.replayedBy = null
    }
  }
}

export class DeadLetterService {
  constructor(
    private readonly store: DeadLetterStore,
    private readonly enqueue: Enqueue,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: {
    tenantId: string
    queue: string
    jobName: string
    payload: unknown
    errorCode: string
    errorDetail: string
    attempts: number
    runId?: string | null
    syncJobId?: string | null
  }) {
    assertSafePayload(input.payload)
    return this.store.add(
      {
        tenantId: input.tenantId,
        queue: input.queue,
        jobName: input.jobName,
        payloadRef: JSON.stringify(input.payload),
        errorCode: input.errorCode,
        errorDetail: sanitizeErrorDetail(input.errorDetail),
        attempts: input.attempts,
        runId: input.runId ?? null,
        syncJobId: input.syncJobId ?? null,
      },
      this.now(),
    )
  }

  /** 重放：互斥标记 → 入队；入队失败则回退标记。返回 null 表示这条死信不存在或已被重放过。 */
  async replay(tenantId: string, id: string, userId: string): Promise<DeadLetterEntry | null> {
    const entry = await this.store.get(tenantId, id)
    if (!entry) return null
    const won = await this.store.markReplayed(tenantId, id, userId, this.now())
    if (!won) return null
    try {
      await this.enqueue({ queue: entry.queue, jobName: entry.jobName, payload: JSON.parse(entry.payloadRef), jobId: `replay-${entry.id}` })
    } catch (error) {
      await this.store.unmarkReplayed(tenantId, id)
      throw error
    }
    return (await this.store.get(tenantId, id)) ?? entry
  }
}
