import { Injectable } from '@nestjs/common'
import { SUBSCRIPTION_MANAGE, SUBSCRIPTION_READ, SUBSCRIPTION_STORE_LIMIT, type SubscriptionCenterResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { buildSubscriptionCenter } from './subscription-center.build'
import { destinationIdFrom } from './destination'

const DAY_MS = 86_400_000
const ROW_LIMIT = 5000

// 消息推送订阅页的读取（P5-05，09 章 9.7）。只读；订阅、改过滤条件、取消、重放在 SubscriptionsService。
// 店铺按成员的数据范围过滤；事件数与失败数按近 24 小时现算，不信任订阅记录上的缓存列。
@Injectable()
export class SubscriptionCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext): Promise<SubscriptionCenterResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SUBSCRIPTION_READ, {})
    const tenantId = context.tenantId
    const stores = await this.prisma.sellerAccount.findMany({
      where: { tenantId, ...storeWhere(scope, 'id') },
      select: { id: true, displayName: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: SUBSCRIPTION_STORE_LIMIT + 1,
    })
    const shown = stores.slice(0, SUBSCRIPTION_STORE_LIMIT)
    const storeIds = shown.map(store => store.id)
    const since = new Date(Date.now() - DAY_MS)
    const [rows, events, connections] =
      storeIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.prisma.notificationSubscription.findMany({
              where: { tenantId, sellerAccountId: { in: storeIds } },
              select: { id: true, sellerAccountId: true, destinationId: true, notificationType: true, status: true, filterJson: true, lastReceivedAt: true, version: true },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: ROW_LIMIT,
            }),
            this.prisma.amazonNotificationEvent.groupBy({
              by: ['sellerAccountId', 'notificationType', 'status'],
              where: { tenantId, sellerAccountId: { in: storeIds }, receivedAt: { gte: since } },
              _count: { _all: true },
              orderBy: [{ sellerAccountId: 'asc' }, { notificationType: 'asc' }, { status: 'asc' }],
            }),
            this.prisma.platformConnection.findMany({
              where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, sellerAccountId: { in: storeIds } },
              select: { sellerAccountId: true },
              take: SUBSCRIPTION_STORE_LIMIT * 5,
            }),
          ])
    return buildSubscriptionCenter({
      destinationId: destinationIdFrom(process.env),
      canManage: hasPermission(context.permissions, SUBSCRIPTION_MANAGE),
      stores: shown,
      authorizedStoreIds: new Set(connections.flatMap(item => (item.sellerAccountId ? [item.sellerAccountId] : []))),
      rows,
      events: events.map(item => ({ sellerAccountId: item.sellerAccountId, notificationType: item.notificationType, status: item.status, count: item._count._all })),
      truncated: stores.length > SUBSCRIPTION_STORE_LIMIT,
    })
  }
}
