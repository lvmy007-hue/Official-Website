import { z } from 'zod'
import { LENGTH_UNITS, PACKING_FIELDS, PACKING_HEADER_SCAN_ROWS, PACKING_MAX_COLUMNS, PACKING_MAX_ROWS, PACKING_SPEC_MAX, WEIGHT_UNITS } from './packing-list.js'
import { PACKING_CSV_MAX_CHARS, PACKING_FILE_FORMATS, PACKING_XLSX_MAX_BASE64 } from './packing-list-views.js'
import { pageListQuery } from './query.js'
import { SKU_ALIAS_IMPORT_MAX_CHARS, SKU_ALIAS_SORTABLE, SKU_ALIAS_SOURCES } from './sku-alias.js'

// 供应商装箱单与外部货号映射的请求校验（P6-11）。单独成文件：zod 构造是顶层调用，前端不引用。

const version = z.number().int().min(1)
const id = z.string().trim().min(1).max(64)
const code = (label: string) =>
  z
    .string({ error: `请填写${label}` })
    .trim()
    .min(1, { error: `请填写${label}` })
    .max(120, { error: `${label}最多 120 个字符` })

const columnIndex = z
  .number()
  .int()
  .min(0)
  .max(PACKING_MAX_COLUMNS - 1)
  .nullable()
/** 手动指定的列：字段 → 列序号（从 0 起）；null 表示这一字段没有对应列。 */
const ColumnsSchema = z.object(Object.fromEntries(PACKING_FIELDS.map(field => [field, columnIndex.optional()]))).strict()
const UnitsSchema = z.object({ length: z.enum(LENGTH_UNITS).optional(), weight: z.enum(WEIGHT_UNITS).optional() }).strict()
const spec = z.number().positive().max(PACKING_SPEC_MAX).nullable().optional()
const DefaultsSchema = z.object({ weightLb: spec, lengthIn: spec, widthIn: spec, heightIn: spec }).strict()

const fileFields = {
  fileName: z.string().trim().min(1, '缺少文件名').max(200),
  format: z.enum(PACKING_FILE_FORMATS, { error: '文件类型只能是 CSV 或 XLSX' }),
  /** CSV 是文本，XLSX 是文件内容的 base64。 */
  content: z.string().min(1, '文件内容为空').max(PACKING_XLSX_MAX_BASE64, '文件过大'),
  supplierId: id.nullable().optional(),
  sheet: z.string().trim().min(1).max(100).nullable().optional(),
  headerLine: z.number().int().min(1).max(PACKING_HEADER_SCAN_ROWS).nullable().optional(),
  columns: ColumnsSchema.optional(),
  units: UnitsSchema.optional(),
  defaults: DefaultsSchema.optional(),
}
const csvSize = (value: { format: string; content: string }, ctx: z.RefinementCtx) => {
  if (value.format === 'CSV' && value.content.length > PACKING_CSV_MAX_CHARS) ctx.addIssue({ code: 'custom', path: ['content'], message: '文件过大（CSV 上限约 400 KB）' })
}

export const PackingListParseBodySchema = z.object(fileFields).strict().superRefine(csvSize)
export type PackingListParseBody = z.infer<typeof PackingListParseBodySchema>

const DecisionSchema = z
  .object({
    line: z
      .number()
      .int()
      .min(1)
      .max(PACKING_MAX_ROWS + 1000),
    sku: code('SKU').nullable().optional(),
    ignore: z.boolean().optional(),
    remember: z.boolean().optional(),
  })
  .strict()
export const PackingListApplyBodySchema = z
  .object({ ...fileFields, version, decisions: z.array(DecisionSchema).max(PACKING_MAX_ROWS) })
  .strict()
  .superRefine(csvSize)
  .superRefine((value, ctx) => {
    const lines = value.decisions.map(item => item.line)
    const dup = lines.find((line, index) => lines.indexOf(line) !== index)
    if (dup !== undefined) ctx.addIssue({ code: 'custom', path: ['decisions'], message: `第 ${dup} 行的决定重复` })
  })
export type PackingListApplyBody = z.infer<typeof PackingListApplyBodySchema>

// ---------------------------------------------------------------- 外部货号映射
export const SkuAliasListQuerySchema = pageListQuery({
  scope: false,
  sortable: SKU_ALIAS_SORTABLE,
  defaultSort: { field: 'updatedAt', dir: 'desc' },
  filters: { supplierId: { type: 'text', max: 64 }, source: { type: 'enum', values: SKU_ALIAS_SOURCES } },
})
export type SkuAliasListQuery = z.infer<typeof SkuAliasListQuerySchema>
/** 列表筛选里表示“只看通用映射”的特殊值。 */
export const SKU_ALIAS_GENERAL = 'GENERAL'

/** 新增：供应商为空是通用映射。 */
export const SkuAliasCreateBodySchema = z.object({ supplierId: id.nullable().optional(), externalCode: code('外部货号'), sku: code('SKU') }).strict()
export type SkuAliasCreateBody = z.infer<typeof SkuAliasCreateBodySchema>
/** 修改：带版本号（乐观锁），至少改一项；供应商不能改（换供应商请新建）。 */
export const SkuAliasUpdateBodySchema = z
  .object({ version, externalCode: code('外部货号').optional(), sku: code('SKU').optional() })
  .strict()
  .refine(value => value.externalCode !== undefined || value.sku !== undefined, { error: '没有需要保存的修改' })
export type SkuAliasUpdateBody = z.infer<typeof SkuAliasUpdateBodySchema>
export const SkuAliasImportBodySchema = z
  .object({ fileName: z.string().trim().min(1, '缺少文件名').max(200), content: z.string().min(1, '文件内容为空').max(SKU_ALIAS_IMPORT_MAX_CHARS, '文件过大（上限约 400 KB）') })
  .strict()
export type SkuAliasImportBody = z.infer<typeof SkuAliasImportBodySchema>

// ---------------------------------------------------------------- 装箱单列映射
const header = z.string().trim().min(1).max(80)
const MappingColumnsSchema = z.object(Object.fromEntries(PACKING_FIELDS.map(field => [field, header.optional()]))).strict()
/** 保存列映射：已有映射时必须带版本号；没有映射时不带（首次保存）。 */
export const PackingListMappingBodySchema = z
  .object({ version: version.optional(), columns: MappingColumnsSchema, units: UnitsSchema.nullable().optional() })
  .strict()
  .refine(value => Object.values(value.columns).some(item => item !== undefined), { error: '至少要映射一列' })
export type PackingListMappingBody = z.infer<typeof PackingListMappingBodySchema>
