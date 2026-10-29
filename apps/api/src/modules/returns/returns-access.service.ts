import { Injectable } from '@nestjs/common'
import { RETURNS_PERMISSION } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { ApiContext, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'

// 退货详情的统一入口：先校验权限，再按成员的数据范围找退货记录。不在范围内的记录与不存在一样返回 404，不泄露其存在。
export const RETURN_DETAIL_SELECT = {
  id: true,
  sellerAccountId: true,
  amazonOrderId: true,
  returnDate: true,
  asin: true,
  sellerSku: true,
  fnsku: true,
  quantity: true,
  reason: true,
  disposition: true,
  detailedDisposition: true,
  fulfillmentCenterId: true,
  licensePlateNumber: true,
  reportStatus: true,
  // 买家备注只带“有没有、含哪几类、保留到何时”，不带密文与明文；明文只能经 POST /pii/reveal（P6-14）
  customerCommentsExpiresAt: true,
  customerCommentsKinds: true,
  reimbursementStatus: true,
  reimbursementCaseId: true,
  syncedAt: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.FbaReturnCaseSelect

export type ReturnDetailRow = Prisma.FbaReturnCaseGetPayload<{ select: typeof RETURN_DETAIL_SELECT }>
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

@Injectable()
export class ReturnsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async resolve(req: RequestWithContext, id: string): Promise<{ context: ApiContext; scope: ResolvedScope; row: ReturnDetailRow }> {
    const { context, scope } = await this.context.authorizeScoped(req, RETURNS_PERMISSION, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '退货记录不存在')
    const row = await this.prisma.fbaReturnCase.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) }, select: RETURN_DETAIL_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '退货记录不存在')
    return { context, scope, row }
  }
}
