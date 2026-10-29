import { z } from 'zod'
import { LISTING_IMPACTS, LISTING_ISSUE_STATUS_FILTERS, LISTING_QUALITY_TABS, LISTING_SEVERITIES } from './listing-quality.js'
import { LISTING_WRITE_LIMITS, listingPatchesIssue, type ListingPatchInput } from './listing-quality-write.js'
import { cursorListQuery } from './query.js'

// 刊登质量与合规的请求校验（P4-10）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

export const LISTING_QUALITY_SORTS = ['firstSeen', 'lastSeen', 'severity', 'sku'] as const

/** 列表：全局范围参数加页签与筛选。tab 缺省是“问题项”；状态缺省是“未解决”（新增 + 处理中）。 */
export const ListingQualityQuerySchema = cursorListQuery({
  sortable: LISTING_QUALITY_SORTS,
  defaultSort: { field: 'firstSeen', dir: 'desc' },
  filters: {
    tab: { type: 'enum', values: LISTING_QUALITY_TABS },
    severity: { type: 'enum', values: LISTING_SEVERITIES },
    status: { type: 'enum', values: LISTING_ISSUE_STATUS_FILTERS },
    impact: { type: 'enum', values: LISTING_IMPACTS },
    ownerId: { type: 'text', max: 64 },
  },
})
export type ListingQualityQuery = z.infer<typeof ListingQualityQuerySchema>

const PatchSchema = z
  .object({
    op: z.enum(['replace', 'delete']),
    attribute: z.string().trim().min(1).max(LISTING_WRITE_LIMITS.attributeMax),
    values: z
      .array(z.string().max(LISTING_WRITE_LIMITS.valueMax + 1))
      .max(LISTING_WRITE_LIMITS.valuesMax + 1)
      .optional(),
    languageTag: z
      .string()
      .regex(/^[a-z]{2}_[A-Z]{2}$/, { error: '语言标记形如 en_US' })
      .optional(),
  })
  .strict()

const SkuSchema = z.string().trim().min(1).max(LISTING_WRITE_LIMITS.skuMax)
const PatchesSchema = z.array(PatchSchema).min(1).max(LISTING_WRITE_LIMITS.patchesMax)
const ProductTypeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/, { error: '商品类型是大写字母、数字与下划线，例如 LUGGAGE' })
  .optional()

const checkPatches = (patches: ListingPatchInput[], ctx: z.RefinementCtx, path: Array<string | number>) => {
  const issue = listingPatchesIssue(patches)
  if (issue) ctx.addIssue({ code: 'custom', message: issue, path })
}

/** 校验预览：对一个商品的一组修改调用刊登接口的校验预览模式（不会真的修改）。 */
export const ListingValidateBodySchema = z
  .object({ storeId: z.string().trim().min(1).max(64), sku: SkuSchema, productType: ProductTypeSchema, patches: PatchesSchema })
  .strict()
  .superRefine((value, ctx) => checkPatches(value.patches, ctx, ['patches']))
export type ListingValidateBody = z.infer<typeof ListingValidateBodySchema>

/** 修改刊登：必须带上一步校验通过的预览编号，修改内容要与校验过的一致。 */
export const ListingPatchBodySchema = z
  .object({ storeId: z.string().trim().min(1).max(64), sku: SkuSchema, productType: ProductTypeSchema, patches: PatchesSchema, previewRunId: z.string().trim().min(1).max(64) })
  .strict()
  .superRefine((value, ctx) => checkPatches(value.patches, ctx, ['patches']))
export type ListingPatchBody = z.infer<typeof ListingPatchBodySchema>

/** 批量刊登任务：每个商品一组修改，整体交给 Feeds API。 */
export const ListingBatchBodySchema = z
  .object({
    storeId: z.string().trim().min(1).max(64),
    items: z
      .array(z.object({ sku: SkuSchema, patches: PatchesSchema }).strict())
      .min(1)
      .max(LISTING_WRITE_LIMITS.batchItemsMax),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, item] of value.items.entries()) {
      if (seen.has(item.sku)) ctx.addIssue({ code: 'custom', message: `SKU「${item.sku}」重复出现`, path: ['items', index, 'sku'] })
      seen.add(item.sku)
      checkPatches(item.patches, ctx, ['items', index, 'patches'])
    }
  })
export type ListingBatchBody = z.infer<typeof ListingBatchBodySchema>

/** 刊登限制查询：一次最多 20 个 ASIN。 */
export const ListingRestrictionsBodySchema = z
  .object({
    storeId: z.string().trim().min(1).max(64),
    asins: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9]{10}$/, { error: 'ASIN 是 10 位字母或数字' }),
      )
      .min(1)
      .max(LISTING_WRITE_LIMITS.restrictionsAsinsMax),
    conditionType: z.enum(['new_new', 'new_open_box', 'used_like_new', 'used_very_good', 'used_good', 'used_acceptable']).default('new_new'),
  })
  .strict()
export type ListingRestrictionsBody = z.infer<typeof ListingRestrictionsBodySchema>

export const ListingRunListQuerySchema = z.object({ kind: z.enum(['VALIDATE', 'PATCH', 'BATCH', 'RESTRICTIONS']).optional() }).strict()
