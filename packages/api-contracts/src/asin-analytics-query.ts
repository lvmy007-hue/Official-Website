import { z } from 'zod'
import { ASIN_COMPARE_MAX, ASIN_ISSUE_OPTIONS, MATRIX_METRICS, type AsinSelectRef } from './asin-analytics.js'
import { INVENTORY_RISK_LEVELS } from './inventory.js'
import { CursorParamsSchema } from './query.js'

// ASIN 与父体分析的请求校验（P4-03）。全局范围参数（店铺、日期、对比期）由 ScopeSearchSchema 校验，这里只校验本页自己的参数。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

export const ASIN_PATTERN = /^[A-Za-z0-9]{10}$/
const asinText = z
  .string()
  .trim()
  .regex(ASIN_PATTERN, { error: 'ASIN 应为 10 位字母或数字' })
  .transform(value => value.toUpperCase())

/** 父体编号路径参数。 */
export const ParentAsinParamSchema = asinText

const word = z.string().trim().min(1).max(120)

/** `select=parent:B0AAAAAAAA,asin:B0BBBBBBBB`：最多 5 个，不重复。 */
function parseSelect(raw: string, ctx: z.RefinementCtx): AsinSelectRef[] {
  const refs: AsinSelectRef[] = []
  for (const part of raw.split(',')) {
    const [kind, asin, ...rest] = part.trim().split(':')
    const parsed = asinText.safeParse(asin ?? '')
    if ((kind !== 'parent' && kind !== 'asin') || rest.length > 0 || !parsed.success) {
      ctx.addIssue({ code: 'custom', message: '选中对象的格式应为“parent:ASIN”或“asin:ASIN”，多个用逗号分隔' })
      return []
    }
    if (!refs.some(ref => ref.kind === kind && ref.asin === parsed.data)) refs.push({ kind, asin: parsed.data })
  }
  if (refs.length > ASIN_COMPARE_MAX) {
    ctx.addIssue({ code: 'custom', message: `对比模式最多同时选 ${ASIN_COMPARE_MAX} 个对象` })
    return []
  }
  return refs
}

export const AsinAnalyticsQuerySchema = z.object({
  select: z
    .string()
    .max(200)
    .optional()
    .transform((raw, ctx) => (raw ? parseSelect(raw, ctx) : [])),
  q: word.optional(),
  brand: word.optional(),
  category: word.optional(),
  tag: word.optional(),
  owner: word.optional(),
  risk: z.enum(INVENTORY_RISK_LEVELS, { error: '库存风险只能是 HIGH、MEDIUM、NORMAL、EXCESS' }).optional(),
  issue: z.enum(ASIN_ISSUE_OPTIONS.map(option => option.value) as [string, ...string[]], { error: '刊登问题只能是 INACTIVE、NOT_FOUND' }).optional(),
  ...CursorParamsSchema.shape,
})
export type AsinAnalyticsQuery = z.infer<typeof AsinAnalyticsQuerySchema>

/** 子体贡献矩阵：着色指标与透视维度（`pivot=color,size`，两个不同的维度名；不给就取目录里出现最多的两个）。 */
export const ParentMatrixQuerySchema = z.object({
  metric: z.enum(MATRIX_METRICS, { error: '指标只能是 sales、conversion、risk' }).default('sales'),
  pivot: z
    .string()
    .max(80)
    .optional()
    .transform((raw, ctx): [string, string] | null => {
      if (!raw) return null
      const parts = raw.split(',').map(part => part.trim().toLowerCase())
      if (parts.length !== 2 || parts.some(part => !/^[a-z0-9_]{1,40}$/.test(part)) || parts[0] === parts[1]) {
        ctx.addIssue({ code: 'custom', message: '透视维度应写成“维度一,维度二”，两个不同的名称' })
        return null
      }
      return [parts[0]!, parts[1]!]
    }),
})
export type ParentMatrixQuery = z.infer<typeof ParentMatrixQuerySchema>

/** 变更历史：游标分页。 */
export const ParentChangesQuerySchema = z.object({ ...CursorParamsSchema.shape })
export type ParentChangesQuery = z.infer<typeof ParentChangesQuerySchema>
