// PostgreSQL 存储：流程状态机、死信、分布式锁。
// 不依赖 @prisma/client：只约定需要的方法（结构化类型），由 api / worker 注入真实的 Prisma 客户端。
// 租户表的读写都通过 runInTenant 在“已设置租户上下文”的事务里执行（行级安全生效）；
// 只有崩溃恢复这类跨租户扫描才使用 system 客户端。

import { randomUUID } from 'node:crypto'
import type { DeadLetterEntry, DeadLetterStore, NewDeadLetter } from './dead-letter'
import type { LockStore } from './lock'
import type { CreateRunInput, RunPatch, RunRecord, StepPatch, StepRecord, WorkflowStore } from './store'

type Delegate = {
  findUnique(args: any): Promise<any>
  findFirst(args: any): Promise<any>
  findMany(args: any): Promise<any[]>
  update(args: any): Promise<any>
  updateMany(args: any): Promise<{ count: number }>
  upsert(args: any): Promise<any>
  createMany(args: any): Promise<{ count: number }>
  deleteMany(args: any): Promise<{ count: number }>
}

export interface WorkflowPrisma {
  workflowRun: Delegate
  workflowStep: Delegate
  deadLetterJob: Delegate
  distributedLock: Delegate
}

export type TenantRunner = <T>(tenantId: string, fn: (db: WorkflowPrisma) => Promise<T>) => Promise<T>

export interface PrismaStoreDeps {
  runInTenant: TenantRunner
  /** 跨租户扫描用的系统客户端（BYPASSRLS）。 */
  system: WorkflowPrisma
  /** Prisma.DbNull：把可空 Json 列写成 SQL NULL。 */
  dbNull: unknown
}

const toRun = (row: any): RunRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  kind: row.kind,
  status: row.status,
  dedupeKey: row.dedupeKey,
  intent: row.intentJson,
  result: row.resultJson ?? null,
  checkpoint: row.checkpointJson ?? null,
  errorCode: row.errorCode,
  priority: row.priority,
  attempt: row.attempt,
  syncJobId: row.syncJobId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  heartbeatAt: row.heartbeatAt,
  deadlineAt: row.deadlineAt,
  lockOwner: row.lockOwner,
})

const toStep = (row: any): StepRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  seq: row.seq,
  name: row.name,
  status: row.status,
  request: row.requestJson ?? null,
  response: row.responseJson ?? null,
  errorCode: row.errorCode,
  attempt: row.attempt,
  nextRunAt: row.nextRunAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
})

export class PrismaWorkflowStore implements WorkflowStore {
  constructor(private readonly deps: PrismaStoreDeps) {}

  private json(value: unknown) {
    return value === null || value === undefined ? this.deps.dbNull : value
  }

  private runData(patch: RunPatch) {
    const data: Record<string, unknown> = {}
    for (const key of ['status', 'errorCode', 'priority', 'attempt', 'syncJobId', 'finishedAt', 'heartbeatAt', 'deadlineAt', 'lockOwner'] as const) {
      if (key in patch) data[key] = (patch as any)[key]
    }
    if ('result' in patch) data.resultJson = this.json(patch.result)
    if ('checkpoint' in patch) data.checkpointJson = this.json(patch.checkpoint)
    return data
  }

  private stepData(patch: StepPatch) {
    const data: Record<string, unknown> = {}
    for (const key of ['name', 'status', 'errorCode', 'attempt', 'nextRunAt', 'startedAt', 'finishedAt'] as const) {
      if (key in patch) data[key] = (patch as any)[key]
    }
    if ('request' in patch) data.requestJson = this.json(patch.request)
    if ('response' in patch) data.responseJson = this.json(patch.response)
    return data
  }

  async createRun(input: CreateRunInput, now: Date) {
    return this.deps.runInTenant(input.tenantId, async db => {
      if (input.dedupeKey) {
        const existing = await db.workflowRun.findFirst({ where: { tenantId: input.tenantId, kind: input.kind, dedupeKey: input.dedupeKey } })
        if (existing) return { run: toRun(existing), created: false }
      }
      const id = randomUUID()
      // createMany + skipDuplicates：并发创建同一去重键时，只有一个会写入，不会因唯一冲突中断事务。
      const created = await db.workflowRun.createMany({
        data: [
          {
            id,
            tenantId: input.tenantId,
            kind: input.kind,
            dedupeKey: input.dedupeKey ?? null,
            intentJson: input.intent,
            priority: input.priority ?? 3,
            syncJobId: input.syncJobId ?? null,
            startedAt: now,
            heartbeatAt: now,
            deadlineAt: input.deadlineAt ?? null,
          },
        ],
        skipDuplicates: true,
      })
      if (created.count === 1) return { run: toRun(await db.workflowRun.findUnique({ where: { id } })), created: true }
      const winner = await db.workflowRun.findFirst({ where: { tenantId: input.tenantId, kind: input.kind, dedupeKey: input.dedupeKey ?? undefined } })
      return { run: toRun(winner), created: false }
    })
  }

  async getRun(tenantId: string, runId: string) {
    return this.deps.runInTenant(tenantId, async db => {
      const row = await db.workflowRun.findFirst({ where: { id: runId, tenantId } })
      return row ? toRun(row) : null
    })
  }

  async updateRun(tenantId: string, runId: string, patch: RunPatch) {
    return this.deps.runInTenant(tenantId, async db => toRun(await db.workflowRun.update({ where: { id: runId }, data: this.runData(patch) })))
  }

  async getStep(tenantId: string, runId: string, seq: number) {
    return this.deps.runInTenant(tenantId, async db => {
      const row = await db.workflowStep.findFirst({ where: { tenantId, runId, seq } })
      return row ? toStep(row) : null
    })
  }

  async saveStep(tenantId: string, runId: string, seq: number, name: string, patch: StepPatch) {
    return this.deps.runInTenant(tenantId, async db => {
      const data = this.stepData(patch)
      return toStep(await db.workflowStep.upsert({ where: { runId_seq: { runId, seq } }, create: { tenantId, runId, seq, name, ...data }, update: data }))
    })
  }

  async listSteps(tenantId: string, runId: string) {
    return this.deps.runInTenant(tenantId, async db => (await db.workflowStep.findMany({ where: { tenantId, runId }, orderBy: { seq: 'asc' } })).map(toStep))
  }

  async listStaleRuns(staleBefore: Date, limit: number) {
    return (await this.deps.system.workflowRun.findMany({ where: { status: 'RUNNING', heartbeatAt: { lt: staleBefore } }, orderBy: { heartbeatAt: 'asc' }, take: limit })).map(toRun)
  }
}

const toDeadLetter = (row: any): DeadLetterEntry => ({
  id: row.id,
  tenantId: row.tenantId,
  queue: row.queue,
  jobName: row.jobName,
  payloadRef: row.payloadRef,
  errorCode: row.errorCode,
  errorDetail: row.errorDetail,
  attempts: row.attempts,
  runId: row.runId,
  syncJobId: row.syncJobId,
  createdAt: row.createdAt,
  replayedAt: row.replayedAt,
  replayedBy: row.replayedBy,
})

export class PrismaDeadLetterStore implements DeadLetterStore {
  constructor(private readonly runInTenant: TenantRunner) {}

  async add(entry: NewDeadLetter, now: Date) {
    const id = randomUUID()
    return this.runInTenant(entry.tenantId, async db => {
      await db.deadLetterJob.createMany({ data: [{ id, ...entry, createdAt: now }] })
      return toDeadLetter(await db.deadLetterJob.findUnique({ where: { id } }))
    })
  }

  async list(tenantId: string, filter: { queue?: string; includeReplayed?: boolean; limit?: number }) {
    return this.runInTenant(tenantId, async db =>
      (
        await db.deadLetterJob.findMany({
          where: { tenantId, ...(filter.queue ? { queue: filter.queue } : {}), ...(filter.includeReplayed ? {} : { replayedAt: null }) },
          orderBy: { createdAt: 'desc' },
          take: filter.limit ?? 50,
        })
      ).map(toDeadLetter),
    )
  }

  async get(tenantId: string, id: string) {
    return this.runInTenant(tenantId, async db => {
      const row = await db.deadLetterJob.findFirst({ where: { id, tenantId } })
      return row ? toDeadLetter(row) : null
    })
  }

  async markReplayed(tenantId: string, id: string, userId: string, now: Date) {
    // 条件更新即互斥：并发重放同一条，只有一个 count 为 1。
    return this.runInTenant(tenantId, async db => (await db.deadLetterJob.updateMany({ where: { id, tenantId, replayedAt: null }, data: { replayedAt: now, replayedBy: userId } })).count === 1)
  }

  async unmarkReplayed(tenantId: string, id: string) {
    await this.runInTenant(tenantId, async db => {
      await db.deadLetterJob.updateMany({ where: { id, tenantId }, data: { replayedAt: null, replayedBy: null } })
    })
  }
}

export class PrismaLockStore implements LockStore {
  constructor(private readonly runInTenant: TenantRunner) {}

  async acquire(tenantId: string, lockKey: string, owner: string, leaseMs: number, now: Date) {
    const leaseUntil = new Date(now.getTime() + leaseMs)
    return this.runInTenant(tenantId, async db => {
      // 1) 自己已持有：续约，围栏令牌不变。
      const own = await db.distributedLock.updateMany({ where: { tenantId, lockKey, owner }, data: { leaseUntil, renewedAt: now } })
      if (own.count === 1) return (await db.distributedLock.findFirst({ where: { tenantId, lockKey } })).fence as number
      // 2) 他人的租约已过期：条件更新接管，围栏令牌 +1（并发接管只有一个 count 为 1）。
      const taken = await db.distributedLock.updateMany({
        where: { tenantId, lockKey, owner: { not: owner }, leaseUntil: { lt: now } },
        data: { owner, leaseUntil, renewedAt: now, fence: { increment: 1 } },
      })
      if (taken.count === 1) return (await db.distributedLock.findFirst({ where: { tenantId, lockKey } })).fence as number
      // 3) 还没有这把锁：创建（skipDuplicates 避免并发创建时事务被唯一冲突中断）。
      const created = await db.distributedLock.createMany({ data: [{ id: randomUUID(), tenantId, lockKey, owner, fence: 1, leaseUntil, renewedAt: now }], skipDuplicates: true })
      return created.count === 1 ? 1 : null
    })
  }

  async renew(tenantId: string, lockKey: string, owner: string, fence: number, leaseMs: number, now: Date) {
    const leaseUntil = new Date(now.getTime() + leaseMs)
    return this.runInTenant(tenantId, async db => (await db.distributedLock.updateMany({ where: { tenantId, lockKey, owner, fence }, data: { leaseUntil, renewedAt: now } })).count === 1)
  }

  async release(tenantId: string, lockKey: string, owner: string, fence: number) {
    await this.runInTenant(tenantId, async db => {
      await db.distributedLock.deleteMany({ where: { tenantId, lockKey, owner, fence } })
    })
  }
}
