import { z } from 'zod'
import { PROFIT_BASES } from './profit.js'
import { COMPARE_FILTERS, COMPARE_SORTS, ECONOMICS_SIM_ACTIONS, ECONOMICS_SIM_MAX_DAYS, ECONOMICS_SIM_MAX_PRICE, ECONOMICS_SIM_MAX_QUANTITY } from './economics.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 官方经济数据对账页的请求校验（P2b-11）。全局范围参数（店铺、日期）由 ScopeSearchSchema 校验，这里只校验本页自己的参数。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

const recognition = z.enum(PROFIT_BASES, { error: '收入确认口径只能是 ORDERED、SHIPPED、SETTLED' }).default('ORDERED')
const search = z.string().trim().min(1).max(120).optional()

/** 双源核对：我方取哪种收入确认口径、结论过滤、搜索、排序、游标分页。 */
export const EconomicsCompareQuerySchema = z.object({
  recognition,
  verdict: z.enum(COMPARE_FILTERS, { error: `结论过滤只能是 ${COMPARE_FILTERS.join('、')}` }).default('ALL'),
  q: search,
  sort: sortSchema(COMPARE_SORTS, { field: 'diff', dir: 'desc' }),
  ...CursorParamsSchema.shape,
})
export type EconomicsCompareQuery = z.infer<typeof EconomicsCompareQuerySchema>

/** 费用预览：只看有费用调整的行、按费用类型过滤、搜索、游标分页。 */
export const EconomicsPreviewQuerySchema = z.object({
  changedOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
  feeType: z.string().trim().min(1).max(120).optional(),
  q: search,
  ...CursorParamsSchema.shape,
})
export type EconomicsPreviewQuery = z.infer<typeof EconomicsPreviewQuerySchema>

/** 发起情景模拟：原包装发货（SIPP）不需要数量；发往上游仓储（AWD）必须给数量；单价不填用商品当前价格。 */
export const EconomicsSimulateBodySchema = z
  .object({
    sellerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '店铺编号不合法'),
    sku: z.string().trim().min(1, '请输入 SKU').max(200),
    actionType: z.enum(ECONOMICS_SIM_ACTIONS, { error: `动作只能是 ${ECONOMICS_SIM_ACTIONS.join('、')}` }),
    quantity: z.number().int('数量必须是整数').min(1, '数量至少为 1').max(ECONOMICS_SIM_MAX_QUANTITY).optional(),
    itemPrice: z.number().positive('单价必须大于 0').max(ECONOMICS_SIM_MAX_PRICE).multipleOf(0.01, '单价最多两位小数').optional(),
    endInDays: z.number().int().min(1).max(ECONOMICS_SIM_MAX_DAYS).default(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actionType === 'AWD' && value.quantity === undefined) ctx.addIssue({ code: 'custom', path: ['quantity'], message: '发往上游仓储的模拟需要填写数量' })
    if (value.actionType === 'SIPP' && value.quantity !== undefined) ctx.addIssue({ code: 'custom', path: ['quantity'], message: '原包装发货的模拟不需要数量' })
  })
export type EconomicsSimulateBody = z.infer<typeof EconomicsSimulateBodySchema>
