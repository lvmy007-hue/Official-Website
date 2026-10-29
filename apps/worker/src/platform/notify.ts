import { deliveryVerdicts, notificationDomainOf } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma, PrismaClient } from '@prisma/client'
import { permissionsOfRole } from '../exports/actor'

// 后台任务写站内通知（P1-28）：规则与接口侧 NotifyService 一致——同一用户同一去重键只保留一条、标题与正文限长、
// “拥有某权限的在职成员”按角色点位计算（所有者的通配权限视为拥有）。
// P5-11：写入前按每个收件人的通知偏好判断（判断规则在 api-contracts 的 profile.ts，与接口侧共用）——
// 关掉的“业务域 × 级别”不写入；免打扰时段内的普通通知写入但标记为免打扰（不计未读，时段结束后并入汇总）。

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface NotifyInput {
  kind: string
  title: string
  body: string
  link?: string
  severity?: NotificationSeverity
  dedupKey?: string
  /** 业务域；不给则按通知类型推断（预警规则的通知要带上规则的业务域）。 */
  domain?: string
}

/** 写通知只需要通知表；读个人偏好需要偏好表与企业表（缺少时按默认全部送达，只有测试替身会缺）。 */
export type NotifyWriteDb = Pick<PrismaClient, 'notification'> & Partial<Pick<PrismaClient, 'userPreference' | 'tenant'>>
export type NotifyDb = Pick<PrismaClient, 'notification' | 'membership'> & Partial<Pick<PrismaClient, 'userPreference' | 'tenant'>>

/** 拥有某权限的在职成员。 */
export async function holdersOf(db: Pick<PrismaClient, 'membership'>, tenantId: string, permission: string): Promise<string[]> {
  const memberships = await db.membership.findMany({ where: { tenantId, status: 'ACTIVE' }, include: { role: { include: { fieldPermissions: { select: { fieldKey: true, allowed: true } } } } } })
  return memberships.filter(item => hasPermission(permissionsOfRole(item.role), permission)).map(item => item.userId)
}

/** 按个人偏好生成要写入的通知行（不写库）：不接收的人没有行，免打扰时段内的普通通知带 silencedAt。 */
export async function notificationRows(
  db: Partial<Pick<PrismaClient, 'userPreference' | 'tenant'>>,
  tenantId: string,
  userIds: readonly string[],
  input: NotifyInput,
  now: Date = new Date(),
): Promise<Prisma.NotificationCreateManyInput[]> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return []
  const prefs = db.userPreference ? await db.userPreference.findMany({ where: { tenantId, userId: { in: unique } }, select: { userId: true, notifyJson: true } }) : []
  const zone = prefs.length > 0 && db.tenant ? ((await db.tenant.findFirst({ where: { id: tenantId }, select: { localTimezone: true } }))?.localTimezone ?? null) : null
  const verdicts = deliveryVerdicts(unique, prefs, { kind: input.kind, domain: input.domain, severity: input.severity ?? 'INFO' }, now, zone)
  return unique.flatMap(userId => {
    const verdict = verdicts.get(userId) ?? 'DELIVER'
    if (verdict === 'SKIP') return []
    return [
      {
        tenantId,
        userId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 1000),
        link: input.link ?? null,
        severity: input.severity ?? 'INFO',
        dedupKey: input.dedupKey ?? null,
        domain: notificationDomainOf(input.kind, input.domain),
        silencedAt: verdict === 'SILENCE' ? now : null,
      },
    ]
  })
}

/** 发给指定成员（用户编号去重）；返回实际写入条数（去重键冲突的与按偏好不接收的不计）。 */
export async function notifyUsers(db: NotifyWriteDb, tenantId: string, userIds: readonly string[], input: NotifyInput): Promise<number> {
  const data = await notificationRows(db, tenantId, userIds, input)
  if (data.length === 0) return 0
  const result = await db.notification.createMany({ data, skipDuplicates: true })
  return result.count
}

/** 发给拥有某权限的全部成员，可排除指定用户（本人已知情）。 */
export async function notifyHolders(db: NotifyDb, tenantId: string, permission: string, input: NotifyInput, excludeUserIds: readonly string[] = []): Promise<number> {
  const skip = new Set(excludeUserIds)
  const holders = (await holdersOf(db, tenantId, permission)).filter(id => !skip.has(id))
  return notifyUsers(db, tenantId, holders, input)
}
