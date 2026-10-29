import { ADS_V1_RESOURCES, type AdsV1Api, type AdsV1Resource } from '../../connectors/ads-v1-api'
import { parseEntity, type AdsEntityRecord } from '../../connectors/ads-v1-parse'

// 广告实体读取（importers.md A-01）：把统一接口里各类资源翻完、解析成通用实体记录，逐条交出。
// **只读取、不写库**：实体表（AdsAdGroup、AdsAd、AdsTarget 等）与 AdsCampaign 的新列是 P3-02 的迁移，写入由 P3-02 接上这个读取器。
// 某类资源翻页没翻完（页数超限）时 complete 为 false：调用方不能把“这次没出现的实体”当作已删除。

export type EntityReadStats = Record<AdsV1Resource, { read: number; skipped: number; complete: boolean }>

export const newEntityStats = (): EntityReadStats => Object.fromEntries(ADS_V1_RESOURCES.map(resource => [resource, { read: 0, skipped: 0, complete: false }])) as EntityReadStats

export async function* readAdsEntities(api: Pick<AdsV1Api, 'queryAll'>, options: { resources?: readonly AdsV1Resource[]; stats?: EntityReadStats } = {}): AsyncGenerator<AdsEntityRecord> {
  const stats = options.stats ?? newEntityStats()
  for (const resource of options.resources ?? ADS_V1_RESOURCES) {
    const pages = api.queryAll(resource)
    for (;;) {
      const next = await pages.next()
      if (next.done) {
        stats[resource].complete = next.value.complete
        break
      }
      stats[resource].read += 1
      const entity = parseEntity(resource, next.value)
      if (entity) yield entity
      else stats[resource].skipped += 1
    }
  }
}
