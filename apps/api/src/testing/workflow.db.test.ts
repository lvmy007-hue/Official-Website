import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import {
  DeadLetterService,
  DistributedLockManager,
  PrismaDeadLetterStore,
  PrismaLockStore,
  PrismaWorkflowStore,
  WorkflowEngine,
  type TenantRunner,
  type WorkflowDefinition,
  type WorkflowPrisma,
  type WorkflowStore,
} from '@nova/workflow'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 任务与队列体系（P1-20，12.3）：流程状态机、分布式锁、死信的真实数据库行为。
// 全部通过租户连接账号（受行级安全约束）访问，验证并发去重、租约接管、崩溃恢复与跨租户隔离。

describe('任务与队列体系（真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let system: PrismaClient
  let runInTenant: TenantRunner
  let workflowStore: PrismaWorkflowStore
  let lockStore: PrismaLockStore
  let deadLetterStore: PrismaDeadLetterStore
  let A: string
  let B: string

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('wf')
    db.migrate('wf')
    admin = await db.connect('wf')
    A = (await seedTenant(admin, 'wf-a')).tenantId
    B = (await seedTenant(admin, 'wf-b')).tenantId
    base = new PrismaClient({ datasourceUrl: db.urlFor('wf', 'app') })
    system = new PrismaClient({ datasourceUrl: db.urlFor('wf', 'system') })
    const scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) })
    runInTenant = (tenantId, fn) => runWithTenant(tenantId, () => scoped.$transaction((tx: unknown) => fn(tx as WorkflowPrisma)))
    workflowStore = new PrismaWorkflowStore({ runInTenant, system: system as unknown as WorkflowPrisma, dbNull: Prisma.DbNull })
    lockStore = new PrismaLockStore(runInTenant)
    deadLetterStore = new PrismaDeadLetterStore(runInTenant)
  })

  afterAll(async () => {
    await base?.$disconnect()
    await system?.$disconnect()
    await admin?.end()
    await db?.stop()
  })

  const countRows = async (table: string, where: string, params: unknown[] = []) => (await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params)).rows[0].n as number

  describe('流程状态机', () => {
    it('并发创建同一去重键：只会写入一个流程', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => workflowStore.createRun({ tenantId: A, kind: 'listing.create', dedupeKey: 'sku-concurrent', intent: { sku: 'S1' } }, new Date())),
      )
      expect(results.filter(item => item.created)).toHaveLength(1)
      expect(new Set(results.map(item => item.run.id)).size).toBe(1)
      expect(await countRows('WorkflowRun', `"tenantId" = $1 AND "dedupeKey" = 'sku-concurrent'`, [A])).toBe(1)
    })

    it('不同租户的同名去重键互不干扰；跨租户读写被行级安全挡住', async () => {
      const a = await workflowStore.createRun({ tenantId: A, kind: 'k2', dedupeKey: 'same', intent: {} }, new Date())
      const b = await workflowStore.createRun({ tenantId: B, kind: 'k2', dedupeKey: 'same', intent: {} }, new Date())
      expect(a.created && b.created).toBe(true)
      expect(await workflowStore.getRun(B, a.run.id)).toBeNull()
      await expect(workflowStore.updateRun(B, a.run.id, { status: 'CANCELLED' })).rejects.toThrow()
      expect((await workflowStore.getRun(A, a.run.id))!.status).toBe('RUNNING')
    })

    it('可空 JSON 字段能写入与清空；状态检查约束拒绝非法状态', async () => {
      const { run } = await workflowStore.createRun({ tenantId: A, kind: 'k3', intent: { a: 1 } }, new Date())
      await workflowStore.updateRun(A, run.id, { checkpoint: { page: 3 } })
      expect((await workflowStore.getRun(A, run.id))!.checkpoint).toEqual({ page: 3 })
      await workflowStore.updateRun(A, run.id, { checkpoint: null })
      expect((await workflowStore.getRun(A, run.id))!.checkpoint).toBeNull()
      await expect(workflowStore.updateRun(A, run.id, { status: 'BROKEN' as never })).rejects.toThrow()
    })

    // 假亚马逊：不做服务端去重，重复调用会产生重复对象。
    const amazon = { objects: [] as Array<{ id: string; clientRequestId: string }>, calls: 0 }
    const definition = (hooks: { afterCommit?: () => void } = {}): WorkflowDefinition => ({
      kind: 'listing.create.db',
      steps: [
        { name: '校验', run: async () => ({ ok: true }) },
        {
          name: '创建亚马逊对象',
          buildRequest: ctx => ({ clientRequestId: `req-${ctx.runId}` }),
          run: async ctx => {
            amazon.calls++
            const object = { id: `OBJ-${amazon.objects.length + 1}`, clientRequestId: ctx.request.clientRequestId }
            amazon.objects.push(object)
            hooks.afterCommit?.()
            return object
          },
          reconcile: async ctx => {
            const found = amazon.objects.find(object => object.clientRequestId === ctx.request.clientRequestId)
            return found ? { found: true, response: found } : { found: false }
          },
        },
        { name: '登记', run: async ctx => ({ objectId: (ctx.responseOf(1) as { id: string }).id }) },
      ],
    })

    it('崩溃恢复（真实数据库）：调用已生效但结果未记录时，恢复扫描对账后继续，不重复创建', async () => {
      let dead = false
      const crashable = new Proxy(workflowStore, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (dead) throw new Error('进程已终止')
            return value.apply(target, args)
          }
        },
      }) as WorkflowStore
      let clockMs = new Date('2026-10-21T00:00:00Z').getTime()
      const now = () => new Date(clockMs)
      const engine = new WorkflowEngine(crashable, { now })
      const def = definition({
        afterCommit: () => {
          dead = true
        },
      })
      const { run } = await engine.start({ tenantId: A, kind: def.kind, intent: { sku: 'S9' } })

      await expect(engine.execute(A, run.id, def)).rejects.toThrow('进程已终止')
      dead = false
      expect(amazon.objects).toHaveLength(1)
      expect((await workflowStore.getRun(A, run.id))!.status).toBe('RUNNING')
      expect((await workflowStore.getStep(A, run.id, 1))!.status).toBe('RUNNING')

      clockMs += 5 * 60_000
      const fresh = new WorkflowEngine(workflowStore, { now, ownerId: 'process-2' }).register(definition())
      const recovered = await fresh.recover({ staleMs: 60_000 })
      expect(recovered.find(item => item.runId === run.id)).toMatchObject({ outcome: 'resumed' })
      expect(await workflowStore.getRun(A, run.id)).toMatchObject({ status: 'SUCCEEDED', lockOwner: 'process-2', result: { objectId: 'OBJ-1' } })
      expect(amazon.calls).toBe(1)
      expect(amazon.objects).toHaveLength(1)
      expect((await workflowStore.listSteps(A, run.id)).map(step => step.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
    })
  })

  describe('分布式锁', () => {
    it('并发抢同一把锁：只有一个成功', async () => {
      const manager = new DistributedLockManager(lockStore, { renewEveryMs: 3_600_000 })
      const leases = await Promise.all(Array.from({ length: 10 }, (_, i) => manager.tryAcquire(A, 'sync:conn1:orders', `w${i}`)))
      const winners = leases.filter(Boolean)
      expect(winners).toHaveLength(1)
      expect(winners[0]!.fence).toBe(1)
      await winners[0]!.release()
      expect(await countRows('DistributedLock', `"tenantId" = $1 AND "lockKey" = 'sync:conn1:orders'`, [A])).toBe(0)
    })

    it('租约到期后被接管，围栏令牌递增；旧持有者续约失败并判定丢锁，且不会误删新持有者的锁', async () => {
      const t0 = new Date('2026-10-21T00:00:00Z')
      let now = t0
      const manager = new DistributedLockManager(lockStore, { leaseMs: 60_000, renewEveryMs: 3_600_000, now: () => now })
      const old = await manager.tryAcquire(A, 'sync:conn2:orders', 'w1')
      expect(old!.fence).toBe(1)
      expect(await manager.tryAcquire(A, 'sync:conn2:orders', 'w2')).toBeNull()
      now = new Date(t0.getTime() + 61_000)
      const taker = await manager.tryAcquire(A, 'sync:conn2:orders', 'w2')
      expect(taker!.fence).toBe(2)
      expect(await old!.renewNow()).toBe(false)
      expect(old!.isLost).toBe(true)
      await old!.release()
      expect(await countRows('DistributedLock', `"tenantId" = $1 AND "lockKey" = 'sync:conn2:orders' AND owner = 'w2'`, [A])).toBe(1)
      expect(await taker!.renewNow()).toBe(true)
      await taker!.release()
    })

    it('不同租户的同名锁互不影响', async () => {
      const manager = new DistributedLockManager(lockStore, { renewEveryMs: 3_600_000 })
      const a = await manager.tryAcquire(A, 'shared-key', 'w1')
      const b = await manager.tryAcquire(B, 'shared-key', 'w1')
      expect(a && b).toBeTruthy()
      await a!.release()
      await b!.release()
    })
  })

  describe('死信', () => {
    const enqueued: unknown[] = []
    const service = () =>
      new DeadLetterService(deadLetterStore, async target => {
        enqueued.push(target)
      })

    it('记录、按租户列出、并发重放只成功一次', async () => {
      const entry = await service().record({
        tenantId: A,
        queue: 'sync',
        jobName: 'sync',
        payload: { tenantId: A, syncJobId: 'j1' },
        errorCode: 'HTTP_400',
        errorDetail: '参数错误 Bearer abc.def',
        attempts: 3,
        syncJobId: 'j1',
      })
      expect(entry.errorDetail).not.toContain('abc.def')
      expect(await deadLetterStore.list(B, {})).toHaveLength(0)
      expect((await deadLetterStore.list(A, { queue: 'sync' })).map(item => item.id)).toContain(entry.id)

      const before = enqueued.length
      const results = await Promise.all([service().replay(A, entry.id, 'user-1'), service().replay(A, entry.id, 'user-2'), service().replay(A, entry.id, 'user-3')])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(enqueued.length - before).toBe(1)
      expect((await deadLetterStore.list(A, {})).map(item => item.id)).not.toContain(entry.id) // 默认不再列出已重放
      expect((await deadLetterStore.list(A, { includeReplayed: true })).map(item => item.id)).toContain(entry.id)
    })

    it('不能重放别的租户的死信', async () => {
      const entry = await service().record({ tenantId: A, queue: 'reports', jobName: 'report', payload: { tenantId: A }, errorCode: 'X', errorDetail: 'x', attempts: 1 })
      expect(await service().replay(B, entry.id, 'user-b')).toBeNull()
      expect((await deadLetterStore.get(A, entry.id))!.replayedAt).toBeNull()
    })
  })
})
