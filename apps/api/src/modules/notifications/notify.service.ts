import { Injectable } from '@nestjs/common'
import { deliveryVerdicts, notificationDomainOf } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { permissionsOfRole, roleInclude } from '../auth'

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface NotifyInput {
  kind: string
  title: string
  body: string
  /** 点击后前往的站内路径 */
  link?: string
  severity?: NotificationSeverity
  /** 同一用户同一去重键只保留一条（重复触发不会刷屏） */
  dedupKey?: string
  /** 业务域（库存、财务、广告等）；不给则按通知类型推断，用于个人通知偏好与筛选 */
  domain?: string
}

/** 事务客户端或普通客户端都可以：写通知与找收件人用到通知与成员两张表；读个人偏好用到偏好与企业表（缺少时按默认全部送达）。 */
export type NotifyClient = Pick<Prisma.TransactionClient, 'notification' | 'membership'> & Partial<Pick<Prisma.TransactionClient, 'userPreference' | 'tenant'>>

// 站内通知写入（P1-28）：待办指派、评论 @、预警、开关变更、导出完成等都经由这里写入消息中心。
// 接口只接受用户编号或“拥有某权限的成员”，调用方不直接拼通知行，保证标题、链接、去重规则一致。
// P5-11：写入前按每个收件人的通知偏好判断——关掉的“业务域 × 级别”不写入；免打扰时段内的普通通知写入但标记为免打扰（不计未读，时段结束后并入汇总）。
@Injectable()
export class NotifyService {
  constructor(private readonly prisma: PrismaService) {}

  private row(tenantId: string, userId: string, input: NotifyInput, silencedAt: Date | null): Prisma.NotificationCreateManyInput {
    return {
      tenantId,
      userId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 1000),
      link: input.link ?? null,
      severity: input.severity ?? 'INFO',
      dedupKey: input.dedupKey ?? null,
      domain: notificationDomainOf(input.kind, input.domain),
      silencedAt,
    }
  }

  /** 每个收件人的送达判断；没有个人偏好表可读时全部送达。 */
  private async verdicts(tenantId: string, userIds: readonly string[], input: NotifyInput, now: Date, client: NotifyClient) {
    const rows = client.userPreference ? await client.userPreference.findMany({ where: { tenantId, userId: { in: [...userIds] } }, select: { userId: true, notifyJson: true } }) : []
    const needsZone = rows.length > 0
    const zone = needsZone && client.tenant ? ((await client.tenant.findFirst({ where: { id: tenantId }, select: { localTimezone: true } }))?.localTimezone ?? null) : null
    return deliveryVerdicts(userIds, rows, { kind: input.kind, domain: input.domain, severity: input.severity ?? 'INFO' }, now, zone)
  }

  /** 发给指定的成员（用户编号去重）；返回实际写入条数（去重键冲突与按偏好不接收的不计）。 */
  async toUsers(tenantId: string, userIds: readonly string[], input: NotifyInput, client: NotifyClient = this.prisma): Promise<number> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) return 0
    const now = new Date()
    const verdicts = await this.verdicts(tenantId, unique, input, now, client)
    const data = unique.flatMap(userId => {
      const verdict = verdicts.get(userId) ?? 'DELIVER'
      return verdict === 'SKIP' ? [] : [this.row(tenantId, userId, input, verdict === 'SILENCE' ? now : null)]
    })
    if (data.length === 0) return 0
    const result = await client.notification.createMany({ data, skipDuplicates: true })
    return result.count
  }

  /** 拥有某权限的在职成员（所有者的通配权限视为拥有）。 */
  async holdersOf(tenantId: string, permission: string, client: NotifyClient = this.prisma): Promise<string[]> {
    const memberships = await client.membership.findMany({ where: { tenantId, status: 'ACTIVE' }, include: roleInclude })
    return memberships.filter(item => hasPermission(permissionsOfRole(item.role), permission)).map(item => item.userId)
  }

  /** 发给拥有某权限的全部成员，可排除触发者本人（本人已知情）。 */
  async toHolders(tenantId: string, permission: string, input: NotifyInput, options: { excludeUserId?: string; client?: NotifyClient } = {}): Promise<number> {
    const client = options.client ?? this.prisma
    const holders = (await this.holdersOf(tenantId, permission, client)).filter(id => id !== options.excludeUserId)
    return this.toUsers(tenantId, holders, input, client)
  }
}
