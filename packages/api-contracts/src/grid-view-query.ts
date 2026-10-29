import { z } from 'zod'
import { GRID_ID_PATTERN, GRID_VIEW_KINDS, GRID_VIEW_NAME_MAX, viewConfigOf } from './grid-view.js'

// 表格视图的请求校验（P6-03）。带 zod，前端不引用（前端只取 grid-view.ts 的类型与纯函数）。

const gridId = z.string().regex(GRID_ID_PATTERN, { error: '表格标识不合法' })
/** 请求里的视图内容只要是对象且不过大；内部结构交给 viewConfigOf 整理，不认识的键被丢弃。 */
const CONFIG_MAX_JSON = 20_000
const config = z
  .record(z.string(), z.unknown(), { error: '视图内容必须是对象' })
  .refine(value => JSON.stringify(value).length <= CONFIG_MAX_JSON, { error: '视图内容过大' })
  .transform(value => viewConfigOf(value))
const name = z
  .string({ error: '请填写视图名称' })
  .trim()
  .min(1, { error: '请填写视图名称' })
  .max(GRID_VIEW_NAME_MAX, { error: `视图名称最多 ${GRID_VIEW_NAME_MAX} 个字` })

export const GridViewListQuerySchema = z.object({ gridId, kind: z.enum(GRID_VIEW_KINDS).default('VIEW') })

export const GridViewCreateBodySchema = z.object({
  gridId,
  kind: z.enum(GRID_VIEW_KINDS).default('VIEW'),
  name,
  /** 个人视图或团队共享视图；系统视图只能由迁移或系统任务写入。 */
  scope: z.enum(['USER', 'TEAM']).default('USER'),
  config,
  isDefault: z.boolean().default(false),
})

export const GridViewUpdateBodySchema = z.object({
  version: z.number().int().min(1),
  name: name.optional(),
  config: config.optional(),
})

export type GridViewCreateBody = z.infer<typeof GridViewCreateBodySchema>
export type GridViewUpdateBody = z.infer<typeof GridViewUpdateBodySchema>
