import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { vi } from 'vitest'
import { AppModule } from '../app.module'
import { configureApp } from '../platform/configure-app'
import { QueueService } from '../platform/queue.service'
import { RateLimitService } from '../platform/rate-limit.service'
import { insertRow, seedTenant } from './db-fixtures'
import { assertNoPiiLeak } from './pii-response-guard'
import { startTestDatabase, type TestDatabase } from './test-database'

// 接口集成测试框架（P1-29，11.4 第 1 条）：真实 PostgreSQL（已执行全部迁移）+ 完整应用 + 真实 HTTP 请求。
// 与 harness.ts（内存替身，用来检查单个接口的参数与权限分支）互补：这里验证接口、查询、分区表与租户隔离合在一起的真实行为。
// 只替换外部依赖：队列与限流依赖 Redis，在这里用替身；数据库、会话、权限、查询全部是真实的。

/** 成员的数据范围授权：不传默认“全部范围”；传空数组表示没有任何授权。 */
export interface MemberOptions {
  scopes?: { legalEntityId?: string; sellerAccountId?: string }[]
  /** 直接使用已有角色（例如预设角色 preset-finance），此时忽略 permissions 参数。 */
  roleId?: string
}

export interface DbTestApp {
  app: INestApplication
  /** 应用监听的根地址（例如 http://127.0.0.1:端口），用于构造来源头与直接发起底层请求。 */
  baseUrl: string
  db: TestDatabase
  /** 管理员连接，直接读写数据库用于造数与核对结果。 */
  client: Client
  rateLimit: { buckets: ReturnType<typeof vi.fn>; tenantSlots: ReturnType<typeof vi.fn> }
  queue: { add: ReturnType<typeof vi.fn>; addRaw: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn>; counts: ReturnType<typeof vi.fn> }
  /** 建立一个租户，并返回其基础数据（租户、主体、店铺）。 */
  createTenant(suffix: string, options?: { mode?: 'LIVE' | 'TEST' }): Promise<Awaited<ReturnType<typeof seedTenant>>>
  /** 在租户里建立一个成员：指定权限点，返回其访问令牌。 */
  createMember(tenantId: string, suffix: string, permissions: string[], options?: MemberOptions): Promise<{ userId: string; token: string; membershipId: string }>
  call(
    token: string | null,
    method: string,
    path: string,
    init?: { body?: unknown; headers?: Record<string, string>; idempotencyKey?: string | false },
  ): Promise<{ status: number; json: any; headers: Headers }>
  close(): Promise<void>
}

export async function createDbTestApp(options: { database?: string; db?: TestDatabase } = {}): Promise<DbTestApp> {
  const database = options.database ?? 'integration'
  const db = options.db ?? (await startTestDatabase())
  await db.createDatabase(database)
  db.migrate(database)
  const client = await db.connect(database)
  // 与生产一致：接口服务用受行级安全约束的普通账号；系统流程（登录、授权回调、商务）用系统账号。造数与核对用管理员连接 client。
  process.env.DATABASE_URL = db.urlFor(database, 'app')
  process.env.DATABASE_SYSTEM_URL = db.urlFor(database, 'system')

  const queue = {
    add: vi.fn().mockResolvedValue({ id: 'queued' }),
    addRaw: vi.fn().mockResolvedValue({ id: 'queued' }),
    ping: vi.fn().mockResolvedValue('PONG'),
    counts: vi.fn().mockResolvedValue({}),
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
    .overrideProvider(QueueService)
    .useValue(queue)
    .overrideProvider(RateLimitService)
    .useValue(rateLimit)
    .compile()
  const app = moduleRef.createNestApplication()
  configureApp(app)
  await app.listen(0, '127.0.0.1')
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1')
  const jwt = moduleRef.get(JwtService)

  return {
    app,
    baseUrl: base,
    db,
    client,
    queue,
    rateLimit,
    async createTenant(suffix, tenantOptions = {}) {
      const seeded = await seedTenant(client, suffix)
      if (tenantOptions.mode) await client.query('UPDATE "Tenant" SET "mode" = $1 WHERE "id" = $2', [tenantOptions.mode, seeded.tenantId])
      return seeded
    },
    async createMember(tenantId, suffix, permissions, memberOptions = {}) {
      const user = await insertRow(client, 'User', { id: `member-${suffix}`, email: `member-${suffix}@example.com` })
      const role = memberOptions.roleId
        ? { id: memberOptions.roleId }
        : await insertRow(client, 'Role', { id: `role-${suffix}`, tenantId, name: `角色${suffix}`, permissions: JSON.stringify(permissions), resourceScope: '{}', version: 1 })
      const membership = await insertRow(client, 'Membership', { id: `membership-${suffix}`, tenantId, userId: user.id, roleId: role.id })
      const grants = memberOptions.scopes ?? [{}]
      for (const [index, grant] of grants.entries()) {
        await insertRow(client, 'MembershipScope', {
          id: `scope-${suffix}-${index}`,
          tenantId,
          membershipId: membership.id,
          legalEntityId: grant.legalEntityId ?? null,
          sellerAccountId: grant.sellerAccountId ?? null,
          grantedBy: 'test',
        })
      }
      const session = await insertRow(client, 'Session', { id: `session-${suffix}`, rotationChainId: `session-${suffix}`, userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) })
      return { userId: user.id as string, token: await jwt.signAsync({ userId: user.id, sessionId: session.id }), membershipId: membership.id as string }
    },
    async call(token, method, path, init = {}) {
      const writes = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          // 写请求默认带随机幂等键（与前端请求层一致）；传 idempotencyKey: false 模拟不带键
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
    },
    async close() {
      await app.close()
      await client.end()
      if (!options.db) await db.stop()
    },
  }
}
