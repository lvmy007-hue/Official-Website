import { Injectable } from '@nestjs/common'
import { PRODUCT_SYNC_NO_CONNECTION, PRODUCT_SYNC_PERMISSION, ProductSyncBodySchema, US_MARKETPLACE_ID, type ProductSyncResult } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { SyncService } from '../sync'

/**
 * 同步商品目录（05 章 5.1 批量动作）：亚马逊的商品目录同步是“店铺授权”级任务，不是逐个商品，所以这里按店铺发起。
 * 复用同步中心的入队与去重（同一授权已有排队或运行中的任务时直接返回它），审计由路由上的 @Write 记录。
 */
@Injectable()
export class ProductSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly sync: SyncService,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<ProductSyncResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PRODUCT_SYNC_PERMISSION, {})
    const body = ProductSyncBodySchema.parse(rawBody)
    const storeIds = [...new Set(body.storeIds)]
    const visible = scope.unrestricted ? storeIds : storeIds.filter(id => scope.sellerAccountIds.includes(id))
    const stores = await this.prisma.sellerAccount.findMany({
      where: { tenantId: context.tenantId, id: { in: visible } },
      select: { id: true, displayName: true },
      orderBy: [{ id: 'asc' }],
      take: storeIds.length,
    })
    // 范围外的店铺与不存在一样处理，不泄露存在性
    if (stores.length !== storeIds.length) throw appError('RESOURCE_NOT_FOUND', `有 ${storeIds.length - stores.length} 个店铺不存在或不在你的数据范围内，没有发起同步`)
    const connections = await this.prisma.platformConnection.findMany({
      where: { tenantId: context.tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: { in: storeIds } },
      select: { id: true, sellerAccountId: true },
      orderBy: [{ id: 'asc' }],
      take: 500,
    })
    const result: ProductSyncResult = { jobs: [], skipped: [] }
    for (const store of stores) {
      const connection = connections.find(row => row.sellerAccountId === store.id)
      if (!connection) {
        result.skipped.push({ storeId: store.id, storeName: store.displayName, reason: PRODUCT_SYNC_NO_CONNECTION })
        continue
      }
      const job = await this.sync.createFba(req, { type: 'CATALOG', connectionId: connection.id, marketplaceId: US_MARKETPLACE_ID })
      // 目录同步走同步任务（有 id）；返回值是联合类型（退货走报告任务），这里只会是前者
      if (!('id' in job)) throw appError('INTERNAL_ERROR', '商品目录同步没有返回任务编号')
      result.jobs.push({ storeId: store.id, storeName: store.displayName, jobId: job.id })
    }
    return result
  }
}
