import { z } from 'zod'
import { COMPETITOR_LIMITS, COMPETITOR_REASONS, COMPETITOR_SORTS } from './competitors.js'
import { COMPETITOR_ASIN_PATTERN, normalizeAsin } from './competitors-math.js'
import { cursorListQuery } from './query.js'

// 竞品监控的请求校验（P4-12）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

const StoreId = z.string().trim().min(1).max(64)
const Asin = z
  .string({ error: 'ASIN 要填文字' })
  .transform(normalizeAsin)
  .refine(value => COMPETITOR_ASIN_PATTERN.test(value), { error: 'ASIN 是 10 位字母或数字，例如 B0ABCDE123' })
const OptionalAsin = z
  .string()
  .transform(normalizeAsin)
  .refine(value => value === '' || COMPETITOR_ASIN_PATTERN.test(value), { error: '我方对应 ASIN 是 10 位字母或数字' })
  .optional()

/** 列表：全局范围参数加来源筛选；排序字段白名单；关键字 q 搜索竞品 ASIN、标题、品牌。 */
export const CompetitorListQuerySchema = cursorListQuery({
  sortable: COMPETITOR_SORTS,
  defaultSort: { field: 'addedAt', dir: 'desc' },
  filters: { reason: { type: 'enum', values: COMPETITOR_REASONS } },
})
export type CompetitorListQuery = z.infer<typeof CompetitorListQuerySchema>

/** 手工添加或从搜索词推荐里加入：竞品 ASIN 与店铺必填，我方对应 ASIN 选填（不填就没有价格差与名次差）。 */
export const CompetitorAddBodySchema = z
  .object({
    storeId: StoreId,
    asin: Asin,
    ownAsin: OptionalAsin,
    reason: z.enum(COMPETITOR_REASONS).default('MANUAL'),
    note: z
      .string()
      .trim()
      .max(COMPETITOR_LIMITS.noteMax, { error: `备注不能超过 ${COMPETITOR_LIMITS.noteMax} 个字` })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ownAsin && value.ownAsin === value.asin) ctx.addIssue({ code: 'custom', message: '竞品不能是我方对应的同一个 ASIN', path: ['asin'] })
  })
export type CompetitorAddBody = z.infer<typeof CompetitorAddBodySchema>

/** 详情：竞品在某个店铺里关注，所以店铺必填；ownAsin 选填，指定要对照的我方商品；days 是趋势回看天数。 */
export const CompetitorDetailQuerySchema = z
  .object({
    storeId: StoreId,
    ownAsin: OptionalAsin,
    days: z.coerce.number().int().min(7).max(COMPETITOR_LIMITS.trendDaysMax).default(COMPETITOR_LIMITS.trendDays),
  })
  .strict()
export type CompetitorDetailQuery = z.infer<typeof CompetitorDetailQuerySchema>

/** 移除关注：只带店铺与我方对应 ASIN（不填就是移除没有指定对应商品的那一条）。 */
export const CompetitorRemoveQuerySchema = z.object({ storeId: StoreId, ownAsin: OptionalAsin }).strict()
export type CompetitorRemoveQuery = z.infer<typeof CompetitorRemoveQuerySchema>
