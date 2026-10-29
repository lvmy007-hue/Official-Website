import { z } from 'zod'
import { ESTIMATED_FEE_LIMITS, ESTIMATED_MODES, ESTIMATED_PERIODS, ESTIMATED_SCOPE_TYPES, ESTIMATED_STATUSES, isDayText } from './estimated-fees.js'
import { pageListQuery } from './query.js'

// 预估与自定义费用的请求校验（P6-20）。单独成文件：zod 构造是顶层调用，前端不引用。

export const EstimatedFeesQuerySchema = pageListQuery({
  scope: false,
  sortable: ['from', 'item', 'value', 'updatedAt'] as const,
  defaultSort: { field: 'from', dir: 'desc' },
  filters: {
    scopeType: { type: 'enum', values: ESTIMATED_SCOPE_TYPES },
    mode: { type: 'enum', values: ESTIMATED_MODES },
    status: { type: 'enum', values: ESTIMATED_STATUSES },
  },
})
export type EstimatedFeesQuery = z.infer<typeof EstimatedFeesQuerySchema>

const day = (label: string) =>
  z
    .string({ error: `请填写${label}` })
    .trim()
    .refine(isDayText, { error: `${label}的格式应为 YYYY-MM-DD，且日期要存在` })

const shape = {
  itemId: z.string({ error: '请选择费用项' }).min(1, { error: '请选择费用项' }).max(64),
  scopeType: z.enum(ESTIMATED_SCOPE_TYPES, { error: '范围取值不合法' }),
  scopeId: z.string({ error: '请填写范围对象' }).trim().min(1, { error: '请填写范围对象' }).max(ESTIMATED_FEE_LIMITS.scopeIdMax),
  mode: z.enum(ESTIMATED_MODES, { error: '方式取值不合法' }),
  value: z.number({ error: '金额或比例必须是数字' }).max(ESTIMATED_FEE_LIMITS.valueMax, { error: '金额或比例太大' }),
  period: z.enum(ESTIMATED_PERIODS, { error: '周期取值不合法' }),
  from: day('起始日'),
  to: day('截止日').nullish(),
  status: z.enum(ESTIMATED_STATUSES, { error: '状态取值不合法' }).default('ACTIVE'),
  note: z.string().trim().max(ESTIMATED_FEE_LIMITS.noteMax).nullish(),
}

type Checked = { mode: string; value: number; from: string; to?: string | null }

/** 金额必须大于 0，比例在 0 到 100 之间（不含 0），截止日不早于起始日。 */
export function checkEstimatedFee(value: Checked, ctx: z.RefinementCtx) {
  if (!(value.value > 0)) ctx.addIssue({ code: 'custom', path: ['value'], message: '金额或比例必须大于 0' })
  else if (value.mode === 'PERCENT_OF_SALES' && value.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: '销售额比例不能超过 100' })
  if (value.to && value.to < value.from) ctx.addIssue({ code: 'custom', path: ['to'], message: '截止日不能早于起始日' })
}

export const EstimatedFeeCreateBodySchema = z.object(shape).strict().superRefine(checkEstimatedFee)
export type EstimatedFeeCreateBody = z.infer<typeof EstimatedFeeCreateBodySchema>

/** 修改：带 id 与打开页面时看到的版本号（乐观锁），其余字段整条覆盖。 */
export const EstimatedFeeUpdateBodySchema = z
  .object({ id: z.string({ error: '缺少编号 id' }).min(1).max(64), version: z.number({ error: '修改必须带上打开页面时的版本 version' }).int().min(1), ...shape })
  .strict()
  .superRefine(checkEstimatedFee)
export type EstimatedFeeUpdateBody = z.infer<typeof EstimatedFeeUpdateBodySchema>

/** 删除：id 与版本号走查询参数（DELETE 不带请求体）。 */
export const EstimatedFeeDeleteQuerySchema = z.object({ id: z.string({ error: '缺少编号 id' }).min(1).max(64), version: z.coerce.number({ error: '删除必须带上版本 version' }).int().min(1) }).strict()
export type EstimatedFeeDeleteQuery = z.infer<typeof EstimatedFeeDeleteQuerySchema>

export const EstimatedFeeImportBodySchema = z
  .object({ fileName: z.string().trim().min(1, '缺少文件名').max(200), content: z.string().min(1, '文件内容为空').max(ESTIMATED_FEE_LIMITS.importMaxChars, '文件过大（上限约 400 KB）') })
  .strict()
export type EstimatedFeeImportBody = z.infer<typeof EstimatedFeeImportBodySchema>
