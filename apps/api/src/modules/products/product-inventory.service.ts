import { Injectable } from '@nestjs/common'
import { asin360ActionRuleViews, type Asin360ActionsResponse, type Asin360InventoryRef } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { ProductAccessService } from './product-access.service'
import { ProductIdentityService } from './product-identity.service'

const NO_RECORD = '这个商品还没有库存记录（库存同步后显示）'

// 库存补货页签与建议动作区：库存结构、在途、补货、上游仓储、库龄与费用直接复用库存详情（P2a-07 ~ P2a-13）的接口，
// 这里只负责把商品对到库存记录，避免两处各算一遍口径。
@Injectable()
export class ProductInventoryService {
  constructor(
    private readonly access: ProductAccessService,
    private readonly identity: ProductIdentityService,
  ) {}

  async inventoryRef(req: RequestWithContext, id: string): Promise<Asin360InventoryRef> {
    const { product } = await this.access.resolve(req, id, 'inventory.read')
    const detail = await this.identity.inventoryDetail(req, product)
    return detail ? { state: 'OK', note: null, inventoryId: detail.row.id } : { state: 'NO_DATA', note: NO_RECORD, inventoryId: null }
  }

  /** 建议动作：库存类规则（断货、补货、滞销、库龄）由库存详情给出；其余规则没有数据来源，在 `rules` 里写“尚未接入”，不当作“没触发”。 */
  async actions(req: RequestWithContext, id: string): Promise<Asin360ActionsResponse> {
    const { context, product } = await this.access.resolve(req, id)
    if (!hasPermission(context.permissions, 'inventory.read')) {
      return { state: 'RESTRICTED', note: '需要“库存”读取权限才能查看库存类建议', inventoryId: null, items: [], rules: asin360ActionRuleViews({ inventory: 'RESTRICTED', suggestionIds: [] }) }
    }
    const detail = await this.identity.inventoryDetail(req, product)
    if (!detail) return { state: 'NO_DATA', note: NO_RECORD, inventoryId: null, items: [], rules: asin360ActionRuleViews({ inventory: 'NO_DATA', suggestionIds: [] }) }
    return {
      state: 'OK',
      note: detail.suggestions.length ? null : '当前没有需要处理的库存类建议',
      inventoryId: detail.row.id,
      items: detail.suggestions,
      rules: asin360ActionRuleViews({ inventory: 'OK', suggestionIds: detail.suggestions.map(item => item.id) }),
    }
  }
}
