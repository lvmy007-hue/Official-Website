import { Injectable } from '@nestjs/common'
import { RETURN_PII_FIELDS } from '@nova/api-contracts'
import type { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import type { PiiRecord, PiiSource } from '../../platform/security/pii-source'
import { ReturnsAccessService } from './returns-access.service'

// 退货买家备注的来源（P6-14）：在退货读权限与店铺范围内找到退货记录并交出加密的备注，不解密、不写审计（统一出口 POST /pii/reveal 负责）。
// 备注与订单买家信息用同一套密钥与保留规则（发货后最长 30 天）；已过期但后台任务还没清除的，保留期字段让统一出口判为已过期。
@Injectable()
export class ReturnsPiiSource implements PiiSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReturnsAccessService,
  ) {}

  async open(req: RequestWithContext, objectId: string): Promise<PiiRecord> {
    const { context, row } = await this.access.resolve(req, objectId)
    const stored = await this.prisma.fbaReturnCase.findFirst({ where: { id: row.id, tenantId: context.tenantId }, select: { customerCommentsCipher: true, customerCommentsExpiresAt: true } })
    const field = RETURN_PII_FIELDS[0]
    return {
      resourceType: 'FbaReturnCase',
      resourceId: row.id,
      detail: { amazonOrderId: row.amazonOrderId, storeId: row.sellerAccountId },
      stored: stored?.customerCommentsCipher ? { kind: 'SEALED_TEXT', ciphertext: stored.customerCommentsCipher, field } : { kind: 'NONE' },
      retainedUntil: stored?.customerCommentsExpiresAt ?? null,
      notes: {
        EXPIRED: '买家备注已超过保留期，亚马逊要求清除，无法再查看',
        NOT_SYNCED: '这条退货没有买家备注：买家没有留言，或备注已按保留期清除',
      },
    }
  }
}
