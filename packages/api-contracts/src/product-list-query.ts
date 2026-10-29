import { z } from 'zod'
import { INVENTORY_RISK_LEVELS } from './inventory.js'
import { PRODUCT_CHANNELS, PRODUCT_SORTS, PRODUCT_SYNC_STORE_MAX, PRODUCT_TAG_LIMITS } from './product-list.js'
import { cursorListQuery } from './query.js'

// 商品主数据的请求校验（P4-07）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
// 筛选里没有“是否有刊登问题”“刊登质量分区间”：这两项的数据来源（P4-09、P4-10）还没有，提供了也只会筛出空结果，造成误导。

/** 列表：全局范围参数加筛选；排序字段白名单；`risk` 要求 inventory.read，`watched=true` 只看自己关注的商品。 */
export const ProductListQuerySchema = cursorListQuery({
  sortable: PRODUCT_SORTS,
  defaultSort: { field: 'updatedAt', dir: 'desc' },
  filters: {
    asin: { type: 'text', max: 20 },
    sku: { type: 'text', max: 80 },
    parentAsin: { type: 'text', max: 20 },
    brand: { type: 'text', max: 120 },
    category: { type: 'text', max: 200 },
    status: { type: 'text', max: 40 },
    fulfillment: { type: 'enum', values: PRODUCT_CHANNELS },
    ownerId: { type: 'text', max: 64 },
    tag: { type: 'text', max: PRODUCT_TAG_LIMITS.MAX_LENGTH },
    risk: { type: 'enum', values: INVENTORY_RISK_LEVELS },
    watched: { type: 'bool' },
  },
})
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')
const tagText = z.string().trim().min(1, '标签不能为空').max(PRODUCT_TAG_LIMITS.MAX_LENGTH, `标签最多 ${PRODUCT_TAG_LIMITS.MAX_LENGTH} 个字`)

/** 批量设置标签与负责人：每个商品带版本号（乐观锁），标签有追加、移除、整体替换三种模式；负责人传 null 表示清空。系统内数据，不写亚马逊。 */
export const ProductMetaBatchBodySchema = z
  .object({
    items: z
      .array(z.object({ id: idText, version: z.number().int().min(1) }).strict())
      .min(1, '请至少选择一个商品')
      .max(PRODUCT_TAG_LIMITS.BATCH_MAX, `一次最多处理 ${PRODUCT_TAG_LIMITS.BATCH_MAX} 个商品`),
    tags: z
      .object({ mode: z.enum(['ADD', 'REMOVE', 'SET']), values: z.array(tagText).max(PRODUCT_TAG_LIMITS.MAX_TAGS) })
      .strict()
      .optional(),
    ownerId: idText.nullable().optional(),
  })
  .strict()
  .refine(body => body.tags !== undefined || body.ownerId !== undefined, { message: '请至少修改标签或负责人其中一项' })
export type ProductMetaBatchBody = z.infer<typeof ProductMetaBatchBodySchema>

/** 同步商品目录：按店铺发起（亚马逊商品目录同步是店铺级任务，不是逐个商品）。 */
export const ProductSyncBodySchema = z.object({ storeIds: z.array(idText).min(1, '请至少选择一个店铺').max(PRODUCT_SYNC_STORE_MAX, `一次最多同步 ${PRODUCT_SYNC_STORE_MAX} 个店铺`) }).strict()
export type ProductSyncBody = z.infer<typeof ProductSyncBodySchema>
