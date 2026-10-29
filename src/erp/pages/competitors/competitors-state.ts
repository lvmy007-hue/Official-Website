import type { CompetitorFeatured, CompetitorReason, CompetitorSort } from '@nova/api-contracts'

// 竞品监控页的公共状态（P4-12）。不引入 zod：首屏脚本不能依赖请求校验库。

export const PAGE_SIZES = [20, 50, 100] as const

export interface CompetitorFilters {
  q?: string
  reason?: CompetitorReason
}

export const SORT_LABEL: Record<CompetitorSort, string> = {
  addedAt: '关注时间',
  asin: '竞品 ASIN',
  price: '竞品价格',
  rank: '竞品销售排名',
  priceGap: '与我方的价格差',
  rankGap: '与我方的名次差',
  clickShare: '在核心词中的点击份额',
  observedAt: '最近同步时间',
}

export const SORT_FIELDS = Object.keys(SORT_LABEL) as CompetitorSort[]

export const FEATURED_COLOR: Record<CompetitorFeatured, string> = { HAS_FEATURED: 'success', NONE: 'default' }

/** 详情页路径：竞品 ASIN 在路径里，店铺与我方对应 ASIN 放在参数里（同一个竞品在不同店铺、对应不同我方商品是不同的关注）。 */
export const detailPath = (asin: string) => `/app/competitors/${encodeURIComponent(asin)}`
export const detailSearch = (storeId: string, ownAsin: string | null): Record<string, string> => (ownAsin ? { storeId, ownAsin } : { storeId })

/** ASIN 输入的校验提示；通过返回 null。与服务端规则一致：10 位字母或数字。 */
export function asinIssue(value: string | null | undefined, label = '竞品 ASIN'): string | null {
  const text = (value ?? '').trim().toUpperCase()
  if (!text) return `请填写${label}`
  if (!/^[A-Z0-9]{10}$/.test(text)) return `${label}是 10 位字母或数字，例如 B0ABCDE123`
  return null
}
