import { Injectable } from '@nestjs/common'
import { ADS_READ, ScopeSearchSchema, type Asin360AdsResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { AsinAdsTabService } from '../ads'
import { ProductAccessService } from './product-access.service'

// ASIN 360“广告”页签（P3-19，05 章 5.2 第 3 个页签）：这里只负责准入与找到商品，广告数据的读取与口径在广告模块（AsinAdsTabService）。
// 顺序：先校验权限（products.read 与 ads.read），再按成员的数据范围找商品（范围外与不存在都是 404），最后才解析日期参数。
@Injectable()
export class ProductAdsService {
  constructor(
    private readonly access: ProductAccessService,
    private readonly tab: AsinAdsTabService,
  ) {}

  async ads(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360AdsResponse> {
    const { context, scope, product } = await this.access.resolve(req, id, ADS_READ)
    const query = ScopeSearchSchema.parse(rawQuery)
    return this.tab.tab({ tenantId: context.tenantId, scope, storeId: product.sellerAccountId, asin: product.asin, query, now })
  }
}
