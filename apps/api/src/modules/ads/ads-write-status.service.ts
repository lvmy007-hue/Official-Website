import { Injectable } from '@nestjs/common'
import { ADS_READ, ADS_WRITE_KIND_INFO, ADS_WRITE_KINDS, ADS_WRITE_RUN_LIMIT, type AdsWriteStatusResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { IntegrationSwitchPort } from '../../platform/write'
import { adsRelationWhere, ContextService } from '../auth'
import { RUN_SELECT, runRowOf, switchViews } from './ads-write-common'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// 广告写入的状态与记录（P3-17）：每类写入对当前账号能不能用（权限 + 开关），以及最近的写入记录（页面轮询看结果）。
// 页面据此决定按钮能不能点、为什么不能点；服务端提交前仍会用动作守卫再判断一次，这里不作为依据。
@Injectable()
export class AdsWriteStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly switches: IntegrationSwitchPort,
  ) {}

  async status(req: RequestWithContext, query: Record<string, string>): Promise<AdsWriteStatusResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    const entityId = query.entityId
    if (entityId !== undefined && !ID_PATTERN.test(entityId)) throw appError('VALIDATION_FAILED', '对象编号格式不正确', { fieldErrors: { entityId: ['编号格式不正确'] } })
    const views = new Map(
      (
        await switchViews(
          this.switches,
          context.tenantId,
          ADS_WRITE_KINDS.map(kind => ADS_WRITE_KIND_INFO[kind].switchKey),
        )
      ).map(view => [view.key, view]),
    )
    const kinds = ADS_WRITE_KINDS.map(kind => {
      const info = ADS_WRITE_KIND_INFO[kind]
      const view = views.get(info.switchKey)
      const permitted = hasPermission(context.permissions, info.permission)
      return {
        kind,
        label: info.label,
        permitted,
        switchKey: info.switchKey,
        switchEnabled: view?.enabled ?? false,
        reason: !permitted ? '当前账号没有执行此操作的权限' : (view?.reason ?? null),
      }
    })
    const rows = await this.prisma.adsWriteRun.findMany({
      where: { tenantId: context.tenantId, ...adsRelationWhere(scope), ...(entityId ? { entityId } : {}) },
      select: RUN_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: ADS_WRITE_RUN_LIMIT,
    })
    return { kinds, runs: rows.map(runRowOf) }
  }
}
