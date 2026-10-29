import { z } from 'zod'
import { SNS_ASIN_SORTS, SNS_ELIGIBILITIES, SNS_OFFER_SORTS } from './subscribe-save.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 订阅省两个明细列表的请求校验（P4-06）。全局范围参数（店铺等）由 ScopeSearchSchema 校验，这里只校验本页自己的参数。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。
// 明细来自“每个店铺最近一次报价快照”，在内存里筛选、排序后按位置切页（游标里放已翻过的位置，服务端签名并绑定查询条件）。

const search = z.string().trim().min(1).max(120).optional()

export const SnsAsinListQuerySchema = z.object({
  q: search,
  sort: sortSchema(SNS_ASIN_SORTS, { field: 'forecastNext30', dir: 'desc' }),
  ...CursorParamsSchema.shape,
})
export type SnsAsinListQuery = z.infer<typeof SnsAsinListQuerySchema>

export const SnsOfferListQuerySchema = z.object({
  q: search,
  eligibility: z.enum(SNS_ELIGIBILITIES, { error: '可订阅状态只能是 ELIGIBLE、INELIGIBLE、SUSPENDED' }).optional(),
  sort: sortSchema(SNS_OFFER_SORTS, { field: 'forecastNext30', dir: 'desc' }),
  ...CursorParamsSchema.shape,
})
export type SnsOfferListQuery = z.infer<typeof SnsOfferListQuerySchema>
