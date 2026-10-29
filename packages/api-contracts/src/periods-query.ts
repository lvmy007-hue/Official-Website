import { z } from 'zod'
import { CHECK_ACKNOWLEDGEABLE, PERIOD_NOTE_MAX, PERIOD_STATUSES } from './periods.js'
import { pageListQuery } from './query.js'
import { ReasonBodySchema } from './write.js'

// 期间关账的请求校验（P2b-13）。zod 单独成文件，不进前端首屏。

export const PeriodListQuerySchema = pageListQuery({
  sortable: ['periodStart'] as const,
  defaultSort: { field: 'periodStart', dir: 'desc' },
  filters: { status: { type: 'enum', values: PERIOD_STATUSES } },
})
export type PeriodListQuery = ReturnType<typeof PeriodListQuerySchema.parse>

const version = z.number().int().min(1).max(1_000_000)

/** 创建期间：一个店铺一个自然月（企业数据口径时区的日历月）。 */
export const PeriodCreateBodySchema = z
  .object({
    sellerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '店铺编号不合法'),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
      .refine(value => Number(value.slice(0, 4)) >= 2000, '月份太早'),
  })
  .strict()
export type PeriodCreateBody = z.infer<typeof PeriodCreateBodySchema>

/** 完整性检查：可以顺带对“广告分摊完成”“对账异常”两项确认放行（必须写明原因）。 */
export const PeriodCheckBodySchema = z
  .object({
    acknowledgements: z
      .array(z.object({ key: z.enum(CHECK_ACKNOWLEDGEABLE), note: z.string().trim().min(2, '请写明放行原因').max(PERIOD_NOTE_MAX) }).strict())
      .max(CHECK_ACKNOWLEDGEABLE.length)
      .optional(),
  })
  .strict()
  .refine(value => new Set((value.acknowledgements ?? []).map(item => item.key)).size === (value.acknowledgements ?? []).length, { message: '同一个检查项不能重复确认', path: ['acknowledgements'] })
export type PeriodCheckBody = z.infer<typeof PeriodCheckBodySchema>

export const PeriodApproveBodySchema = z
  .object({
    version,
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().trim().max(PERIOD_NOTE_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECTED' && (value.comment ?? '').length < 2) ctx.addIssue({ code: 'custom', path: ['comment'], message: '驳回必须写明意见' })
  })
export type PeriodApproveBody = z.infer<typeof PeriodApproveBodySchema>

export const PeriodCloseBodySchema = z.object({ version }).strict()
export type PeriodCloseBody = z.infer<typeof PeriodCloseBodySchema>

export const PeriodReopenBodySchema = z.object({ version, reason: ReasonBodySchema.shape.reason }).strict()
export type PeriodReopenBody = z.infer<typeof PeriodReopenBodySchema>
