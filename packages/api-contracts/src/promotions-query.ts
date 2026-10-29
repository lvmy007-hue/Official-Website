import { PROMOTION_STATUSES, PROMOTION_TYPES } from './promotions.js'
import { cursorListQuery } from './query.js'

// 促销列表的请求校验（P4-05）。单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。
// 搜索词 q 匹配促销标题（包含）或促销编号（开头）；日期范围（全局范围参数 from / to）按“活动开始日”过滤；默认按开始时间新到旧，不设默认日期范围（促销总量小）。
export const PromotionListQuerySchema = cursorListQuery({
  sortable: ['startAt'],
  defaultSort: { field: 'startAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: PROMOTION_STATUSES }, type: { type: 'enum', values: PROMOTION_TYPES } },
})
export type PromotionListQuery = ReturnType<typeof PromotionListQuerySchema.parse>
