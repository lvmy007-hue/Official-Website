import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'

// 商品目录接口（Catalog Items API v2022-04-01，importers.md I-09）。路径、参数与响应字段对照亚马逊官方模型
// （selling-partner-api-models/models/catalog-items-api-model/catalogItems_2022-04-01.json）：
//   searchCatalogItems  GET /catalog/2022-04-01/items?identifiers=A1,A2&identifiersType=ASIN&marketplaceIds=…&includedData=…&pageSize=…
// 约束：identifiers 最多 20 个（逗号分隔）；includedData 取 attributes、images、productTypes、relationships、salesRanks、summaries（逗号分隔）；
// 限速约每秒 2 次、突发 2（官方公布值，沿用按店铺的令牌桶并按响应头校准）。固定美国站。
// 目录里没有的 ASIN 不会出现在响应里，也没有专门的错误码：由同步器按“请求了但没返回”标记为待核实。

export const CATALOG_PATH = '/catalog/2022-04-01/items'
export const CATALOG_BATCH_SIZE = 20
// attributes（P4-03）：只用来读变体主题列出的那几个维度的取值（颜色、尺码等），其余属性不存
export const CATALOG_INCLUDED_DATA = ['attributes', 'images', 'productTypes', 'relationships', 'salesRanks', 'summaries'] as const

/** 只含 ASIN 的批次整批被拒（例如 ASIN 格式不合法）：官方返回 400；其余错误（403 缺角色、429、5xx）原样抛出，由任务运行时分类重试。 */
export const isBadIdentifiers = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 400

/** 403：缺“商品目录”角色（竞品监控用同一个接口读别人的商品，角色缺失要以不可重试的失败码结束）。 */
export const isCatalogForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

export class CatalogApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 按 ASIN 批量取目录条目（一次最多 20 个）。 */
  getItems(asins: readonly string[]) {
    if (asins.length === 0 || asins.length > CATALOG_BATCH_SIZE) throw new Error('CATALOG_BATCH_SIZE_INVALID')
    return this.client.request({
      path: CATALOG_PATH,
      query: {
        identifiers: asins.join(','),
        identifiersType: 'ASIN',
        marketplaceIds: US_MARKETPLACE,
        includedData: CATALOG_INCLUDED_DATA.join(','),
        pageSize: String(CATALOG_BATCH_SIZE),
        locale: 'en_US',
      },
    })
  }
}
