import { Injectable } from '@nestjs/common'
import { ALERTS_READ, NotificationListQuerySchema, NotificationReadBodySchema, type UnreadCountResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { unreadAlertWhere } from '../../platform/alert-unread'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'

const SORT = { field: 'createdAt', dir: 'desc' } as const

// 消息中心（P1-28-5）：每个成员只能看到、标记自己的通知；通知里不放买家个人信息与令牌。
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = NotificationListQuerySchema.parse(rawQuery)
    const mine: Prisma.NotificationWhereInput = {
      tenantId: context.tenantId,
      userId: context.userId,
      ...(query.kind ? { kind: query.kind } : {}),
      // 未读只算正常提醒的通知：免打扰期间收到的（silencedAt 不为空）由汇总通知代为提醒，不计未读
      ...(query.unread ? (query.unread === 'true' ? { readAt: null, silencedAt: null } : { readAt: { not: null } }) : {}),
      ...(query.silenced ? { silencedAt: query.silenced === 'true' ? { not: null } : null } : {}),
      ...(query.domain ? { domain: query.domain === 'OTHER' ? null : query.domain } : {}),
    }
    const binding = bindingOf(context.tenantId, { userId: context.userId, kind: query.kind, unread: query.unread, domain: query.domain, silenced: query.silenced })
    const rows = await this.prisma.notification.findMany({
      where: { AND: [mine, this.cursor.after(query.cursor, SORT, binding) as Prisma.NotificationWhereInput] },
      orderBy: this.cursor.orderBy(SORT),
      take: query.limit + 1,
    })
    const page = this.cursor.page(rows, { pageSize: query.limit, sort: SORT, binding })
    const unread = await this.prisma.notification.count({ where: { tenantId: context.tenantId, userId: context.userId, readAt: null, silencedAt: null } })
    return {
      items: page.items.map(row => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        severity: row.severity,
        domain: row.domain,
        silenced: Boolean(row.silencedAt),
        read: row.readAt !== null,
        createdAt: row.createdAt,
      })),
      pageInfo: page.pageInfo,
      unreadCount: unread,
    }
  }

  /**
   * 未读数量（顶栏消息与预警入口，P6-01）。messages 是站内消息未读数（不含免打扰期间收到的），unreadCount 与它同值（旧字段，前端已改用 messages）；
   * alerts 是预警未读数（P6-15）：我没读过的待处理预警（AlertRead 按人记录，口径见 platform/alert-unread.ts），受数据范围限制，与预警中心列表的 unreadCount 同值；
   * 没有“查看预警”权限的人为 null（浮层本来就不显示预警页签）；有权限但数据范围里没有任何店铺时为 0（什么都看不到）。
   */
  async unreadCount(req: RequestWithContext): Promise<UnreadCountResponse> {
    const context = await this.context.resolve(req)
    const messages = await this.prisma.notification.count({ where: { tenantId: context.tenantId, userId: context.userId, readAt: null, silencedAt: null } })
    return { unreadCount: messages, messages, alerts: await this.alertUnread(req, context.userId) }
  }

  private async alertUnread(req: RequestWithContext, userId: string): Promise<number | null> {
    let resolved: Awaited<ReturnType<ContextService['authorizeScoped']>>
    try {
      resolved = await this.context.authorizeScoped(req, ALERTS_READ, {})
    } catch (error) {
      if (!(error instanceof AppError) || error.getStatus() !== 403) throw error
      // 没有权限与没有任何店铺范围都是 403：前者没有预警入口，后者什么都看不到
      return hasPermission((await this.context.resolve(req)).permissions, ALERTS_READ) ? 0 : null
    }
    const { context, scope } = resolved
    return this.prisma.alertInstance.count({ where: { tenantId: context.tenantId, ...storeWhere(scope), ...unreadAlertWhere(userId) } })
  }

  async markRead(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.resolve(req)
    const body = NotificationReadBodySchema.parse(rawBody)
    const result = await this.prisma.notification.updateMany({
      where: { tenantId: context.tenantId, userId: context.userId, readAt: null, ...(body.ids ? { id: { in: body.ids } } : {}) },
      data: { readAt: new Date() },
    })
    return { updated: result.count }
  }
}
