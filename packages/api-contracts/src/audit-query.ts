import { z } from 'zod'
import { AUDIT_RESULTS, AUDIT_SOURCES, auditPageOf } from './audit.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 审计中心的查询参数校验（P5-09）。单独成文件：zod 构造是顶层调用，不要和前端要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
// 审计日志不分店铺，所以不带全局范围参数；未知参数一律拒绝。

const text = (max: number) => z.string().trim().min(1).max(max).optional()
const time = z.string().datetime({ offset: true, message: '时间格式应为 ISO 时间（例如 2026-10-25T00:00:00Z）' }).optional()

const range = (value: { fromAt?: string; toAt?: string }, ctx: z.RefinementCtx) => {
  if (value.fromAt && value.toAt && Date.parse(value.fromAt) > Date.parse(value.toAt)) ctx.addIssue({ code: 'custom', path: ['fromAt'], message: '开始时间不能晚于结束时间' })
}

export const AuditListQuerySchema = z
  .object({
    ...CursorParamsSchema.shape,
    sort: sortSchema(['occurredAt'] as const, { field: 'occurredAt', dir: 'desc' }),
    q: text(120),
    actorId: text(64),
    action: text(80),
    resourceType: text(80),
    resourceId: text(120),
    result: z.enum(AUDIT_RESULTS).optional(),
    source: z.enum(AUDIT_SOURCES).optional(),
    page: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value, ctx) => {
        if (value === undefined || value === '') return undefined
        const page = auditPageOf(value)
        if (!page) ctx.addIssue({ code: 'custom', message: '所属页面应是以 /app 开头的页面路径' })
        return page ?? undefined
      }),
    requestId: text(120),
    fromAt: time,
    toAt: time,
  })
  .strict()
  .superRefine(range)
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>

/** 个人信息明文查看视图：只按人、关键词与时间筛选，动作固定。 */
export const PiiViewQuerySchema = z
  .object({
    ...CursorParamsSchema.shape,
    sort: sortSchema(['occurredAt'] as const, { field: 'occurredAt', dir: 'desc' }),
    q: text(120),
    actorId: text(64),
    fromAt: time,
    toAt: time,
  })
  .strict()
  .superRefine(range)
export type PiiViewQuery = z.infer<typeof PiiViewQuerySchema>
