import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, connectionUrlWithPool, createTenantScopedClient, statementTimeoutFromEnv } from '@nova/tenancy'

// 后台任务的数据库访问（P1-16，12.8）。
// - 租户连接（DATABASE_URL，普通账号，行级安全生效）：任务在 runWithTenant(租户编号) 内执行，所有读写自动带租户条件并设置行级安全变量。
// - 系统连接（DATABASE_SYSTEM_URL，可绕过行级安全）：只用于没有租户上下文的平台级流程——启动调度时跨租户扫描连接、
//   按任务编号反查任务归属租户、分区维护、买家信息到期清理。
// 没配置 DATABASE_SYSTEM_URL 时系统连接与租户连接共用 DATABASE_URL（仅限开发与测试；生产启动检查会拒绝）。

export interface TenantDatabases {
  /** 套了租户隔离的客户端：没有租户上下文访问租户表会直接报错。 */
  prisma: PrismaClient
  /** 系统连接：绕过行级安全，业务导入代码不得使用。 */
  systemPrisma: PrismaClient
  /** 用于挂载慢查询事件的原始客户端。 */
  tenantBase: PrismaClient<Prisma.PrismaClientOptions, 'query'>
}

export function createTenantDatabases(env: NodeJS.ProcessEnv = process.env): TenantDatabases {
  const tenantUrl = connectionUrlWithPool(env.DATABASE_URL, env)
  const tenantBase = new PrismaClient({ log: [{ emit: 'event', level: 'query' }], ...(tenantUrl ? { datasourceUrl: tenantUrl } : {}) })
  const systemUrl = connectionUrlWithPool(env.DATABASE_SYSTEM_URL, env)
  const systemPrisma = new PrismaClient({ ...(systemUrl ? { datasourceUrl: systemUrl } : {}) })
  // 后台任务的语句超时比接口宽松（批量导入、汇总刷新），默认 120 秒，可用 WORKER_STATEMENT_TIMEOUT_MS 调整
  const prisma = createTenantScopedClient(tenantBase, {
    catalog: catalogFromDatamodel(Prisma.dmmf.datamodel),
    statementTimeoutMs: statementTimeoutFromEnv('WORKER_STATEMENT_TIMEOUT_MS', 120_000, env),
  })
  return { prisma, systemPrisma, tenantBase }
}

/** 队列任务的租户归属校验结果。 */
export type JobOwnership = { ok: true; tenantId: string; legacy: boolean } | { ok: false; reason: 'JOB_NOT_FOUND' | 'JOB_TENANT_MISMATCH' }

/**
 * 任务载荷里的租户编号必须与任务记录实际归属的租户一致。
 * 旧消息（升级前入队）没有 tenantId，按任务记录归属处理并标记 legacy，便于日志里看出还有多少旧消息。
 */
export function resolveJobOwnership(claimedTenantId: string | undefined, recordTenantId: string | null | undefined): JobOwnership {
  if (!recordTenantId) return { ok: false, reason: 'JOB_NOT_FOUND' }
  if (claimedTenantId === undefined) return { ok: true, tenantId: recordTenantId, legacy: true }
  if (claimedTenantId !== recordTenantId) return { ok: false, reason: 'JOB_TENANT_MISMATCH' }
  return { ok: true, tenantId: recordTenantId, legacy: false }
}
