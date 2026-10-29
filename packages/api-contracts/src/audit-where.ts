import { PII_VIEW_ACTIONS } from './audit.js'

// 审计事件的筛选条件（接口列表、明文查看视图与审计导出共用同一份，导出的行数才与页面一致）。
// 返回的是 Prisma 的 AND 条件片段（这里不引入 Prisma 类型，调用方断言为 AuditEventWhereInput），不含租户条件，调用方必须自己加。
// 本文件没有 zod。

export interface AuditFilters {
  actorId?: string
  action?: string
  resourceType?: string
  resourceId?: string
  result?: string
  /** PAGE、API 或 SYSTEM；SYSTEM 也包含没有来源列、没有操作人的旧记录。 */
  source?: string
  page?: string
  requestId?: string
  /** 关键词：动作（包含）、资源编号或请求编号（开头匹配）。 */
  q?: string
  fromAt?: Date
  toAt?: Date
}

type Clause = Record<string, unknown>

export function auditFilterClauses(filters: AuditFilters): Clause[] {
  const and: Clause[] = []
  if (filters.actorId) and.push({ actorId: filters.actorId })
  if (filters.action) and.push({ action: filters.action })
  if (filters.resourceType) and.push({ resourceType: filters.resourceType })
  if (filters.resourceId) and.push({ resourceId: filters.resourceId })
  if (filters.result) and.push({ result: filters.result })
  if (filters.requestId) and.push({ requestId: filters.requestId })
  if (filters.page) and.push({ page: filters.page })
  if (filters.source === 'SYSTEM') and.push({ OR: [{ source: 'SYSTEM' }, { source: null, actorId: null }] })
  else if (filters.source) and.push({ source: filters.source })
  if (filters.q) {
    const q = filters.q
    and.push({ OR: [{ action: { contains: q, mode: 'insensitive' } }, { resourceId: { startsWith: q } }, { requestId: { startsWith: q } }] })
  }
  if (filters.fromAt || filters.toAt) and.push({ occurredAt: { ...(filters.fromAt ? { gte: filters.fromAt } : {}), ...(filters.toAt ? { lte: filters.toAt } : {}) } })
  return and
}

/** 个人信息明文查看视图的条件：动作固定为明文查看类；关键词匹配对象编号（资源编号开头）或订单号（详情里记的亚马逊订单号包含）。 */
export function piiViewClauses(filters: Pick<AuditFilters, 'actorId' | 'q' | 'fromAt' | 'toAt'>): Clause[] {
  const and: Clause[] = [{ action: { in: [...PII_VIEW_ACTIONS] } }]
  if (filters.actorId) and.push({ actorId: filters.actorId })
  if (filters.q) and.push({ OR: [{ resourceId: { startsWith: filters.q } }, { detail: { path: ['amazonOrderId'], string_contains: filters.q } }] })
  if (filters.fromAt || filters.toAt) and.push({ occurredAt: { ...(filters.fromAt ? { gte: filters.fromAt } : {}), ...(filters.toAt ? { lte: filters.toAt } : {}) } })
  return and
}

/** 导出任务保存的筛选（键值都是文字）转成筛选条件；时间解析不了的丢弃。 */
export function auditFiltersFromExport(raw: Record<string, unknown>): AuditFilters {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const time = (value: unknown) => {
    const parsed = text(value) ? Date.parse(text(value) as string) : Number.NaN
    return Number.isNaN(parsed) ? undefined : new Date(parsed)
  }
  return {
    actorId: text(raw.actorId),
    action: text(raw.action),
    resourceType: text(raw.resourceType),
    resourceId: text(raw.resourceId),
    result: text(raw.result),
    source: text(raw.source),
    page: text(raw.page),
    requestId: text(raw.requestId),
    q: text(raw.q),
    fromAt: time(raw.fromAt),
    toAt: time(raw.toAt),
  }
}
