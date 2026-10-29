import { EVENT_DEFAULT_SPAN_DAYS, EVENT_MAX_SPAN_DAYS, type EventsQuery } from '@nova/api-contracts'
import { appError } from '../../platform/http'
import { addDays, zonedDayStart } from '../overview'
import type { EventWindow } from './events-types'

// 事件的时间窗：日期（YYYY-MM-DD）按企业时区取整日，完整时间点按原样；终点一律不含。
// 没给范围时看最近 90 天；跨度最多 400 天，超出是参数错误而不是静默截短。

const DAY_MS = 86_400_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

const fail = (field: 'from' | 'to', message: string): never => {
  throw appError('VALIDATION_FAILED', message, { fieldErrors: { [field]: [message] } })
}

function parseEdge(value: string, zone: string, edge: 'from' | 'to'): Date {
  if (DAY.test(value)) {
    const start = zonedDayStart(edge === 'from' ? value : addDays(value, 1), zone)
    if (Number.isNaN(start.getTime())) return fail(edge, '日期不合法')
    return start
  }
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return fail(edge, '时间不合法')
  return edge === 'to' ? new Date(at.getTime() + 1) : at
}

export function resolveWindow(query: Pick<EventsQuery, 'from' | 'to'>, zone: string, now: Date): EventWindow {
  const to = query.to ? parseEdge(query.to, zone, 'to') : new Date(now.getTime() + 1)
  const from = query.from ? parseEdge(query.from, zone, 'from') : new Date(to.getTime() - EVENT_DEFAULT_SPAN_DAYS * DAY_MS)
  if (from.getTime() >= to.getTime()) return fail('from', '开始时间必须早于结束时间')
  if (to.getTime() - from.getTime() > EVENT_MAX_SPAN_DAYS * DAY_MS) return fail('from', `时间范围最多 ${EVENT_MAX_SPAN_DAYS} 天`)
  return { from, to }
}
