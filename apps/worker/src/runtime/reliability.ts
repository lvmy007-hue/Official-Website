import { Prisma, type PrismaClient } from '@prisma/client'
import { runWithTenant } from '@nova/tenancy'
import {
  DeadLetterService,
  DistributedLockManager,
  PrismaDeadLetterStore,
  PrismaLockStore,
  PrismaWorkflowStore,
  RedisConcurrencyGate,
  RedisRateLimiter,
  WorkflowEngine,
  rateSignalFromResponse,
  waitForToken,
  type ConcurrencyGate,
  type RateLimiter,
  type TenantRunner,
  type WorkflowPrisma,
} from '@nova/workflow'
import type { RequestGuard } from '../connectors/http-error'
import type { RedisConnections } from './redis'

// 可靠性工具箱（12.3）：把 @nova/workflow 的内核接到本进程的数据库与 Redis 上。
// 租户表（流程、死信、锁）一律走租户连接并设置租户上下文；只有崩溃恢复扫描用系统连接。

export interface Reliability {
  ownerId: string
  locks: DistributedLockManager
  gate: ConcurrencyGate
  limiter: RateLimiter
  deadLetters: DeadLetterService
  engine: WorkflowEngine
  /** 按店铺授权生成的请求守卫：令牌桶限速 + 响应头校准。 */
  guardFor(tenantId: string, connectionId: string): RequestGuard
}

export interface ReliabilityDeps {
  prisma: PrismaClient
  systemPrisma: PrismaClient
  redis: RedisConnections
  env?: NodeJS.ProcessEnv
  ownerId?: string
}

const numberFrom = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) : fallback)

export function createReliability(deps: ReliabilityDeps): Reliability {
  const env = deps.env ?? process.env
  const ownerId = deps.ownerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const runInTenant: TenantRunner = (tenantId, fn) => runWithTenant(tenantId, () => deps.prisma.$transaction(tx => fn(tx as unknown as WorkflowPrisma)))
  const store = new PrismaWorkflowStore({ runInTenant, system: deps.systemPrisma as unknown as WorkflowPrisma, dbNull: Prisma.DbNull })
  const engine = new WorkflowEngine(store, { ownerId })
  const locks = new DistributedLockManager(new PrismaLockStore(runInTenant), { leaseMs: numberFrom(env.LOCK_LEASE_MS, 90_000) })
  const gate = new RedisConcurrencyGate(deps.redis.cache as never, { limit: numberFrom(env.TENANT_MAX_CONCURRENT_JOBS, 2), ownerId })
  const limiter = new RedisRateLimiter(deps.redis.cache as never, {
    defaults: { ratePerSecond: numberFrom(env.AMAZON_DEFAULT_RATE_PER_SECOND, 1), burst: numberFrom(env.AMAZON_DEFAULT_BURST, 2), minRatePerSecond: 0.05, maxRatePerSecond: 20 },
  })
  // 死信：worker 只负责记录；重放由接口服务在用户操作时入队，这里的入队函数不应被调用。
  const deadLetters = new DeadLetterService(new PrismaDeadLetterStore(runInTenant), async () => {
    throw new Error('后台任务进程不执行死信重放')
  })

  return {
    ownerId,
    locks,
    gate,
    limiter,
    deadLetters,
    engine,
    guardFor(tenantId, connectionId) {
      const bucket = (family: string) => `${tenantId}:${connectionId}:${family}`
      return {
        before: family => waitForToken(limiter, bucket(family), { maxWaitMs: numberFrom(env.RATE_LIMIT_MAX_WAIT_MS, 30_000) }),
        after: (family, status, headers) => limiter.report(bucket(family), rateSignalFromResponse(status, headers)),
      }
    },
  }
}
