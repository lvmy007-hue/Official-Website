import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { vi } from 'vitest'
import { AppModule } from '../app.module'
import { configureApp } from '../platform/configure-app'
import { PrismaService, SystemPrismaService } from '../platform/prisma.service'
import { QueueService } from '../platform/queue.service'
import { RateLimitService } from '../platform/rate-limit.service'
import { SecretBoxService } from '../platform/security/secret-box.service'
import { WorkflowService } from '../platform/workflow'
import { MemorySecretBox } from './memory-secret-box'
import { assertNoPiiLeak } from './pii-response-guard'

// 测试用的内存替身：只实现被测代码会调用的方法，调用到未实现的方法会直接报错，避免静默通过。
export type PrismaStub = Record<string, unknown>

const LIFECYCLE_HOOKS = new Set(['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown', 'beforeApplicationShutdown'])

export function strictPrisma(stub: PrismaStub): PrismaService {
  return new Proxy(stub, {
    get(target, key) {
      if (key in target) return target[key as string]
      if (typeof key === 'symbol' || key === 'then' || key === 'constructor' || LIFECYCLE_HOOKS.has(key)) return undefined
      throw new Error(`测试未提供 prisma.${String(key)} 的替身`)
    },
  }) as unknown as PrismaService
}

export const FULL_ACCESS_ROLE = { permissions: ['*'] }

// 让上下文解析通过：会话有效、成员关系有效、权限由参数指定。
export function sessionStub(permissions: string[], tenantId = 'tenant-1') {
  return {
    session: {
      findFirst: vi.fn().mockResolvedValue({ id: 'session-1', lastSeenAt: new Date() }),
      update: vi.fn().mockResolvedValue({}),
    },
    membership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId, role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }) },
    // 默认没有绑定多因素认证；需要“已绑定”或强制策略的用例自行覆盖
    mfaFactor: { findUnique: vi.fn().mockResolvedValue(null) },
    // 默认授予“全部范围”；需要测试范围收窄的用例自行覆盖。
    membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: null }]) },
    customMetric: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

// 写接口拦截器会读写幂等记录与审计事件；测试默认给出“记录不存在、写入成功”的替身，需要断言时自行覆盖。
export function createWriteGuardStubs() {
  return {
    idempotencyRecord: {
      create: vi.fn().mockResolvedValue({ id: 'idem-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    stepUpVerification: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  }
}

export async function createTestApp(prisma: PrismaStub, log?: Logger) {
  const writeGuardStubs = createWriteGuardStubs()
  const queue = {
    add: vi.fn().mockResolvedValue({ id: 'queued' }),
    addRaw: vi.fn().mockResolvedValue({ id: 'queued' }),
    ping: vi.fn().mockResolvedValue('PONG'),
    counts: vi.fn().mockResolvedValue({}),
  }
  // 流程登记与死信：单元级测试不碰数据库；真实行为由 workflow.db.test.ts 覆盖
  const workflow = {
    registerWriteRun: vi.fn(async (req: { writeRunId?: string }, _input?: unknown) => {
      req.writeRunId = 'run-1'
      return { id: 'run-1' }
    }),
    listDeadLetters: vi.fn().mockResolvedValue([]),
    getDeadLetter: vi.fn().mockResolvedValue(null),
    replayDeadLetter: vi.fn().mockResolvedValue(null),
  }
  const rateLimit = {
    check: vi.fn().mockResolvedValue(undefined),
    assertUnlocked: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    clearFailures: vi.fn().mockResolvedValue(undefined),
    buckets: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    tenantSlots: vi.fn().mockResolvedValue(0),
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(strictPrisma({ ...writeGuardStubs, ...prisma }))
    // 单元级测试里租户连接与系统连接共用同一份内存替身；真实的隔离行为由数据库测试覆盖
    .overrideProvider(SystemPrismaService)
    .useValue(strictPrisma({ ...writeGuardStubs, ...prisma }))
    .overrideProvider(QueueService)
    .useValue(queue)
    .overrideProvider(WorkflowService)
    .useValue(workflow)
    .overrideProvider(RateLimitService)
    .useValue(rateLimit)
    // 数据密钥放内存：单元级测试不碰数据库，加密解密的真实行为不变
    .overrideProvider(SecretBoxService)
    .useValue(new MemorySecretBox())
    .compile()
  const app: INestApplication = moduleRef.createNestApplication()
  configureApp(app, log)
  await app.listen(0, '127.0.0.1')
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1')
  const jwt = moduleRef.get(JwtService)
  const token = await jwt.signAsync({ userId: 'user-1', sessionId: 'session-1' })

  // 写请求默认带一个随机幂等键（与前端请求层的行为一致）；传 idempotencyKey: false 可模拟不带键的请求。
  async function call(method: string, path: string, init: { body?: unknown; auth?: boolean; headers?: Record<string, string>; idempotencyKey?: string | false } = {}) {
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(init.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(writes && init.idempotencyKey !== false ? { 'idempotency-key': init.idempotencyKey ?? `test-${randomUUID()}` } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await response.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    assertNoPiiLeak(method, path, json)
    return { status: response.status, json, headers: response.headers }
  }

  return { app, queue, workflow, rateLimit, call, writeGuardStubs, close: () => app.close() }
}
