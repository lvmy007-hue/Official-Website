import { Injectable } from '@nestjs/common'
import { ALERTS_READ, ASIN360_ALERT_LIMIT, US_MARKETPLACE_ID, type Asin360AlertsResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AlertsEntityService, type AlertEntityRef } from '../alerts'
import { ProductAccessService } from './product-access.service'

// ASIN 360 预警日志（P6-21，16 章 3.1 第 12 项）：只显示和本商品有关的预警。
// “有关”= 预警对象是这个商品（评估器按商品行编号登记的 ASIN 与 SKU 两类对象）或这个商品的库存记录（断货与补货类预警按库存记录登记）。
// 顺序：先校验 products.read 与 alerts.read，再按成员数据范围找商品；预警本身再按成员的店铺范围过滤。
@Injectable()
export class ProductAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly alerts: AlertsEntityService,
  ) {}

  async list(req: RequestWithContext, id: string): Promise<Asin360AlertsResponse> {
    const { product } = await this.access.resolve(req, id, ALERTS_READ)
    const record = await this.prisma.fbaInventoryRecord.findFirst({
      where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, marketplaceId: US_MARKETPLACE_ID, sellerSku: product.sellerSku },
      select: { id: true },
    })
    const entities: AlertEntityRef[] = [{ type: 'ASIN', id: product.id }, { type: 'SKU', id: product.id }, ...(record ? [{ type: 'INVENTORY', id: record.id }] : [])]
    const found = await this.alerts.forEntities(req, entities, ASIN360_ALERT_LIMIT)
    return {
      state: found.items.length > 0 ? 'OK' : 'NO_DATA',
      note: found.items.length > 0 ? null : '这个商品还没有触发过预警（系统每 15 分钟按预警规则评估一次，数据同步后才会出现）',
      items: found.items,
      truncated: found.truncated,
    }
  }
}
