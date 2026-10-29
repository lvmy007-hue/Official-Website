import { z } from 'zod'
import { HIJACK_LIMITS, HIJACK_SELLER_ID_PATTERN, HIJACK_STATUSES, HIJACK_WHITELIST_MODES } from './hijack.js'
import { STACKING_DEFAULTS, STACKING_LIMITS } from './promo-stacking.js'
import { cursorListQuery, pageListQuery } from './query.js'

// 跟卖监控与促销叠加的请求校验（P6-17）。单独成文件：zod 构造是顶层调用，前端不引用。

/** 跟卖列表：默认只看“仍在报价”且“不含白名单”；q 匹配 SKU 或 ASIN（包含，不区分大小写）。 */
export const HijackListQuerySchema = cursorListQuery({
  sortable: ['firstSeenAt', 'lastSeenAt', 'price'] as const,
  defaultSort: { field: 'firstSeenAt', dir: 'desc' },
  filters: { status: { type: 'enum', values: HIJACK_STATUSES }, whitelist: { type: 'enum', values: HIJACK_WHITELIST_MODES } },
})
export type HijackListQuery = z.infer<typeof HijackListQuerySchema>

export const HijackWhitelistQuerySchema = pageListQuery({ scope: false, sortable: ['createdAt'] as const, defaultSort: { field: 'createdAt', dir: 'desc' } })
export type HijackWhitelistQuery = z.infer<typeof HijackWhitelistQuerySchema>

/** 新增白名单：卖家编号大写字母与数字（输入时自动去空白、转大写）；备注可选。 */
export const HijackWhitelistBodySchema = z
  .object({
    sellerId: z
      .string({ error: '请填写卖家编号' })
      .trim()
      .toUpperCase()
      .regex(HIJACK_SELLER_ID_PATTERN, { error: `卖家编号是 ${HIJACK_LIMITS.sellerIdMin} 到 ${HIJACK_LIMITS.sellerIdMax} 位的大写字母或数字，例如 A1B2C3D4E5F6G7` }),
    note: z
      .string()
      .trim()
      .max(HIJACK_LIMITS.noteMax, { error: `备注最多 ${HIJACK_LIMITS.noteMax} 个字符` })
      .optional()
      .transform(value => (value ? value : undefined)),
  })
  .strict()
export type HijackWhitelistBody = z.infer<typeof HijackWhitelistBodySchema>

/**
 * 促销叠加列表：flag 选快捷筛选卡（stacked 叠加数达到下限、deep 折扣深度达到下限、any 两者之一）；
 * 不传 flag 列出全部有叠加或有深度数据的 ASIN。minStack、minDepth 缺省取默认阈值（与叠加预警的默认值一致）。
 */
export const StackingQuerySchema = cursorListQuery({
  sortable: ['peakCount', 'depth'] as const,
  defaultSort: { field: 'peakCount', dir: 'desc' },
  filters: {
    flag: { type: 'enum', values: ['stacked', 'deep', 'any'] },
    minStack: { type: 'number', min: 2, max: STACKING_LIMITS.minStackMax },
    minDepth: { type: 'number', min: 0.01, max: 0.95 },
  },
})
export type StackingQuery = z.infer<typeof StackingQuerySchema>
export const stackingThresholds = (query: Pick<StackingQuery, 'minStack' | 'minDepth'>) => ({
  minStack: query.minStack ?? STACKING_DEFAULTS.minStack,
  minDepthPct: query.minDepth ?? STACKING_DEFAULTS.minDepthPct,
})
