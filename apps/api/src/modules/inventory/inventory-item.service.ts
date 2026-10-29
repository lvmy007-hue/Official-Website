import { Injectable } from '@nestjs/common'
import type { InventoryPolicy } from '@nova/api-contracts'
import { appError, ApiContext, RequestWithContext } from '../../platform/http'
import { ContextService, type ResolvedScope } from '../auth'
import { InventoryLoaderService } from './inventory-loader.service'
import { InventoryPolicyService } from './inventory-policy.service'
import type { BuiltRow } from './inventory-row'

// 详情页各接口的共同入口：先做权限检查（必须先于任何参数校验），再按店铺范围读出这一条库存记录并算好风险。
// 不在数据范围内的编号与不存在的编号一样返回 404，不泄露它是否存在。

export interface ResolvedItem {
  context: ApiContext
  scope: ResolvedScope
  today: string
  policy: InventoryPolicy | null
  item: BuiltRow
}

@Injectable()
export class InventoryItemService {
  constructor(
    private readonly context: ContextService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async resolve(req: RequestWithContext, id: string, extraPermissions: readonly string[] = []): Promise<ResolvedItem> {
    const { context, scope } = await this.context.authorizeScoped(req, 'inventory.read', {})
    for (const permission of extraPermissions) await this.context.authorize(req, permission)
    const today = await this.policies.todayOf(context.tenantId)
    const policy = await this.policies.currentOf(context.tenantId, today)
    const { items } = await this.loader.load({ tenantId: context.tenantId, scope, today, policy, ids: [id], limit: 1 })
    const item = items[0]
    if (!item) throw appError('RESOURCE_NOT_FOUND', '库存记录不存在')
    return { context, scope, today, policy, item }
  }
}
