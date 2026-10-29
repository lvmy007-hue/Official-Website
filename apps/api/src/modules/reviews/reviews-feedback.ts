import { FEEDBACK_FRESHNESS_KEY, FEEDBACK_NO_BRAND_ACCESS, type ReviewSectionState } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'

// 客户反馈接口（评论主题、类目趋势）的空状态判断：没有同步过 = 尚未接入；店铺没有品牌分析权限 = 不适用（不是故障，也不当成 0）。

export const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并等待同步后才有数据'
export const NOTE_NOT_CONNECTED = '还没有同步到客户反馈数据：评论主题需要品牌备案和品牌分析角色，开通后等待每周一次的同步；同步成功之前这里没有数据'
export const NOTE_NOT_APPLICABLE = '这个店铺没有品牌分析权限，客户反馈接口不可用，所以没有评论主题与退货主题；前提是店铺已品牌备案并授予品牌分析角色'

/** 客户反馈同步最近一次以“没有品牌分析权限”结束的店铺。 */
export async function noBrandStores(prisma: PrismaService, tenantId: string, storeIds: readonly string[]): Promise<Set<string>> {
  if (storeIds.length === 0) return new Set()
  const rows = await prisma.dataFreshness.findMany({
    where: { tenantId, sourceKey: FEEDBACK_FRESHNESS_KEY, sellerAccountId: { in: [...storeIds] }, lastErrorCode: FEEDBACK_NO_BRAND_ACCESS },
    select: { sellerAccountId: true },
    take: 500,
  })
  return new Set(rows.flatMap(row => (row.sellerAccountId ? [row.sellerAccountId] : [])))
}

/**
 * 范围内没有任何客户反馈数据时的状态：指定了店铺就看这个店铺，否则要范围内每个店铺都没有品牌分析权限才算“不适用”（只要有一个店铺在等同步，就是“尚未接入”）。
 */
export function emptyFeedbackState(storeIds: readonly string[], noBrand: ReadonlySet<string>, focusStoreId?: string): { state: ReviewSectionState; note: string } {
  if (storeIds.length === 0) return { state: 'NOT_CONNECTED', note: NOTE_NO_STORE }
  const blocked = focusStoreId ? noBrand.has(focusStoreId) : storeIds.every(id => noBrand.has(id))
  return blocked ? { state: 'NOT_APPLICABLE', note: NOTE_NOT_APPLICABLE } : { state: 'NOT_CONNECTED', note: NOTE_NOT_CONNECTED }
}
