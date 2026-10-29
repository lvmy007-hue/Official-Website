import { z } from 'zod'
import { LEGAL_ENTITY_STATUSES } from './legal-entity.js'

// 法律主体的请求校验（P5-07）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

export const LegalEntityListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(LEGAL_ENTITY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type LegalEntityListQuery = z.infer<typeof LegalEntityListQuerySchema>

const field = (min: number, max: number) => z.string().trim().min(min).max(max)

/** 修改主体：带着看到的版本号（乐观锁）；至少改一项；停用时必须写原因（服务里校验，因为是否停用要和当前状态比较）。 */
export const LegalEntityUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    name: field(2, 200).optional(),
    registeredCountry: field(2, 80).optional(),
    registrationNo: z.string().trim().max(120).nullable().optional(),
    status: z.enum(LEGAL_ENTITY_STATUSES).optional(),
    reason: z.string().trim().min(2, '请填写原因').max(500).optional(),
  })
  .strict()
  .refine(body => ['name', 'registeredCountry', 'registrationNo', 'status'].some(key => key in body), { message: '没有要修改的内容' })
export type LegalEntityUpdateBody = z.infer<typeof LegalEntityUpdateBodySchema>
