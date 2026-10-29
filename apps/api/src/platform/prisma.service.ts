import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, connectionUrlWithPool, createTenantScopedClient, statementTimeoutFromEnv } from '@nova/tenancy'
import { recordSlowQuery } from './observability/metrics'

// 慢查询阈值（毫秒）。超过即告警，默认 1 秒（12 章 12.4）。可用环境变量 SLOW_QUERY_MS 调整。
export const DEFAULT_SLOW_QUERY_MS = 1000

/** 单次查询返回行数的上限（接口服务）。可用环境变量 QUERY_MAX_ROWS 调整，默认 20000。 */
export const DEFAULT_QUERY_MAX_ROWS = 20_000

/** 接口服务单条语句的超时（毫秒）：超时由数据库取消并返回“查询过慢”。可用 QUERY_STATEMENT_TIMEOUT_MS 调整，默认 30 秒（P1-25）。 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
export function queryMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.QUERY_MAX_ROWS)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_QUERY_MAX_ROWS
}

export type SlowQueryRecord = { durationMs: number; thresholdMs: number; target: string; statement: string }

const MAX_STATEMENT_LENGTH = 500

export function slowQueryThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SLOW_QUERY_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SLOW_QUERY_MS
}

/**
 * 把查询事件转成告警记录；未超阈值返回 null。
 * 只记录带占位符的语句文本，绝不记录参数（参数里可能有个人信息）。
 */
export function toSlowQueryRecord(event: { query: string; duration: number; target: string }, thresholdMs: number): SlowQueryRecord | null {
  if (event.duration < thresholdMs) return null
  const statement = event.query.replace(/\s+/g, ' ').trim()
  return {
    durationMs: event.duration,
    thresholdMs,
    target: event.target,
    statement: statement.length > MAX_STATEMENT_LENGTH ? `${statement.slice(0, MAX_STATEMENT_LENGTH)}…` : statement,
  }
}

function watchSlowQueries(client: PrismaClient<Prisma.PrismaClientOptions, 'query'>) {
  const slowLogger = new Logger('SlowQuery')
  const thresholdMs = slowQueryThreshold()
  client.$on('query', event => {
    const record = toSlowQueryRecord(event, thresholdMs)
    if (record) {
      recordSlowQuery()
      slowLogger.warn({ event: 'slow_query', ...record })
    }
  })
}

// 租户连接（12.8）：接口服务与后台任务的默认数据库访问。
// 返回的是套了租户隔离的客户端——自动补租户条件、每次访问先设置行级安全变量；没有租户上下文时访问租户表直接报错。
// 底层用 DATABASE_URL（普通账号 nova_app，行级安全对它生效）。
@Injectable()
export class PrismaService extends PrismaClient<Prisma.PrismaClientOptions, 'query'> implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = connectionUrlWithPool(process.env.DATABASE_URL)
    super({ log: [{ emit: 'event', level: 'query' }], ...(url ? { datasources: { db: { url } } } : {}) })
    watchSlowQueries(this)
    // 查询必须有边界（12.5）：一次返回超过上限行数的查询直接报错，必须改成分页或聚合
    return createTenantScopedClient(this, {
      catalog: catalogFromDatamodel(Prisma.dmmf.datamodel),
      maxRows: queryMaxRows(),
      statementTimeoutMs: statementTimeoutFromEnv('QUERY_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
    })
  }

  async onModuleInit() {
    await this.$connect()
    if (isProductionMode()) await assertLeastPrivilegedConnection(this, 'DATABASE_URL')
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}

// 系统连接：只用于没有租户上下文的平台级流程——登录与会话、跨租户的成员查询、授权回调的状态查找、官网表单与商务订单、平台运营。
// 底层用 DATABASE_SYSTEM_URL（nova_system，可绕过行级安全）；没配置时与租户连接共用 DATABASE_URL（仅限开发与测试）。
// 业务领域模块不得使用它，由 scripts/check-tenant-isolation.mjs 在持续集成中把关。
@Injectable()
export class SystemPrismaService extends PrismaClient<Prisma.PrismaClientOptions, 'query'> implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = connectionUrlWithPool(process.env.DATABASE_SYSTEM_URL)
    super({ log: [{ emit: 'event', level: 'query' }], ...(url ? { datasources: { db: { url } } } : {}) })
    watchSlowQueries(this)
  }

  async onModuleInit() {
    if (isProductionMode()) {
      if (!process.env.DATABASE_SYSTEM_URL) throw new Error('生产环境必须配置 DATABASE_SYSTEM_URL（系统连接账号），不得与租户连接共用同一账号')
      await this.$connect()
    }
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}

const isProductionMode = () => process.env.APP_MODE === 'production' || (process.env.APP_MODE === undefined && process.env.NODE_ENV === 'production')

/**
 * 生产启动检查：租户连接账号必须是普通账号——不是超级用户、不绕过行级安全、不是业务表的所有者，
 * 否则行级安全这道防线形同虚设，拒绝启动。
 */
export async function assertLeastPrivilegedConnection(client: { $queryRawUnsafe<T = unknown>(sql: string): Promise<T> }, variable: string): Promise<void> {
  const rows = await client.$queryRawUnsafe<Array<{ role: string; superuser: boolean; bypassrls: boolean; owned: number }>>(
    `SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
            (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owned
     FROM pg_roles r WHERE r.rolname = current_user`,
  )
  const row = rows[0]
  if (!row) throw new Error(`${variable}：无法确认当前数据库账号的权限`)
  if (row.superuser || row.bypassrls || row.owned > 0) {
    throw new Error(`${variable} 使用的数据库账号 ${row.role} 权限过大（超级用户、可绕过行级安全或是业务表所有者），请改用最小权限账号 nova_app，见 database/ops/roles.sql`)
  }
}
