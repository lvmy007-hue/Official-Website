import { z } from 'zod'
import { ALLOCATION_BASES, FX_RATE_RULES } from './finance-policy.js'
import { INVENTORY_COSTINGS, PROFIT_BASES } from './profit.js'

// 财务口径设置的请求校验（P2b-15）。zod 单独成文件，不进前端首屏。

const dayText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01'
  }, '日期不合法')

/** 提交一份口径修改；version 是客户端看到的“最新版本号”（还没有任何版本为 0），用来防止两人同时改。 */
export const FinancePolicySubmitBodySchema = z.object({
  version: z.number().int().min(0).max(1_000_000),
  effectiveFrom: dayText,
  revenueRecognition: z.enum(PROFIT_BASES, { error: '收入确认口径取值不合法' }),
  inventoryCostMethod: z.enum(INVENTORY_COSTINGS, { error: '存货计价方法取值不合法' }),
  fxRateRule: z.enum(FX_RATE_RULES).default('SALE_DAY'),
  adsAllocationMode: z.enum(ALLOCATION_BASES, { error: '广告分摊规则取值不合法' }),
  storeFeeAllocation: z.enum(ALLOCATION_BASES, { error: '店铺级费用分摊规则取值不合法' }),
  reason: z.string().trim().min(2, '请填写修改原因（至少 2 个字）').max(500, '修改原因最多 500 字'),
})
export type FinancePolicySubmitBody = z.infer<typeof FinancePolicySubmitBodySchema>

/** 审批：通过或驳回（发起人自己驳回算撤回）；驳回必须写意见；version 是该版本行的乐观锁版本号。 */
export const FinancePolicyApprovalBodySchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().trim().max(500, '意见最多 500 字').default(''),
    version: z.number().int().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECTED' && value.comment.length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '驳回或撤回请写明原因（至少 2 个字）' })
  })
export type FinancePolicyApprovalBody = z.infer<typeof FinancePolicyApprovalBodySchema>

export const FinancePolicyVersionParamSchema = z.coerce.number().int().min(1).max(1_000_000)
