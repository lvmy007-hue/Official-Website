import { z } from 'zod'
import { PII_OBJECT_ID_PATTERN, PII_OBJECT_TYPES, PII_REASON_MAX, PII_REASON_MIN, PII_REVEAL_FIELDS, PII_REVEAL_FIELDS_MAX } from './pii.js'

// 查看个人信息明文的请求校验（P6-14）。单独成文件：zod 构造是顶层调用，前端不引用。

/** POST /pii/reveal：对象类型 + 编号 + 要看的字段 + 理由。字段必须属于该类型；理由必填。 */
export const PiiRevealBodySchema = z
  .object({
    objectType: z.enum(PII_OBJECT_TYPES, { error: '对象类型不支持' }),
    objectId: z.string().trim().regex(PII_OBJECT_ID_PATTERN, { error: '对象编号格式不正确' }),
    fields: z
      .array(z.string().trim().min(1).max(40))
      .min(1, { error: '至少选择一个字段' })
      .max(PII_REVEAL_FIELDS_MAX, { error: `一次最多查看 ${PII_REVEAL_FIELDS_MAX} 个字段` }),
    reason: z
      .string({ error: `请填写查看原因（至少 ${PII_REASON_MIN} 个字）` })
      .trim()
      .min(PII_REASON_MIN, { error: `请填写查看原因（至少 ${PII_REASON_MIN} 个字）` })
      .max(PII_REASON_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    const allowed = PII_REVEAL_FIELDS[body.objectType]
    const seen = new Set<string>()
    for (const [index, field] of body.fields.entries()) {
      if (!allowed.includes(field)) ctx.addIssue({ code: 'custom', path: ['fields', index], message: `字段 ${field} 不属于这个对象` })
      else if (seen.has(field)) ctx.addIssue({ code: 'custom', path: ['fields', index], message: `字段 ${field} 重复` })
      seen.add(field)
    }
  })
export type PiiRevealBody = z.infer<typeof PiiRevealBodySchema>
