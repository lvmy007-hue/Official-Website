import { Injectable } from '@nestjs/common'
import { SUBSCRIPTION_MANAGE, SUBSCRIPTION_REPLAY_MAX, SubscriptionCreateBodySchema, SubscriptionReplayBodySchema, SubscriptionUpdateBodySchema, notificationTypeOf } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { AuditWriter, expectedVersionFrom, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { destinationIdFrom } from './destination'

const NO_DESTINATION = '推送接收端尚未配置（部署专项完成后才能订阅），当前不会创建任何订阅'
const filterNotSupported = () => appError('VALIDATION_FAILED', '该通知类型不支持过滤条件', { fieldErrors: { filter: ['该通知类型不支持过滤条件'] } })

// 亚马逊通知订阅管理（P1-28-11，P5-05 补数据范围与店铺授权校验）。接口只登记意图并交给后台任务调用亚马逊（令牌只在后台任务里使用）。
// 接收端属于部署专项：未配置时列表如实显示“接收端未接入”，创建与改过滤条件返回 503，不创建任何记录。
// 订阅属于具体店铺：写入前先确认店铺在成员的数据范围内（范围外一律 404）；需要卖家授权的类型还要求该店铺有有效授权。
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly queue: QueueService,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown) {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIPTION_MANAGE, {})
    const body = SubscriptionCreateBodySchema.parse(rawBody)
    const spec = notificationTypeOf(body.notificationType)
    if (!spec) throw appError('VALIDATION_FAILED', '不支持的通知类型', { fieldErrors: { notificationType: ['不支持的通知类型'] } })
    if (body.filter && !spec.filterable) throw filterNotSupported()
    const destination = destinationIdFrom(process.env)
    if (!destination) throw appError('DEPENDENCY_UNAVAILABLE', NO_DESTINATION)
    const store = await this.prisma.sellerAccount.findFirst({ where: { AND: [{ id: body.sellerAccountId }, storeWhere(scope, 'id')], tenantId: context.tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    if (!spec.grantless) {
      const connection = await this.prisma.platformConnection.findFirst({
        where: { tenantId: context.tenantId, sellerAccountId: store.id, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } },
        select: { id: true },
      })
      if (!connection) throw appError('FBA_CONNECTION_REQUIRED', '这个店铺没有有效的卖家接口授权，请先到连接中心授权')
    }
    const created = await this.prisma.$transaction(async tx => {
      const exists = await tx.notificationSubscription.findFirst({ where: { sellerAccountId: store.id, destinationId: destination, notificationType: body.notificationType }, select: { id: true } })
      if (exists) throw appError('CONFLICT', '该店铺已经订阅了这个通知类型')
      const row = await tx.notificationSubscription.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: store.id,
          destinationId: destination,
          notificationType: body.notificationType,
          subscriptionId: '',
          filterJson: (body.filter ?? undefined) as Prisma.InputJsonValue | undefined,
          status: 'NOT_CREATED',
        },
      })
      await this.audit.record(
        req,
        {
          action: 'NOTIFICATION_SUBSCRIPTION_REQUESTED',
          resourceType: 'NotificationSubscription',
          resourceId: row.id,
          after: { notificationType: row.notificationType, sellerAccountId: store.id, filter: body.filter ?? null },
        },
        { client: tx },
      )
      return row
    })
    await this.queue.add('notifications', { tenantId: context.tenantId, kind: 'subscription-create', subscriptionRowId: created.id }, `subscription-create:${created.id}`)
    return { id: created.id, status: created.status }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown) {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIPTION_MANAGE, {})
    const body = SubscriptionUpdateBodySchema.parse({ version: expectedVersionFrom(rawBody), filter: (rawBody as { filter?: unknown } | null)?.filter })
    const row = await this.prisma.notificationSubscription.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '订阅不存在')
    if (!notificationTypeOf(row.notificationType)?.filterable) throw filterNotSupported()
    if (!destinationIdFrom(process.env)) throw appError('DEPENDENCY_UNAVAILABLE', NO_DESTINATION)
    const next = await this.prisma.$transaction(async tx => {
      const saved = await updateWithVersion(
        tx.notificationSubscription,
        { id, tenantId: context.tenantId },
        body.version,
        { filterJson: body.filter as Prisma.InputJsonValue, status: 'NOT_CREATED' },
        { label: '订阅' },
      )
      await this.audit.record(
        req,
        { action: 'NOTIFICATION_SUBSCRIPTION_UPDATED', resourceType: 'NotificationSubscription', resourceId: id, before: { filter: row.filterJson }, after: { filter: body.filter } },
        { client: tx },
      )
      return saved
    })
    await this.queue.add('notifications', { tenantId: context.tenantId, kind: 'subscription-create', subscriptionRowId: id }, `subscription-update:${id}:${next.version}`)
    return { id, status: next.status, version: next.version }
  }

  async remove(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIPTION_MANAGE, {})
    const row = await this.prisma.notificationSubscription.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '订阅不存在')
    // 从未在亚马逊创建成功的订阅（没有订阅编号）直接删除；已创建的交给后台任务先取消再删除
    if (!row.subscriptionId) {
      await this.prisma.$transaction(async tx => {
        await tx.notificationSubscription.delete({ where: { id } })
        await this.audit.record(
          req,
          { action: 'NOTIFICATION_SUBSCRIPTION_DELETED', resourceType: 'NotificationSubscription', resourceId: id, before: { notificationType: row.notificationType } },
          { client: tx },
        )
      })
      return { id, removed: true }
    }
    await this.audit.record(req, { action: 'NOTIFICATION_SUBSCRIPTION_DELETED', resourceType: 'NotificationSubscription', resourceId: id, before: { notificationType: row.notificationType } })
    await this.queue.add('notifications', { tenantId: context.tenantId, kind: 'subscription-delete', subscriptionRowId: id }, `subscription-delete:${id}`)
    return { id, removed: false }
  }

  /** 重放失败事件：把失败事件重置为待处理，由后台任务重新处理（最多一次 200 条）。 */
  async replay(req: RequestWithContext, id: string, rawBody: unknown) {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIPTION_MANAGE, {})
    const body = SubscriptionReplayBodySchema.parse(rawBody)
    const row = await this.prisma.notificationSubscription.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '订阅不存在')
    const failed = await this.prisma.amazonNotificationEvent.findMany({
      where: { tenantId: context.tenantId, sellerAccountId: row.sellerAccountId, notificationType: row.notificationType, status: 'FAILED', ...(body.eventIds ? { id: { in: body.eventIds } } : {}) },
      orderBy: { receivedAt: 'desc' },
      take: SUBSCRIPTION_REPLAY_MAX,
      select: { id: true },
    })
    if (failed.length === 0) throw appError('DATA_CONDITION_FAILED', '没有可重放的失败事件')
    const ids = failed.map(item => item.id)
    await this.prisma.amazonNotificationEvent.updateMany({ where: { tenantId: context.tenantId, id: { in: ids } }, data: { status: 'RECEIVED', errorCode: null } })
    await this.audit.record(req, {
      action: 'NOTIFICATION_EVENTS_REPLAYED',
      resourceType: 'NotificationSubscription',
      resourceId: id,
      detail: { count: ids.length, notificationType: row.notificationType },
    })
    await this.queue.add('notifications', { tenantId: context.tenantId, kind: 'events-replay', eventIds: ids }, `events-replay:${id}:${Date.now()}`)
    return { replayed: ids.length }
  }
}
