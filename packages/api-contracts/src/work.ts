import { z } from 'zod'

// 待办、预警与站内通知的契约（P1-28，04 章 4.3、09 章 9.1/9.15）。

export const WORK_TABS = ['MINE', 'ASSIGNED', 'WATCHING', 'DONE', 'IGNORED'] as const
export type WorkTab = (typeof WORK_TABS)[number]
export const WORK_TAB_LABEL: Record<WorkTab, string> = { MINE: '待我处理', ASSIGNED: '我指派的', WATCHING: '我关注的', DONE: '已完成', IGNORED: '已忽略' }
export const WORK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'CLOSED'] as const
export const WORK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const WORK_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const
export const WORK_SOURCES = ['ALERT', 'MANUAL', 'SYSTEM'] as const
export const WORK_CLOSE_CONCLUSIONS = ['HANDLED', 'NOT_NEEDED', 'FALSE_POSITIVE'] as const
export const WORK_GROUPS = ['none', 'source', 'severity', 'due'] as const
export type WorkSeverity = (typeof WORK_SEVERITIES)[number]

/** 待办默认处理时限（小时）：按严重度；超时自动升级给管理员。可由企业设置项 work.sla.hours 覆盖。 */
export const WORK_DEFAULT_SLA_HOURS: Record<WorkSeverity, number> = { CRITICAL: 4, WARNING: 24, INFO: 72 }
/** 批量操作一次最多处理的待办数 */
export const WORK_BATCH_MAX = 100

export const WorkItemListQuerySchema = z.object({
  tab: z.enum(WORK_TABS).default('MINE'),
  /** mine：只看与自己相关的；all：查看全部待办（含他人的，需要 workitem.read） */
  scope: z.enum(['mine', 'all']).default('mine'),
  source: z.enum(WORK_SOURCES).optional(),
  severity: z.enum(WORK_SEVERITIES).optional(),
  dueBefore: z.string().datetime().optional(),
  group: z.enum(WORK_GROUPS).default('none'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
})

const idText = z.string().min(1).max(64)

export const WorkItemCreateBodySchema = z.object({
  title: z.string().trim().min(2, '请填写标题').max(200),
  detail: z.string().trim().max(2000).optional(),
  priority: z.enum(WORK_PRIORITIES).default('NORMAL'),
  severity: z.enum(WORK_SEVERITIES).default('INFO'),
  dueAt: z.string().datetime().optional(),
  ownerId: idText.optional(),
  entityType: z.string().max(40).optional(),
  entityId: idText.optional(),
  entityLabel: z.string().trim().max(200).optional(),
  suggestedAction: z.string().trim().max(500).optional(),
})
export const WorkItemAssignBodySchema = z.object({ assigneeId: idText, note: z.string().trim().max(500).optional(), version: z.number().int().min(1) })
export const WorkItemCloseBodySchema = z.object({ conclusion: z.enum(WORK_CLOSE_CONCLUSIONS), note: z.string().trim().max(1000).optional(), version: z.number().int().min(1) })
export const WorkItemDeferBodySchema = z.object({ until: z.string().datetime(), reason: z.string().trim().min(2, '请填写延期原因').max(500), version: z.number().int().min(1) })
export const WorkItemIgnoreBodySchema = z.object({ reason: z.string().trim().min(2, '请填写忽略原因').max(500), version: z.number().int().min(1) })
export const WorkItemAckBodySchema = z.object({ version: z.number().int().min(1) })

/** PATCH /work-items：批量指派、确认、忽略（忽略必须填原因）。每项按各自的版本号检测冲突。 */
export const WorkItemBatchBodySchema = z
  .object({
    action: z.enum(['ASSIGN', 'ACK', 'IGNORE']),
    items: z
      .array(z.object({ id: idText, version: z.number().int().min(1) }))
      .min(1)
      .max(WORK_BATCH_MAX),
    assigneeId: idText.optional(),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'ASSIGN' && !value.assigneeId) ctx.addIssue({ code: 'custom', path: ['assigneeId'], message: '请选择指派对象' })
    if (value.action === 'IGNORE' && !value.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: '忽略必须填写原因' })
  })

export const NotificationListQuerySchema = z.object({
  kind: z.string().max(60).optional(),
  unread: z.enum(['true', 'false']).optional(),
  // P5-11：按业务域筛选（OTHER 表示没有业务域的旧通知）；silenced=true 只看免打扰期间收到的，false 排除它们
  domain: z.enum(['INVENTORY', 'FINANCE', 'AFTER_SALES', 'ADS', 'PRODUCT', 'WORK', 'SYSTEM', 'OTHER']).optional(),
  silenced: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(500).optional(),
})
/** POST /notifications/read：标记指定通知已读，或全部已读 */
export const NotificationReadBodySchema = z
  .object({ ids: z.array(idText).min(1).max(200).optional(), all: z.literal(true).optional() })
  .refine(value => Boolean(value.ids) !== Boolean(value.all), { message: '请指定通知，或选择全部已读' })

export const ALERT_STATUSES = ['NEW', 'ACKED', 'HANDLED', 'IGNORED', 'AUTO_CLOSED'] as const
/** 关闭结论对应的预警状态：已处理 → HANDLED；误报与无需处理 → IGNORED（统计时按结论区分） */
export const ALERT_STATUS_BY_CONCLUSION: Record<string, (typeof ALERT_STATUSES)[number]> = { HANDLED: 'HANDLED', NOT_NEEDED: 'IGNORED', FALSE_POSITIVE: 'IGNORED', IGNORED: 'IGNORED' }

/** 预警证据里允许展示给业务用户的字段及其中文名（不在表里的键不展示，避免出现内部字段名）。 */
export const ALERT_EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  source: '数据来源',
  lastSuccessAt: '最近成功时间',
  hoursBehind: '已落后（小时）',
  thresholdHours: '预警阈值（小时）',
  store: '店铺',
}

/** 待办所处的时间分组（按截止时间）：已超时、今天、本周内、更晚、无截止时间 */
export const WORK_DUE_GROUPS = ['OVERDUE', 'TODAY', 'THIS_WEEK', 'LATER', 'NONE'] as const
export type WorkDueGroup = (typeof WORK_DUE_GROUPS)[number]
export const WORK_DUE_GROUP_LABEL: Record<WorkDueGroup, string> = { OVERDUE: '已超时', TODAY: '今天到期', THIS_WEEK: '本周内', LATER: '更晚', NONE: '没有截止时间' }

export function workDueGroup(dueAt: Date | null, now: Date = new Date()): WorkDueGroup {
  if (!dueAt) return 'NONE'
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE'
  const endOfToday = new Date(now)
  endOfToday.setUTCHours(23, 59, 59, 999)
  if (dueAt.getTime() <= endOfToday.getTime()) return 'TODAY'
  return dueAt.getTime() <= endOfToday.getTime() + 6 * 86_400_000 ? 'THIS_WEEK' : 'LATER'
}

/** 延期最长天数 */
export const WORK_DEFER_MAX_DAYS = 90
