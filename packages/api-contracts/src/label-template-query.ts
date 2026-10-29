import { z } from 'zod'
import { ITEM_LABEL_SIZES } from './label-job.js'
import { BOX_NO_DIGITS_MAX, BOX_NO_JOINER_MAX, BOX_NO_PART_MAX, BOX_NO_START_MAX, LABEL_NAME_MAX, LABEL_ORIGIN_MAX, LABEL_ORDERS, LABEL_PAPERS, validateLabelTemplate } from './label-template.js'
import { pageListQuery } from './query.js'

// 标签模板与标签生成的请求校验（P6-12）。单独成文件：zod 构造是顶层调用，前端不引用。

export const LabelTemplateListQuerySchema = pageListQuery({ scope: false, sortable: ['name', 'updatedAt'] as const, defaultSort: { field: 'updatedAt', dir: 'desc' } })
export type LabelTemplateListQuery = z.infer<typeof LabelTemplateListQuerySchema>

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { error: '编号格式不正确' })
const text = (max: number) => z.string().max(max)

const OptionsSchema = z
  .object({
    showOrigin: z.boolean(),
    originText: text(LABEL_ORIGIN_MAX),
    showSku: z.boolean(),
    showProductName: z.boolean(),
    showFnsku: z.boolean(),
    showUnits: z.boolean(),
    showBoxNo: z.boolean(),
    taskNamePage: z.boolean(),
    appendToOriginal: z.boolean(),
    order: z.enum(LABEL_ORDERS),
  })
  .strict()
const BoxNoRuleSchema = z
  .object({
    prefix: text(BOX_NO_PART_MAX),
    includePlanNo: z.boolean(),
    digits: z.number().int().min(1).max(BOX_NO_DIGITS_MAX),
    start: z.number().int().min(0).max(BOX_NO_START_MAX),
    suffix: text(BOX_NO_PART_MAX),
    joiner: text(BOX_NO_JOINER_MAX),
  })
  .strict()

const fields = {
  name: z
    .string({ error: '请填写模板名称' })
    .trim()
    .min(1, { error: '请填写模板名称' })
    .max(LABEL_NAME_MAX, { error: `模板名称最多 ${LABEL_NAME_MAX} 个字符` }),
  paper: z.enum(LABEL_PAPERS, { error: '请选择纸张规格' }),
  options: OptionsSchema,
  boxNoRule: BoxNoRuleSchema,
}
/** 与页面共用同一套组合校验（纸张与选项的搭配、箱号规则），出错的字段名带前缀，页面能直接挂到对应的输入框上。 */
const combined = (value: { name?: string; paper?: (typeof LABEL_PAPERS)[number]; options?: z.infer<typeof OptionsSchema>; boxNoRule?: z.infer<typeof BoxNoRuleSchema> }, ctx: z.RefinementCtx) => {
  if (!value.name || !value.paper || !value.options || !value.boxNoRule) return
  for (const issue of validateLabelTemplate({ name: value.name, paper: value.paper, options: value.options, boxNoRule: value.boxNoRule }))
    ctx.addIssue({ code: 'custom', path: issue.field.split('.'), message: issue.message })
}

export const LabelTemplateCreateBodySchema = z
  .object({ ...fields, isDefault: z.boolean().default(false) })
  .strict()
  .superRefine(combined)
export type LabelTemplateCreateBody = z.infer<typeof LabelTemplateCreateBodySchema>

/** 修改：整份替换（带版本号，乐观锁）；名称、纸张、选项、箱号规则都要给全，设为默认也在这里（服务里保证全企业只有一个默认）。 */
export const LabelTemplateUpdateBodySchema = z
  .object({ version: z.number().int().min(1), ...fields, isDefault: z.boolean() })
  .strict()
  .superRefine(combined)
export type LabelTemplateUpdateBody = z.infer<typeof LabelTemplateUpdateBodySchema>

/** 生成自定义箱标签：不传 templateId 用企业的默认模板，没有默认模板用内置默认设置；起始序号不传取模板规则里的起始序号并接着该计划已编到的号往下排。 */
export const CustomLabelBodySchema = z.object({ templateId: id.nullable().optional(), startNumber: z.number().int().min(0).max(BOX_NO_START_MAX).optional() }).strict()
export type CustomLabelBody = z.infer<typeof CustomLabelBodySchema>

/** 生成商品标签（FNSKU）：不传货件就按整个计划的商品数量印；缺 FNSKU 的商品默认拒绝，传 skipMissingFnsku 才跳过并在说明里列出。 */
export const ItemLabelBodySchema = z
  .object({
    shipmentId: id.nullable().optional(),
    size: z.enum(ITEM_LABEL_SIZES, { error: '请选择标签纸规格' }),
    showTitle: z.boolean().default(false),
    showCondition: z.boolean().default(true),
    skipMissingFnsku: z.boolean().default(false),
  })
  .strict()
export type ItemLabelBody = z.infer<typeof ItemLabelBodySchema>
