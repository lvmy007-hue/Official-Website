import type { PrismaService } from './prisma.service'

/** 已离开（停用或移除）成员在界面上显示的名字 */
export const FORMER_MEMBER_LABEL = '已离开的成员'

/** 企业成员的显示名（昵称，没有则用邮箱）。只返回当前企业的成员；查不到的用户编号不在结果里。 */
export async function memberNames(prisma: PrismaService, tenantId: string, userIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { displayName: true, email: true } } }, take: 500 })
  return new Map(rows.map(row => [row.userId, row.user.displayName || row.user.email]))
}

export const nameOrFormer = (names: ReadonlyMap<string, string>, userId: string | null | undefined, whenNone = '系统') => (userId ? (names.get(userId) ?? FORMER_MEMBER_LABEL) : whenNone)
