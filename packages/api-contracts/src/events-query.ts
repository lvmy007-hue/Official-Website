import { z } from 'zod'
import { ENTITY_TYPES } from './collab.js'
import { EVENT_TYPES, type EventType } from './events.js'

// 事件查询参数（P6-06）：objectType、objectId、from、to、types。zod 在这里，前端不引用（见 events.ts）。

const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayOrInstant = z.union([z.string().regex(DAY, '日期格式应为 YYYY-MM-DD'), z.string().datetime('时间格式不正确')])

const typesParam = z
  .string()
  .max(200)
  .transform((text, ctx): EventType[] => {
    const wanted = text
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
    const known = new Set<string>(EVENT_TYPES)
    const bad = wanted.find(part => !known.has(part))
    if (bad) {
      ctx.addIssue({ code: 'custom', message: `不支持的事件类型：${bad}` })
      return z.NEVER
    }
    return EVENT_TYPES.filter(type => wanted.includes(type))
  })

export const EventsQuerySchema = z.object({
  objectType: z.enum(ENTITY_TYPES, { error: '不支持的对象类型' }),
  objectId: z.string().min(1).max(64),
  from: dayOrInstant.optional(),
  to: dayOrInstant.optional(),
  types: typesParam.optional(),
})
export type EventsQuery = z.infer<typeof EventsQuerySchema>
