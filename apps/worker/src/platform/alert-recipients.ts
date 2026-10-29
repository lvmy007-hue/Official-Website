import type { PrismaClient } from '@prisma/client'
import { holdersOf } from './notify'

// 预警的收件人（从评估框架里抽出来，评估、汇总、升级三处共用）：
// - 待办负责人：规则范围里指定的成员（须仍在职），否则取有“预警管理”权限的第一位成员（所有者与管理员）；
// - 站内通知接收人：待办负责人，加上规则配置的通知对象（须仍在职）。

type Db = Pick<PrismaClient, 'membership'>

export async function chooseOwner(db: Db, tenantId: string, scope: Record<string, unknown>): Promise<string | null> {
  const holders = await holdersOf(db, tenantId, 'alerts.manage')
  const wanted = typeof scope.ownerId === 'string' ? scope.ownerId : null
  if (wanted) {
    const active = await db.membership.findFirst({ where: { tenantId, userId: wanted, status: 'ACTIVE' }, select: { userId: true } })
    if (active) return active.userId
  }
  return holders[0] ?? null
}

/** 规则里配置的通知对象（仍在职的），不含待办负责人。 */
export async function notifyTargetsOf(db: Db, tenantId: string, scope: Record<string, unknown>): Promise<string[]> {
  const wanted = Array.isArray(scope.notifyUserIds) ? scope.notifyUserIds.filter((item): item is string => typeof item === 'string') : []
  if (wanted.length === 0) return []
  const active = await db.membership.findMany({ where: { tenantId, status: 'ACTIVE', userId: { in: wanted } }, select: { userId: true }, take: 100 })
  return [...new Set(active.map(row => row.userId))]
}

/** 站内通知的接收人：待办负责人，加上规则配置的通知对象。 */
export async function recipientsOf(db: Db, tenantId: string, scope: Record<string, unknown>, ownerId: string): Promise<string[]> {
  const targets = await notifyTargetsOf(db, tenantId, scope)
  return targets.length === 0 ? [ownerId] : [...new Set([ownerId, ...targets])]
}
