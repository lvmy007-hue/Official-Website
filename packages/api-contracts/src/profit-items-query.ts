import { z } from 'zod'
import { PROFIT_ITEM_GROUPS, PROFIT_ITEM_LIMITS } from './profit-items.js'
import { pageListQuery } from './query.js'

// 利润项目字典的请求校验（P6-18）。单独成文件：zod 构造是顶层调用，前端不引用。

export const ProfitUnmappedQuerySchema = pageListQuery({ scope: false, sortable: ['txCount30d'] as const, defaultSort: { field: 'txCount30d', dir: 'desc' } })
export type ProfitUnmappedQuery = z.infer<typeof ProfitUnmappedQuerySchema>

/** 整树保存：items 是全部项目（含系统项目；缺少的自定义项目视为删除），mappings 是全部映射（缺少的交易类型视为未映射）；version 是打开页面时看到的字典版本。 */
export const ProfitItemTreeBodySchema = z
  .object({
    version: z.number({ error: '保存必须带上打开页面时的字典版本 version' }).int().min(1),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            parentId: z.string().min(1).max(64).nullable(),
            name: z
              .string({ error: '请填写项目名称' })
              .trim()
              .min(1, { error: '请填写项目名称' })
              .max(PROFIT_ITEM_LIMITS.nameMax, { error: `项目名称最多 ${PROFIT_ITEM_LIMITS.nameMax} 个字` }),
            group: z.enum(PROFIT_ITEM_GROUPS).optional(),
            sign: z.union([z.literal(1), z.literal(-1)]).optional(),
            sort: z.number().int().min(0).max(9999),
          })
          .strict(),
      )
      .min(1)
      .max(PROFIT_ITEM_LIMITS.maxItems),
    mappings: z.array(z.object({ transactionType: z.string().trim().min(1).max(200), itemId: z.string().min(1).max(64) }).strict()).max(PROFIT_ITEM_LIMITS.maxMappings),
  })
  .strict()
export type ProfitItemTreeBody = z.infer<typeof ProfitItemTreeBodySchema>
