import { z } from 'zod'
import { ALLOCATION_RULE_BASES, ALLOCATION_RULE_LIMITS, isMonthText } from './allocation-rules.js'
import { pageListQuery } from './query.js'

// 费用分摊规则的请求校验（P6-19）。单独成文件：zod 构造是顶层调用，前端不引用。

export const AllocationRulesQuerySchema = pageListQuery({ scope: false, sortable: ['effectiveMonth', 'feeItem'] as const, defaultSort: { field: 'effectiveMonth', dir: 'desc' } })
export type AllocationRulesQuery = z.infer<typeof AllocationRulesQuerySchema>

const monthField = z.string({ error: '请选择生效月份' }).trim().refine(isMonthText, { error: '月份格式应为 YYYY-MM' })

const basisField = z.enum(ALLOCATION_RULE_BASES, { error: '分摊依据取值不合法' })

/** 手动比例：{ SKU: 权重 }，权重为正数，至少一个 SKU。 */
export const ManualWeightsSchema = z
  .record(z.string().trim().min(1, { error: 'SKU 不能为空' }).max(120), z.number({ error: '权重必须是数字' }).positive({ error: '权重必须大于 0' }).max(ALLOCATION_RULE_LIMITS.weightMax))
  .refine(value => Object.keys(value).length >= 1, { error: '手动比例至少填写一个 SKU' })
  .refine(value => Object.keys(value).length <= ALLOCATION_RULE_LIMITS.manualSkuMax, { error: `手动比例最多 ${ALLOCATION_RULE_LIMITS.manualSkuMax} 个 SKU` })

const ruleShape = {
  feeItemId: z.string({ error: '请选择费用项' }).min(1, { error: '请选择费用项' }).max(64),
  basis: basisField,
  manualWeights: ManualWeightsSchema.nullish(),
}

function checkManual(value: { basis: string; manualWeights?: Record<string, number> | null }, ctx: z.RefinementCtx) {
  if (value.basis === 'MANUAL' && !value.manualWeights) ctx.addIssue({ code: 'custom', path: ['manualWeights'], message: '手动比例必须填写各 SKU 的权重' })
  if (value.basis !== 'MANUAL' && value.manualWeights) ctx.addIssue({ code: 'custom', path: ['manualWeights'], message: '只有“手动比例”才填写权重' })
}

export const AllocationRuleCreateBodySchema = z
  .object({ ...ruleShape, effectiveMonth: monthField })
  .strict()
  .superRefine(checkManual)
export type AllocationRuleCreateBody = z.infer<typeof AllocationRuleCreateBodySchema>

/** 修改：带 id 与打开页面时看到的版本号（乐观锁）；费用项与生效月不能改（要换就新建一条）。 */
export const AllocationRuleUpdateBodySchema = z
  .object({
    id: z.string({ error: '缺少规则编号 id' }).min(1).max(64),
    version: z.number({ error: '修改必须带上打开页面时的版本 version' }).int().min(1),
    basis: basisField,
    manualWeights: ManualWeightsSchema.nullish(),
  })
  .strict()
  .superRefine(checkManual)
export type AllocationRuleUpdateBody = z.infer<typeof AllocationRuleUpdateBodySchema>

/** 预览：某个月按某条（尚未保存的）规则分摊的结果与差异；不落库。 */
export const AllocationPreviewBodySchema = z
  .object({
    month: monthField,
    rule: z.object(ruleShape).strict().superRefine(checkManual),
  })
  .strict()
export type AllocationPreviewBody = z.infer<typeof AllocationPreviewBodySchema>
