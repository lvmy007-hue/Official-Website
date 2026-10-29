import { z } from 'zod'
import { BOX_IMPORT_MAX_CHARS, BOX_TEMPLATE_KINDS } from './inbound-box-file.js'

// 装箱文件导入的请求体（P6-10）：带 zod，只给服务端用，前端不引用（见 PROGRESS.md 首屏预算说明）。
// 浏览器读出 CSV 文本后提交，服务端逐行校验，一行有错整份拒绝；带计划版本号（乐观锁）。
export const InboundBoxImportBodySchema = z
  .object({
    version: z.number().int().min(1),
    kind: z.enum(BOX_TEMPLATE_KINDS, { error: '请选择模板类型' }),
    fileName: z.string().trim().min(1, '缺少文件名').max(200),
    content: z.string().min(1, '文件内容为空').max(BOX_IMPORT_MAX_CHARS, '文件过大（上限约 400 KB）'),
  })
  .strict()
export type InboundBoxImportBody = z.infer<typeof InboundBoxImportBodySchema>
