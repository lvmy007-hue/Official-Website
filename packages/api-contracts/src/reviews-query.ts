import { z } from 'zod'
import { ELIGIBLE_SORTS, REVIEWS_LIMITS, REVIEWS_TABS, REVIEW_SORTS } from './reviews.js'
import { REVIEW_ASIN_PATTERN, normalizeReviewAsin } from './reviews-math.js'
import { cursorListQuery } from './query.js'

// 评价与反馈的请求校验（P4-13）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

const StoreId = z.string().trim().min(1).max(64)
const Asin = z
  .string({ error: 'ASIN 要填文字' })
  .transform(normalizeReviewAsin)
  .refine(value => REVIEW_ASIN_PATTERN.test(value), { error: 'ASIN 是 10 位字母或数字，例如 B0ABCDE123' })

/**
 * GET /reviews：全局范围参数加页签。评分概况用游标分页（q 搜 ASIN 与标题，可按星级上限筛）；
 * 评论主题页用 storeId + asin 选商品（不带就取最近有主题的商品）；退货主题页用 storeId + nodeId 选类目；请求评价页签用 storeId 收窄店铺。
 */
export const ReviewsQuerySchema = cursorListQuery({
  sortable: REVIEW_SORTS,
  defaultSort: { field: 'asin', dir: 'asc' },
  filters: {
    tab: { type: 'enum', values: REVIEWS_TABS },
    storeId: { type: 'text', max: 64 },
    asin: { type: 'text', max: 10 },
    nodeId: { type: 'text', max: 64 },
    ratingBelow: { type: 'number', min: 1, max: 5 },
  },
})
export type ReviewsQuery = z.infer<typeof ReviewsQuerySchema>

/** GET /reviews/solicitations/eligible：游标分页，按送达时间排序。 */
export const EligibleQuerySchema = cursorListQuery({
  sortable: ELIGIBLE_SORTS,
  defaultSort: { field: 'deliveredAt', dir: 'asc' },
  filters: { storeId: { type: 'text', max: 64 } },
})
export type EligibleQuery = z.infer<typeof EligibleQuerySchema>

/** POST /reviews/ratings-import：浏览器读出文件文本后提交，一行有错整份拒绝。 */
export const RatingsImportBodySchema = z
  .object({
    storeId: StoreId,
    fileName: z.string().trim().min(1, { error: '请填写文件名' }).max(REVIEWS_LIMITS.importFileNameMax),
    content: z.string({ error: '请选择要导入的文件' }).min(1, { error: '文件是空的' }).max(2_000_000, { error: '文件太大，请拆成几份导入' }),
  })
  .strict()
export type RatingsImportBody = z.infer<typeof RatingsImportBodySchema>

/** POST /reviews/solicitations：一个店铺的一批订单（每单只请求一次）。 */
export const SolicitationBatchBodySchema = z
  .object({
    storeId: StoreId,
    orderIds: z
      .array(z.string().trim().min(3).max(40))
      .min(1, { error: '请选择要请求评价的订单' })
      .max(REVIEWS_LIMITS.batchMax, { error: `一次最多请求 ${REVIEWS_LIMITS.batchMax} 个订单` })
      .refine(ids => new Set(ids).size === ids.length, { error: '订单不能重复' }),
  })
  .strict()
export type SolicitationBatchBody = z.infer<typeof SolicitationBatchBodySchema>

export { Asin as ReviewAsinSchema }
