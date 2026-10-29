import { Injectable } from '@nestjs/common'
import type { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import type { PiiRecord, PiiSource } from '../../platform/security/pii-source'
import { OrderAccessService } from './orders-access.service'

// 订单买家信息的来源（P6-14）：只在订单读权限与店铺范围内找到订单并交出加密的买家信息，不解密、不写审计（统一出口 POST /pii/reveal 负责）。
// 买家信息有保留期（发货后最长 30 天，由后台任务清除）；保留期字段与密文一起交给统一出口判断。
@Injectable()
export class OrdersPiiSource implements PiiSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrderAccessService,
  ) {}

  async open(req: RequestWithContext, objectId: string): Promise<PiiRecord> {
    const { context, scope } = await this.access.authorize(req)
    const order = await this.access.find(context.tenantId, scope, objectId)
    const stored = await this.prisma.order.findFirst({ where: { id: order.id, purchaseDate: order.purchaseDate, tenantId: context.tenantId }, select: { piiCiphertext: true, piiExpiresAt: true } })
    return {
      resourceType: 'Order',
      resourceId: order.id,
      detail: { amazonOrderId: order.amazonOrderId, storeId: order.sellerAccountId },
      stored: stored?.piiCiphertext ? { kind: 'SEALED_JSON', ciphertext: stored.piiCiphertext } : { kind: 'NONE' },
      retainedUntil: stored?.piiExpiresAt ?? null,
      notes: {
        EXPIRED: '买家信息已超过保留期，亚马逊要求清除，无法再查看',
        NOT_SYNCED: '这个订单还没有买家信息：店铺未授权读取个人信息，或订单尚未同步到买家字段',
      },
    }
  }
}
