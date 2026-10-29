import { Injectable } from '@nestjs/common'
import { ENTITY_READ_PERMISSION, OPERATION_SCOPE_ENTITY, type OPERATION_SCOPES } from '@nova/api-contracts'
import { ApiContext, appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { WorkQueryService } from '../work'

// 协作对象的读权限（P1-28-7/9/10）：评论、关注、事件时间线、运营日志都“随对象读权限”——
// 看得到对象才看得到它的协作内容；看不到的一律 403（待办按“不存在”处理，避免泄露其存在）。
@Injectable()
export class EntityAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly work: WorkQueryService,
  ) {}

  async assertReadable(context: ApiContext, entityType: string, entityId: string) {
    if (entityType === 'WORK_ITEM') {
      await this.work.visibleItem(context, entityId)
      return
    }
    // 目录里没有登记的对象类型一律要求经营概览读权限，避免新增类型时漏配而放开
    const permission = ENTITY_READ_PERMISSION[entityType] === undefined ? 'overview.read' : ENTITY_READ_PERMISSION[entityType]
    if (permission) this.context.require(context, permission)
    if (entityType === 'STORE') {
      const store = await this.prisma.sellerAccount.findFirst({ where: { id: entityId, tenantId: context.tenantId }, select: { id: true } })
      if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    }
  }

  /** 运营日志的范围（店铺、商品、广告活动）对应的对象读权限。 */
  async assertScopeReadable(context: ApiContext, scope: (typeof OPERATION_SCOPES)[number], scopeRef: string) {
    await this.assertReadable(context, OPERATION_SCOPE_ENTITY[scope], scopeRef)
  }
}
