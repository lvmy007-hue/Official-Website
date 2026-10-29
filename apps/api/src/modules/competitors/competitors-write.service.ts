import { Injectable } from '@nestjs/common'
import {
  COMPETITOR_ACTIONS,
  COMPETITOR_LIMITS,
  COMPETITOR_MARKETPLACE_ID,
  COMPETITORS_WRITE,
  CompetitorAddBodySchema,
  CompetitorRemoveQuerySchema,
  isAsin,
  normalizeAsin,
  type CompetitorAddResult,
} from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'

const FIRST_SYNC_NOTE = '已加入关注；价格、排名等数据要等下一次同步（每 6 小时一次）才会出现，在那之前显示“尚无记录”'

/** 关注与取消关注（05 章 5.6）：只改本系统里的关注清单，不调用亚马逊。写入走权限、数据范围、事务内审计；取消最后一条关注时一并删除这个竞品的快照。 */
@Injectable()
export class CompetitorsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async add(req: RequestWithContext, rawBody: unknown): Promise<CompetitorAddResult> {
    const { context, scope } = await this.context.authorizeScoped(req, COMPETITORS_WRITE, {})
    const body = CompetitorAddBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    assertStoreInScope(scope, body.storeId)
    const ownAsin = body.ownAsin ?? ''
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.storeId, tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '没有找到这个店铺')
    const products = await this.prisma.fbaProduct.findMany({
      where: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: { in: ownAsin ? [body.asin, ownAsin] : [body.asin] } },
      select: { asin: true },
      take: 4,
    })
    if (products.some(item => item.asin === body.asin)) throw appError('DATA_CONDITION_FAILED', '这个 ASIN 是你自己的商品，不能当作竞品关注')
    if (ownAsin && !products.some(item => item.asin === ownAsin)) throw appError('DATA_CONDITION_FAILED', '我方对应 ASIN 不在这个店铺的商品目录里；请先同步商品目录或留空')
    const count = await this.prisma.watchedAsin.count({ where: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID } })
    if (count >= COMPETITOR_LIMITS.watchMaxPerStore) throw appError('DATA_CONDITION_FAILED', `每个店铺最多关注 ${COMPETITOR_LIMITS.watchMaxPerStore} 条竞品，请先取消一些再添加`)
    try {
      const created = await this.prisma.$transaction(async tx => {
        const row = await tx.watchedAsin.create({
          data: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: body.asin, ownAsin, reason: body.reason, note: body.note || null, addedBy: context.userId },
          select: { id: true },
        })
        await this.audit.record(
          req,
          {
            action: COMPETITOR_ACTIONS.added,
            resourceType: 'WatchedAsin',
            resourceId: row.id,
            before: null,
            after: { storeId: store.id, asin: body.asin, ownAsin: ownAsin || null, reason: body.reason },
          },
          { client: tx },
        )
        return row
      })
      return { id: created.id, asin: body.asin, ownAsin: ownAsin || null, storeId: store.id, reason: body.reason, note: FIRST_SYNC_NOTE }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw appError('DATA_CONDITION_FAILED', '这个竞品已经在关注列表里（同一个我方对应商品）')
      throw error
    }
  }

  async remove(req: RequestWithContext, asinParam: string, rawQuery: Record<string, string>): Promise<{ removed: number }> {
    const { context, scope } = await this.context.authorizeScoped(req, COMPETITORS_WRITE, {})
    const query = CompetitorRemoveQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    assertStoreInScope(scope, query.storeId)
    const asin = normalizeAsin(asinParam)
    if (!isAsin(asin)) throw appError('RESOURCE_NOT_FOUND', '没有找到这条关注记录')
    const ownAsin = query.ownAsin ?? ''
    return this.prisma.$transaction(async tx => {
      const found = await tx.watchedAsin.findFirst({ where: { tenantId, sellerAccountId: query.storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin, ownAsin }, select: { id: true, reason: true } })
      if (!found) throw appError('RESOURCE_NOT_FOUND', '没有找到这条关注记录')
      await tx.watchedAsin.deleteMany({ where: { id: found.id, tenantId } })
      const left = await tx.watchedAsin.count({ where: { tenantId, sellerAccountId: query.storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin } })
      if (left === 0) await tx.competitorSnapshot.deleteMany({ where: { tenantId, sellerAccountId: query.storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin } })
      await this.audit.record(
        req,
        {
          action: COMPETITOR_ACTIONS.removed,
          resourceType: 'WatchedAsin',
          resourceId: found.id,
          before: { storeId: query.storeId, asin, ownAsin: ownAsin || null, reason: found.reason },
          after: null,
        },
        { client: tx },
      )
      return { removed: 1 }
    })
  }
}
