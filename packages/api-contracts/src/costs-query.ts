import { z } from 'zod'
import { COST_ACTIVATE_MAX, COST_COVERAGES, COST_IMPORT_MAX_BYTES, COST_NOTE_MAX, COST_SKU_MAX } from './costs.js'
import { cursorListQuery } from './query.js'

// 商品成本的请求校验（P2b-14）。zod 单独成文件，不进前端首屏。

export const CostListQuerySchema = cursorListQuery({
  sortable: ['sku'] as const,
  defaultSort: { field: 'sku', dir: 'asc' },
  filters: { coverage: { type: 'enum', values: COST_COVERAGES }, draft: { type: 'bool' } },
})
export type CostListQuery = ReturnType<typeof CostListQuerySchema.parse>

const version = z.number().int().min(1).max(1_000_000)
const dayText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01'
  }, '日期不合法')
/** 单价：非负、最多 6 位小数（与数据库 DECIMAL(20,6) 一致）、不超过 10 亿。 */
const amount = z
  .number({ error: issue => (issue.input === undefined ? undefined : '请填写数字') })
  .min(0, '成本不能为负')
  .max(1_000_000_000, '数值太大')
  .refine(value => /^\d+(\.\d{1,6})?$/.test(String(value)), '最多 6 位小数')
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种应为 3 位字母代码')
const skuText = z.string().trim().min(1, '请填写 SKU').max(COST_SKU_MAX)
const noteText = z.string().trim().max(COST_NOTE_MAX, `备注最多 ${COST_NOTE_MAX} 字`)

const costFields = {
  unitProductCost: amount.nullable().optional(),
  unitFirstMileCost: amount.nullable().optional(),
  unitDutyCost: amount.nullable().optional(),
  unitOtherCost: amount.nullable().optional(),
}
const hasAnyCost = (value: Partial<Record<keyof typeof costFields, number | null | undefined>>) => Object.keys(costFields).some(key => typeof value[key as keyof typeof costFields] === 'number')

/** 录入一个手工版本（草稿）；activate 为真时同一步确认生效。成本四项至少填一项。 */
export const CostVersionCreateBodySchema = z
  .object({ sku: skuText, effectiveFrom: dayText, currency, ...costFields, note: noteText.optional(), activate: z.boolean().optional() })
  .strict()
  .refine(hasAnyCost, { message: '采购单价、头程分摊、关税、其他成本至少填一项', path: ['unitProductCost'] })
export type CostVersionCreateBody = z.infer<typeof CostVersionCreateBodySchema>

/** 改草稿：带草稿的版本号；没写的字段不动，写 null 是清空这一项。系统生成的草稿只允许改关税、其他成本、生效日与备注（服务端再校验）。 */
export const CostVersionUpdateBodySchema = z
  .object({ version, effectiveFrom: dayText.optional(), currency: currency.optional(), ...costFields, note: noteText.nullable().optional() })
  .strict()
  .refine(value => Object.keys(value).some(key => key !== 'version'), { message: '没有要修改的内容', path: ['effectiveFrom'] })
export type CostVersionUpdateBody = z.infer<typeof CostVersionUpdateBodySchema>

/** 批量确认生效：一次最多 COST_ACTIVATE_MAX 个，全部成功或全部不生效。 */
export const CostActivateBodySchema = z
  .object({
    items: z
      .array(z.object({ id: z.string().min(1).max(64), version }).strict())
      .min(1, '请选择要生效的版本')
      .max(COST_ACTIVATE_MAX, `一次最多确认 ${COST_ACTIVATE_MAX} 个版本`),
  })
  .strict()
  .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, { message: '同一个版本不能重复选择', path: ['items'] })
export type CostActivateBody = z.infer<typeof CostActivateBodySchema>

export const CostDiscardQuerySchema = z.object({ version: z.coerce.number().int().min(1).max(1_000_000) }).strict()

export const CostCompareQuerySchema = z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) }).strict()

/** 文件导入：浏览器读出 CSV 文本后提交，服务端逐行校验，全部通过才写入（一行有错整份拒绝）。 */
export const CostImportBodySchema = z
  .object({
    fileName: z.string().trim().min(1, '缺少文件名').max(200),
    content: z.string().min(1, '文件内容为空').max(COST_IMPORT_MAX_BYTES, '文件过大（上限约 200 KB）'),
  })
  .strict()
export type CostImportBody = z.infer<typeof CostImportBodySchema>
