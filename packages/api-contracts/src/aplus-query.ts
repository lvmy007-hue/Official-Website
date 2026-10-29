import { z } from 'zod'
import { APLUS_ASIN_PATTERN, APLUS_CONTENT_TYPES, APLUS_LIMITS, APLUS_LOCALES, APLUS_SORTS, APLUS_STATUSES, APLUS_UPLOAD_TYPES } from './aplus.js'
import { APLUS_TEXT_LIMITS } from './aplus-modules.js'
import { cursorListQuery } from './query.js'

// A+ 内容的请求校验（P4-14）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

const StoreId = z.string().trim().min(1).max(64)
const Version = z.number({ error: '缺少版本号，请刷新页面后重试' }).int().min(1)

const Asin = z
  .string({ error: 'ASIN 要填文字' })
  .transform(value => value.trim().toUpperCase())
  .refine(value => APLUS_ASIN_PATTERN.test(value), { error: 'ASIN 是 10 位字母或数字，例如 B0ABCDE123' })

const Headline = z.string().max(APLUS_TEXT_LIMITS.headline)
const Body = z.string().max(APLUS_TEXT_LIMITS.body)
const Image = z.object({ uploadDestinationId: z.string().trim().min(1).max(200), altText: z.string().max(APLUS_TEXT_LIMITS.altText) }).strict()
const Block = z.object({ image: Image.nullable(), headline: Headline, body: Body }).strict()

/** 表单模型里的一个模块（与 aplus-modules.ts 的 AplusFormModule 一一对应）；内容是否合格（必填、图片尺寸）由 aplusModuleIssues 与服务端另查。 */
export const AplusModuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STANDARD_TEXT'), headline: Headline, body: Body }).strict(),
  z.object({ type: z.literal('STANDARD_PRODUCT_DESCRIPTION'), body: Body }).strict(),
  z.object({ type: z.literal('STANDARD_COMPANY_LOGO'), image: Image.nullable() }).strict(),
  z.object({ type: z.literal('STANDARD_HEADER_IMAGE_TEXT'), headline: Headline, block: Block }).strict(),
  z.object({ type: z.literal('STANDARD_SINGLE_SIDE_IMAGE'), position: z.enum(['LEFT', 'RIGHT']), block: Block }).strict(),
  z.object({ type: z.literal('STANDARD_THREE_IMAGE_TEXT'), headline: Headline, blocks: z.tuple([Block, Block, Block]) }).strict(),
])

const Name = z
  .string()
  .trim()
  .min(1, { error: '请填写内容名称' })
  .max(APLUS_LIMITS.nameMax, { error: `名称不能超过 ${APLUS_LIMITS.nameMax} 个字符` })
const Modules = z
  .array(AplusModuleSchema)
  .min(1, { error: '至少添加一个模块' })
  .max(APLUS_LIMITS.modulesMax, { error: `最多 ${APLUS_LIMITS.modulesMax} 个模块` })

/** GET /aplus：游标分页，默认最近更新在前；q 搜名称，asin 筛关联了这个 ASIN 的内容。 */
export const AplusListQuerySchema = cursorListQuery({
  sortable: APLUS_SORTS,
  defaultSort: { field: 'updatedAt', dir: 'desc' },
  filters: {
    storeId: { type: 'text', max: 64 },
    status: { type: 'enum', values: APLUS_STATUSES },
    asin: { type: 'text', max: 10 },
  },
})
export type AplusListQuery = z.infer<typeof AplusListQuerySchema>

/** GET /aplus/uploads。 */
export const AplusUploadsQuerySchema = z.object({ storeId: StoreId.optional() }).strict()
export type AplusUploadsQuery = z.infer<typeof AplusUploadsQuerySchema>

/** POST /aplus：新建一份内容（先存本地，再由后台任务在亚马逊创建）。 */
export const AplusCreateBodySchema = z
  .object({ storeId: StoreId, name: Name, locale: z.enum(APLUS_LOCALES).default('en-US'), contentType: z.enum(APLUS_CONTENT_TYPES).default('EBC'), modules: Modules })
  .strict()
export type AplusCreateBody = z.infer<typeof AplusCreateBodySchema>

/** PATCH /aplus/:id：保存修改；名称与模块至少改一个。 */
export const AplusUpdateBodySchema = z
  .object({ version: Version, name: Name.optional(), modules: Modules.optional() })
  .strict()
  .refine(value => value.name !== undefined || value.modules !== undefined, { error: '没有要保存的修改' })
export type AplusUpdateBody = z.infer<typeof AplusUpdateBodySchema>

/** POST /aplus/:id/asins：关联 ASIN（追加，不删除已有的）。 */
export const AplusAsinBodySchema = z
  .object({
    version: Version,
    asins: z
      .array(Asin)
      .min(1, { error: '请填写要关联的 ASIN' })
      .max(APLUS_LIMITS.asinsPerRequestMax, { error: `一次最多关联 ${APLUS_LIMITS.asinsPerRequestMax} 个 ASIN` })
      .refine(list => new Set(list).size === list.length, { error: 'ASIN 不能重复' }),
  })
  .strict()
export type AplusAsinBody = z.infer<typeof AplusAsinBodySchema>

/** POST /aplus/:id/submit：提交审核。 */
export const AplusSubmitBodySchema = z.object({ version: Version }).strict()
export type AplusSubmitBody = z.infer<typeof AplusSubmitBodySchema>

const FileName = z.string().trim().min(1, { error: '请填写文件名' }).max(200)
const ImageType = z.enum(APLUS_UPLOAD_TYPES, { error: '只支持 JPG 与 PNG 图片' })

/** POST /aplus/uploads：申请图片直传票据。 */
export const AplusUploadTicketBodySchema = z
  .object({ storeId: StoreId, fileName: FileName, contentType: ImageType, sizeBytes: z.number().int().min(1).max(APLUS_LIMITS.imageMaxBytes, { error: '图片不能超过 5MB' }) })
  .strict()
export type AplusUploadTicketBody = z.infer<typeof AplusUploadTicketBodySchema>

/** POST /aplus/uploads/confirm：图片传完后确认，服务端核对文件再登记上传任务。 */
export const AplusUploadConfirmBodySchema = z.object({ storeId: StoreId, objectKey: z.string().trim().min(1).max(500), fileName: FileName, contentType: ImageType }).strict()
export type AplusUploadConfirmBody = z.infer<typeof AplusUploadConfirmBodySchema>

export { Asin as AplusAsinSchema }
