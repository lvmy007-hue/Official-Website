import { Injectable } from '@nestjs/common'
import { aggregateFreshness, FRESHNESS_SOURCES } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'

// 数据新鲜度（P1-28-12）：各数据来源在范围内的最近成功时间、数据覆盖到的时间、延迟、覆盖店铺数与失败原因。
// 登录成员即可查看，范围按其数据授权收窄；失败码只翻译成中文说明，不暴露内部错误。
@Injectable()
export class FreshnessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  // permission 不传：登录成员即可查看；传了（如经营控制台的数据源健康表）则要求该权限点。
  async get(req: RequestWithContext, query: Record<string, string>, permission?: string) {
    const { context, scope } = permission ? await this.context.authorizeScoped(req, permission, query) : await this.context.resolveScoped(req, query)
    const stores = await this.prisma.sellerAccount.findMany({
      where: { tenantId: context.tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true },
      take: 500,
    })
    const rows = await this.prisma.dataFreshness.findMany({
      where: { tenantId: context.tenantId, sourceKey: { in: FRESHNESS_SOURCES.map(item => item.key) }, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    })
    const now = new Date()
    return {
      asOf: now,
      storeCount: stores.length,
      ...aggregateFreshness(
        rows,
        stores.map(store => store.id),
        now,
      ),
    }
  }
}
