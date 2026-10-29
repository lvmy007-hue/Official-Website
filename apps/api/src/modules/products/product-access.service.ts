import { Injectable } from '@nestjs/common'
import { US_MARKETPLACE_ID } from '@nova/api-contracts'
import { withOwnedFields } from '@nova/authz'
import type { FbaProduct } from '@prisma/client'
import { ApiContext, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'

export type ResolvedProduct = FbaProduct & { sellerAccount: { displayName: string } }

export interface ProductAccess {
  context: ApiContext
  scope: ResolvedScope
  product: ResolvedProduct
}

// ASIN 360 各接口的共同入口：先做权限检查（必须先于任何参数校验），再按成员的数据范围读出这条商品。
// 不在数据范围内的编号与不存在的编号一样返回 404，不泄露它是否存在。
// 数据范围只取成员本身的范围，不受页面顶部“店铺”筛选影响：从别处点进来的商品不会因为顶部筛选了别的店铺而打不开。
@Injectable()
export class ProductAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** extra：页签数据接口再要求的权限（如库存页签要 inventory.read，利润页签要 profit.read 与 field.profit），同样先于查库校验。 */
  async resolve(req: RequestWithContext, id: string, extra?: string | readonly string[]): Promise<ProductAccess> {
    const { context, scope } = await this.context.authorizeScoped(req, 'products.read', {})
    for (const permission of typeof extra === 'string' ? [extra] : (extra ?? [])) this.context.require(context, permission)
    const product = await this.prisma.fbaProduct.findFirst({
      where: { id, tenantId: context.tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
      include: { sellerAccount: { select: { displayName: true } } },
    })
    if (!product) throw appError('RESOURCE_NOT_FOUND', '商品不存在')
    // 字段权限“仅负责人可见”（P5-08）：本人是这个商品的负责人时，成本与利润的标记升级成完整字段权限；其他商品仍然看不到
    const owned = product.ownerUserId !== null && product.ownerUserId === context.userId
    return { context: owned ? { ...context, permissions: withOwnedFields(context.permissions) } : context, scope, product }
  }
}
