import { PII_BULK_VIEW_RULE_TYPE, PII_VIEWER_ENTITY, PII_VIEW_ACTIONS } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam } from './params'

// 大量查看买家信息明文预警评估器（P5-09，09 章 9.11 CR-096 补充）：同一个人在统计时长内，看到买家信息明文的次数达到上限。
// 数据来自查看明文时写的审计（动作清单见契约 PII_VIEW_ACTIONS）：只数结果成功且确实看到了内容的记录（被拒绝、已过保留期、没有买家信息的不算）；
// 同一个订单反复查看每次都计数。窗口是滚动的：最早的查看滑出窗口后次数下降，预警随之自动恢复。
// 预警对象是“查看的人”（不是订单）；证据只有人、次数、时间与涉及的对象个数，不含任何买家信息。

const READ_LIMIT = 20_000
const MINUTE_MS = 60_000

export interface PiiViewEvent {
  actorId: string | null
  occurredAt: Date
  resourceId: string | null
}

/** 按人统计窗口内的查看；达到上限的人各一个命中，查看最多的排前面（纯函数）。 */
export function buildPiiBulkHits(events: readonly PiiViewEvent[], names: ReadonlyMap<string, string>, options: { windowMinutes: number; maxViews: number }): AlertHit[] {
  const byActor = new Map<string, PiiViewEvent[]>()
  for (const event of events) {
    if (!event.actorId) continue
    const list = byActor.get(event.actorId) ?? []
    list.push(event)
    byActor.set(event.actorId, list)
  }
  return [...byActor.entries()]
    .filter(([, list]) => list.length >= options.maxViews)
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([actorId, list]): AlertHit => {
      const name = names.get(actorId) ?? '已离开的成员'
      const times = list.map(item => item.occurredAt.getTime())
      const objects = new Set(list.flatMap(item => (item.resourceId ? [item.resourceId] : [])))
      return {
        entityType: PII_VIEWER_ENTITY,
        entityId: actorId,
        entityLabel: name,
        title: `${name} 在 ${options.windowMinutes} 分钟内查看了 ${list.length} 次买家信息明文`,
        suggestedAction: '到审计中心的“个人信息明文查看”核对他填写的查看理由与涉及的订单；确认是正常的客服处理就可以忽略，不是就联系本人并考虑收回“买家信息”字段权限',
        evidence: {
          actorName: name,
          views: list.length,
          distinctObjects: objects.size,
          windowMinutes: options.windowMinutes,
          threshold: options.maxViews,
          firstViewedAt: new Date(Math.min(...times)).toISOString(),
          lastViewedAt: new Date(Math.max(...times)).toISOString(),
        },
      }
    })
}

export const piiBulkViewEvaluator: AlertEvaluator = {
  type: PII_BULK_VIEW_RULE_TYPE,
  async evaluate({ db, tenantId, rule, now }) {
    const windowMinutes = numberParam(rule, 'windowMinutes', 60, { min: 5, max: 1440 })
    const maxViews = numberParam(rule, 'maxViews', 20, { min: 1, max: 10_000 })
    const where: Prisma.AuditEventWhereInput = {
      tenantId,
      action: { in: [...PII_VIEW_ACTIONS] },
      result: 'SUCCEEDED',
      detail: { path: ['outcome'], equals: 'OK' },
      occurredAt: { gte: new Date(now.getTime() - windowMinutes * MINUTE_MS), lte: now },
      actorId: { not: null },
    }
    const events = await db.auditEvent.findMany({ where, select: { actorId: true, occurredAt: true, resourceId: true }, orderBy: { occurredAt: 'desc' }, take: READ_LIMIT })
    if (events.length < maxViews) return []
    const actorIds = [...new Set(events.flatMap(event => (event.actorId ? [event.actorId] : [])))]
    const members = await db.membership.findMany({
      where: { tenantId, userId: { in: actorIds } },
      select: { userId: true, user: { select: { displayName: true, email: true } } },
      take: actorIds.length,
    })
    return buildPiiBulkHits(events, new Map(members.map(member => [member.userId, member.user.displayName || member.user.email])), { windowMinutes, maxViews })
  },
}
