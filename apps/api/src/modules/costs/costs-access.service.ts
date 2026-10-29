import { Injectable } from '@nestjs/common'
import { COSTS_READ, COSTS_WRITE } from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { AppError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { assertUnrestricted, ContextService, storeWhere, type ResolvedScope } from '../auth'

// 商品成本各接口共用的准入（P2b-14）：读需要 costs.read，并且需要字段权限 field.cost（没有返回 403，不返回一份去掉成本的空壳）；
// 写需要 costs.write 与“全部店铺”数据范围——成本版本按 SKU 记在企业层面，一个版本会影响所有店铺的利润，受限范围的成员不能改。
// 权限检查先于参数校验：无权限的人看不到校验细节。

export interface CostAccess {
  context: ApiContext
  scope: ResolvedScope
  tenantId: string
  canWrite: boolean
}

@Injectable()
export class CostsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async read(req: RequestWithContext, rawQuery: unknown): Promise<CostAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, COSTS_READ, rawQuery)
    if (!canSeeField(context.permissions, 'cost')) throw new AppError(403, 'TENANT_ACCESS_DENIED', '商品成本需要成本字段权限（field.cost）')
    const canWrite = scope.unrestricted && hasPermission(context.permissions, COSTS_WRITE)
    return { context, scope, tenantId: context.tenantId, canWrite }
  }

  async write(req: RequestWithContext): Promise<CostAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, COSTS_WRITE, {})
    assertUnrestricted(scope)
    return { context, scope, tenantId: context.tenantId, canWrite: true }
  }

  /** 这个 SKU 在成员范围内才能看：全部范围只要有商品或成本版本；受限范围必须有范围内店铺的商品。 */
  async skuVisible(access: CostAccess, sku: string): Promise<boolean> {
    const { tenantId, scope } = access
    const product = await this.prisma.fbaProduct.findFirst({ where: { tenantId, sellerSku: sku, ...storeWhere(scope) }, select: { id: true } })
    if (product) return true
    if (!scope.unrestricted) return false
    return Boolean(await this.prisma.costVersion.findFirst({ where: { tenantId, sku }, select: { id: true } }))
  }
}
