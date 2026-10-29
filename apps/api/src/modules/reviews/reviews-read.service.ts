import { Injectable } from '@nestjs/common'
import { REVIEWS_READ, REVIEWS_SOLICIT, ReviewsQuerySchema, SOLICITATION_SWITCH_KEY, type ReviewsTabResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { storesOf, type ReviewsTabInput } from './reviews-common'
import { ReviewsRatingsService } from './reviews-ratings.service'
import { ReviewsReturnsService } from './reviews-returns.service'
import { ReviewsSolicitService } from './reviews-solicit.service'
import { ReviewsTopicsService } from './reviews-topics.service'

/**
 * GET /reviews（05 章 5.7）：按页签返回评分概况、评论主题、退货主题、请求评价。
 * 顺序：权限（403）→ 校验参数（422）→ 店铺在范围内（403）→ 读数据。storeId 在评分概况与请求评价页签里收窄店铺，在评论主题与退货主题页签里只用来选中商品或类目。
 */
@Injectable()
export class ReviewsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly ratings: ReviewsRatingsService,
    private readonly topics: ReviewsTopicsService,
    private readonly returns: ReviewsReturnsService,
    private readonly solicit: ReviewsSolicitService,
    private readonly guard: ActionGuardService,
  ) {}

  async read(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ReviewsTabResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, REVIEWS_READ, rawQuery)
    const query = ReviewsQuerySchema.parse(rawQuery)
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const stores = await storesOf(this.prisma, context.tenantId, scope)
    const input: ReviewsTabInput = {
      tenantId: context.tenantId,
      scope,
      permissions: context.permissions,
      query,
      rawQuery,
      stores,
      visible: stores.filter(store => !query.storeId || store.id === query.storeId),
      now,
    }
    switch (query.tab ?? 'ratings') {
      case 'topics':
        return this.topics.tab(input)
      case 'returns':
        return this.returns.tab(input)
      case 'solicit':
        return {
          ...(await this.solicit.tab(input)),
          // 开关只看企业级（不按店铺），按钮禁用的原因由这里给；提交时仍会按店铺再校验连接与开关
          switch: {
            enabled: (await this.guard.evaluate(context, { permission: REVIEWS_READ, switchKey: SOLICITATION_SWITCH_KEY })).allowed,
            permitted: hasPermission([...context.permissions], REVIEWS_SOLICIT),
          },
        }
      default:
        return this.ratings.tab(input)
    }
  }
}
