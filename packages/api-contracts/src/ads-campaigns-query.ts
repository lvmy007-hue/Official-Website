import { z } from 'zod'
import { ADS_CAMPAIGN_SEARCH_MODES, ADS_CAMPAIGN_SORTS, ADS_CAMPAIGN_TAG_LIMITS } from './ads-campaigns'
import { ADS_LEVEL_FILTERS } from './ads-levels'
import { ADS_ANOMALY_KINDS, ADS_PRODUCTS } from './ads-overview'
import { cursorListQuery } from './query'

// 广告活动页的请求校验（P3-07）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** 列表：范围参数加筛选；排序字段白名单；名称“包含”或“不包含”由 qMode 决定。 */
export const AdsCampaignListQuerySchema = cursorListQuery({
  sortable: ADS_CAMPAIGN_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    adProduct: { type: 'enum', values: ADS_PRODUCTS },
    state: { type: 'text', max: 40 },
    portfolioId: { type: 'text', max: 64 },
    tag: { type: 'text', max: ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH },
    ownerId: { type: 'text', max: 64 },
    anomaly: { type: 'enum', values: ADS_ANOMALY_KINDS },
    qMode: { type: 'enum', values: ADS_CAMPAIGN_SEARCH_MODES },
    ...ADS_LEVEL_FILTERS,
  },
})
export type AdsCampaignListQuery = z.infer<typeof AdsCampaignListQuerySchema>

/** 列表型页签的分页与筛选（范围参数由全局范围校验，这里允许共存）。 */
export const AdsCampaignTabQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    q: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['TARGETED', 'NEGATED', 'UNTARGETED']).optional(),
  })
  .passthrough()
export type AdsCampaignTabQuery = z.infer<typeof AdsCampaignTabQuerySchema>

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')
const tagText = z.string().trim().min(1, '标签不能为空').max(ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH, `标签最多 ${ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH} 个字`)

/** 批量设置标签与负责人：每个活动带版本号（乐观锁），标签有追加、移除、整体替换三种模式；负责人传 null 表示清空。系统内数据，不写亚马逊。 */
export const AdsCampaignMetaBodySchema = z
  .object({
    items: z
      .array(z.object({ id: idText, version: z.number().int().min(1) }).strict())
      .min(1, '请至少选择一个活动')
      .max(ADS_CAMPAIGN_TAG_LIMITS.BATCH_MAX, `一次最多处理 ${ADS_CAMPAIGN_TAG_LIMITS.BATCH_MAX} 个活动`),
    tags: z
      .object({ mode: z.enum(['ADD', 'REMOVE', 'SET']), values: z.array(tagText).max(ADS_CAMPAIGN_TAG_LIMITS.MAX_TAGS) })
      .strict()
      .optional(),
    ownerId: idText.nullable().optional(),
  })
  .strict()
  .refine(body => body.tags !== undefined || body.ownerId !== undefined, { message: '请至少修改标签或负责人其中一项' })
export type AdsCampaignMetaBody = z.infer<typeof AdsCampaignMetaBodySchema>

/** 忽略官方推荐：必须写原因。 */
export const AdsRecommendationDismissBodySchema = z.object({ reason: z.string().trim().min(2, '请填写忽略原因（至少 2 个字）').max(500) }).strict()
export type AdsRecommendationDismissBody = z.infer<typeof AdsRecommendationDismissBodySchema>
