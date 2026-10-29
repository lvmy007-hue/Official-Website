import { Injectable } from '@nestjs/common'
import type { FieldPermission, Role } from '@prisma/client'
import { SystemPrismaService } from '../../platform/prisma.service'

export type RoleWithFields = Role & { fieldPermissions: Pick<FieldPermission, 'fieldKey' | 'allowed' | 'ownerOnly'>[] }

const fieldSelect = { fieldPermissions: { select: { fieldKey: true, allowed: true, ownerOnly: true } } } as const

/**
 * 成员与角色用到的两类平台级数据（用系统连接读取，每个查询都显式带企业条件）：
 *   一、角色：预设角色没有企业编号（tenantId 为空），租户连接的自动补条件会把它们挡在外面，所以列角色走这里；
 *   二、登录会话：会话属于用户、不属于任何企业，租户账号对该表没有权限。
 * 其余成员数据（成员、范围、审计）都走租户连接，受行级安全约束。
 */
@Injectable()
export class MemberSystemService {
  constructor(private readonly system: SystemPrismaService) {}

  /** 本企业能用的全部角色：预设角色加本企业的自定义角色。 */
  async roles(tenantId: string): Promise<RoleWithFields[]> {
    return this.system.role.findMany({
      where: { OR: [{ tenantId: null, system: true }, { tenantId }] },
      include: fieldSelect,
      orderBy: [{ system: 'desc' }, { createdAt: 'asc' }, { name: 'asc' }],
      take: 500,
    })
  }

  async role(tenantId: string, id: string): Promise<RoleWithFields | null> {
    return this.system.role.findFirst({ where: { id, OR: [{ tenantId: null, system: true }, { tenantId }] }, include: fieldSelect })
  }

  /** 这个邮箱在整个平台上是否已有账号（账号邮箱全局唯一；接受邀请时会因此失败，所以邀请前就拦下）。 */
  async emailRegistered(email: string): Promise<boolean> {
    return (await this.system.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })) > 0
  }

  /** 每个用户最近一次登录（刷新会换会话行，所以只看轮换链的起点）。 */
  async lastLogins(userIds: readonly string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map()
    const groups = await this.system.session.groupBy({ by: ['userId'], where: { userId: { in: [...userIds] }, rotatedFromId: null }, _max: { createdAt: true }, orderBy: { userId: 'asc' } })
    return new Map(groups.flatMap(group => (group._max.createdAt ? [[group.userId, group._max.createdAt] as const] : [])))
  }

  /** 一个用户最近的会话行（按轮换链合并在上层做）；只取展示用的列，不取令牌哈希与原始地址。 */
  async sessionRows(userId: string, take: number) {
    return this.system.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, rotationChainId: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, ipMasked: true, userAgent: true },
    })
  }

  /** 停用成员后吊销其登录：用户在别的企业仍有使用中的成员关系时不动（会话属于用户，不属于企业）。返回吊销的会话行数。 */
  async revokeSessionsUnlessElsewhere(userId: string, tenantId: string, now: Date): Promise<number> {
    const elsewhere = await this.system.membership.count({ where: { userId, status: 'ACTIVE', tenantId: { not: tenantId } } })
    if (elsewhere > 0) return 0
    const result = await this.system.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } })
    return result.count
  }
}
