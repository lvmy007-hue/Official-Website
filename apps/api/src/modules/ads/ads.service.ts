import { Injectable } from '@nestjs/common'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, adsProfileWhere } from '../auth'

// 广告档案列表（含各档案的连接状态）。报告任务、模板库、核对在 ads-reports*.service.ts（P3-15），指标分析在 ads-metrics.service.ts。
@Injectable()
export class AdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async profiles(req: RequestWithContext, query: Record<string, string> = {}) {
    const { context, scope } = await this.context.authorizeScoped(req, 'ads.read', query)
    return this.prisma.adsProfile.findMany({
      where: { tenantId: context.tenantId, ...adsProfileWhere(scope) },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: { connections: { select: { id: true, provider: true, state: true, lastSuccessfulSyncAt: true, lastErrorCode: true } } },
    })
  }
}
