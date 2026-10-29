import { Injectable } from '@nestjs/common'
import { ORDERS_PERMISSION } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { ApiContext, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'

// 订单详情的统一入口：先校验权限（含需要同时具备的其他权限），再按成员的数据范围找订单。
// 不在范围内的订单与不存在一样返回 404，不泄露其存在。订单编号参数既可以是系统编号，也可以是亚马逊订单号。
// 这里读出的订单头不含买家信息密文：密文只有 orders-pii-source.ts 读取（交给 modules/pii 的统一出口解密）。

export const ORDER_HEADER_SELECT = {
  id: true,
  sellerAccountId: true,
  amazonOrderId: true,
  marketplaceId: true,
  purchaseDate: true,
  status: true,
  fulfillment: true,
  fulfillmentStatus: true,
  currency: true,
  amount: true,
  latestShipDate: true,
  earliestDelivery: true,
  latestDelivery: true,
  isReplacement: true,
  replacedOrderId: true,
  replacementReason: true,
  shippedAt: true,
  piiExpiresAt: true,
  programs: true,
  salesChannel: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.OrderSelect

export type OrderHeader = Prisma.OrderGetPayload<{ select: typeof ORDER_HEADER_SELECT }>
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

@Injectable()
export class OrderAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 权限检查：orders.read 加上接口要求的其他权限；任一缺失返回 403。 */
  async authorize(req: RequestWithContext, extra: readonly string[] = []): Promise<{ context: ApiContext; scope: ResolvedScope }> {
    const { context, scope } = await this.context.authorizeScoped(req, ORDERS_PERMISSION, {})
    for (const permission of extra) await this.context.authorize(req, permission)
    return { context, scope }
  }

  async find(tenantId: string, scope: ResolvedScope, id: string): Promise<OrderHeader> {
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '订单不存在')
    const order = await this.prisma.order.findFirst({
      where: { tenantId, ...storeWhere(scope), OR: [{ id }, { amazonOrderId: id }] },
      orderBy: { purchaseDate: 'desc' },
      select: ORDER_HEADER_SELECT,
    })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '订单不存在')
    return order
  }

  async resolve(req: RequestWithContext, id: string, extra: readonly string[] = []) {
    const { context, scope } = await this.authorize(req, extra)
    return { context, scope, order: await this.find(context.tenantId, scope, id) }
  }
}
