import { Injectable } from '@nestjs/common'
import { ALERTS_READ, type AlertListItem } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { ALERT_INCLUDE, alertItem, loadLookups } from './alerts-common'

export interface AlertEntityRef {
  type: string
  id: string
}

// 按对象读预警（P6-21，ASIN 360 的“预警日志”用）：只返回命中给定对象的预警，状态不限（含已处理、已恢复），按最近触发时间新到旧。
// 与预警列表同一套权限与数据范围：先要 alerts.read，再按成员的店铺范围收窄；没有店铺归属的企业级预警只有全范围成员看得到。
@Injectable()
export class AlertsEntityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async forEntities(req: RequestWithContext, entities: readonly AlertEntityRef[], limit: number): Promise<{ items: AlertListItem[]; truncated: boolean }> {
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_READ, {})
    if (entities.length === 0) return { items: [], truncated: false }
    const where: Prisma.AlertInstanceWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      OR: entities.map(entity => ({ entityType: entity.type, entityId: entity.id })),
    }
    const rows = await this.prisma.alertInstance.findMany({ where, orderBy: [{ lastTriggeredAt: 'desc' }, { id: 'asc' }], take: limit + 1, include: ALERT_INCLUDE })
    const page = rows.slice(0, limit)
    const lookups = await loadLookups(this.prisma, context.tenantId, context.userId, page)
    return { items: page.map(row => alertItem(row, lookups)), truncated: rows.length > limit }
  }
}
