import { Prisma } from '@prisma/client'
import { sourceByCode } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'

// 仪表盘共用：可见性、重名、唯一约束冲突（P6-33）。

export const visibleDashboard = (tenantId: string, userId: string, id?: string) => ({
  ...(id ? { id } : {}),
  tenantId,
  OR: [{ ownerId: userId }, { shared: true }],
})

/** 组件对外展示：查看人没有该数据源权限时，不把别人配置的指标与口径暴露给他。 */
export function widgetViewFor(row: { id: string; type: string; query: unknown; options: unknown; version: number }, permissions: readonly string[]) {
  const code = row.query && typeof row.query === 'object' ? (row.query as { source?: unknown }).source : undefined
  const source = typeof code === 'string' ? sourceByCode(code) : undefined
  const allowed = row.type === 'TEXT' || (source !== undefined && hasPermission(permissions, source.permission))
  return { id: row.id, type: row.type, query: allowed ? row.query : {}, options: allowed ? row.options : {}, version: row.version }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function assertUniqueName(
  prisma: PrismaService,
  table: 'dashboard' | 'dashboardFolder',
  where: { tenantId: string; ownerId: string; name: string; parentId?: string | null; folderId?: string | null; selfId?: string },
  label: string,
) {
  const exclude = where.selfId ? { NOT: { id: where.selfId } } : {}
  const current =
    table === 'dashboardFolder'
      ? await prisma.dashboardFolder.findFirst({
          where: { tenantId: where.tenantId, ownerId: where.ownerId, name: where.name, parentId: where.parentId ?? null, ...exclude },
        })
      : await prisma.dashboard.findFirst({
          where: { tenantId: where.tenantId, ownerId: where.ownerId, name: where.name, folderId: where.folderId ?? null, ...exclude },
        })
  if (current) throw appError('CONFLICT', `同一位置已经有同名${label}`)
}
