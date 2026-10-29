import { z } from 'zod'
import { FIRST_MILE_METHODS, PRICING_CATEGORIES } from './pricing-calculator.js'
import { pageListQuery } from './query.js'

// 新品定价试算的请求校验（P6-29）。zod 单独成文件，前端页面不要引用这个文件。

const money = (label: string, max: number) =>
  z.coerce
    .number({ error: `请填写${label}` })
    .finite()
    .min(0, { error: `${label}不能为负` })
    .max(max, { error: `${label}过大` })
const size = (label: string) =>
  z.coerce
    .number({ error: `请填写${label}` })
    .finite()
    .gt(0, { error: `${label}必须大于 0` })
    .max(300, { error: `${label}不能超过 300 厘米` })

export const PricingEstimateBodySchema = z
  .object({
    purchaseCost: money('采购成本', 1_000_000),
    firstMile: z
      .object({
        method: z.enum(FIRST_MILE_METHODS, { error: '头程方式不正确' }),
        unitPrice: money('头程单价', 1_000_000).default(0),
      })
      .strict(),
    lengthCm: size('长'),
    widthCm: size('宽'),
    heightCm: size('高'),
    weightG: z.coerce.number({ error: '请填写重量' }).finite().gt(0, { error: '重量必须大于 0' }).max(50_000, { error: '重量不能超过 50 千克' }),
    category: z.enum(PRICING_CATEGORIES, { error: '品类不正确' }),
    prices: z
      .array(money('售价', 100_000).refine(value => value > 0, { error: '售价必须大于 0' }))
      .min(1, { error: '至少填一个售价' })
      .max(8, { error: '一次最多比较 8 个售价' }),
    referenceAsin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{10}$/, { error: '参考 ASIN 是 10 位字母或数字' })
      .optional(),
    storeId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: '店铺编号不正确' })
      .optional(),
  })
  .strict()
export type PricingEstimateBody = z.infer<typeof PricingEstimateBodySchema>

export const PricingSaveBodySchema = z
  .object({
    id: z.string().trim().min(1, { error: '请指定要保存的试算' }).max(64),
    name: z.string().trim().min(1, { error: '名称不能为空' }).max(80, { error: '名称最多 80 个字' }).optional(),
  })
  .strict()
export type PricingSaveBody = z.infer<typeof PricingSaveBodySchema>

export const PricingRecordQuerySchema = pageListQuery({ scope: false, sortable: ['estimatedAt'] as const, defaultSort: { field: 'estimatedAt', dir: 'desc' } })
export type PricingRecordQuery = z.infer<typeof PricingRecordQuerySchema>
