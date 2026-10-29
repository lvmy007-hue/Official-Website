import type { Prisma } from '@prisma/client'
import type { AdsV1Api } from '../../connectors/ads-v1-api'
import { parseRecommendation } from '../../connectors/ads-v1-parse'
import type { ImportContext } from '../../types'

// 官方推荐同步（importers.md A-01：广告统一接口的推荐资源 → AdsRecommendation）。
// 规则：新推荐写成 NEW；已有推荐只更新内容与“最近一次看到”的时间，**不改人工决定的状态**（已采纳、已忽略）；
// 亚马逊这次不再返回的待处理推荐记为 EXPIRED（已失效），再次出现时回到 NEW；已采纳与已忽略的不会被标成已失效。
// 一次最多处理 ADS_RECOMMENDATION_LIMIT 条：超过就停下并标记不完整，不完整时不做“失效”判断（没看到不等于没有）。

export const ADS_RECOMMENDATION_LIMIT = 5000
/** 读已有推荐的上限（Prisma 的 take 上限是 20000）。 */
const EXISTING_LIMIT = 19_999

export type AdsAccountScope = { tenantId: string; adsProfileId: string; adsAccountId: string }
export type RecommendationSyncResult = { read: number; created: number; updated: number; skipped: number; expired: number; complete: boolean }

export async function syncAdsRecommendations(
  ctx: ImportContext,
  api: Pick<AdsV1Api, 'queryAll'>,
  scope: AdsAccountScope,
  options: { now?: Date; limit?: number } = {},
): Promise<RecommendationSyncResult> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? ADS_RECOMMENDATION_LIMIT
  const { prisma } = ctx
  const where = { adsProfileId: scope.adsProfileId, adsAccountId: scope.adsAccountId }
  const existing = new Map(
    (await prisma.adsRecommendation.findMany({ where, select: { recommendationId: true, status: true }, take: EXISTING_LIMIT })).map(row => [row.recommendationId, row.status] as const),
  )
  const result: RecommendationSyncResult = { read: 0, created: 0, updated: 0, skipped: 0, expired: 0, complete: false }
  const pages = api.queryAll('recommendations')
  for (;;) {
    const next = await pages.next()
    if (next.done) {
      result.complete = next.value.complete
      break
    }
    if (result.read >= limit) {
      await pages.return({ complete: false, pages: 0 })
      break
    }
    result.read += 1
    const item = parseRecommendation(next.value)
    if (!item) {
      result.skipped += 1
      continue
    }
    const content = { type: item.type, entityType: item.entityType, entityId: item.entityId, payloadJson: item.payload as Prisma.InputJsonValue, lastSeenAt: now }
    const status = existing.get(item.recommendationId)
    if (status === undefined) {
      await prisma.adsRecommendation.create({ data: { tenantId: scope.tenantId, ...where, recommendationId: item.recommendationId, ...content, receivedAt: now } })
      existing.set(item.recommendationId, 'NEW')
      result.created += 1
    } else {
      await prisma.adsRecommendation.update({
        where: { tenantId_adsAccountId_recommendationId: { tenantId: scope.tenantId, adsAccountId: scope.adsAccountId, recommendationId: item.recommendationId } },
        data: { ...content, ...(status === 'EXPIRED' ? { status: 'NEW' } : {}) },
      })
      result.updated += 1
    }
  }
  if (result.complete) result.expired = (await prisma.adsRecommendation.updateMany({ where: { ...where, status: 'NEW', lastSeenAt: { lt: now } }, data: { status: 'EXPIRED' } })).count
  return result
}
