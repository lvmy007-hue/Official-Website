import { entityDetailPath } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { notifyHolders, notifyUsers } from './notify'

// 待办超时升级（P1-28-3）：处理时限已过、仍未处理完的待办，标记为已超时并升级——通知负责人，同时通知有“预警管理”权限的管理员。
// - 只处理“待处理 / 处理中”且到期时间已过的待办；延期中的待办（deferredUntil 未到）不升级；
// - 标记用“尚未标记”作条件的条件更新，多个后台进程同时扫描时每条待办只升级一次、只通知一次；
// - 延期后（API 会清空 slaBreachedAt）再次超时会重新升级，通知去重键带上到期时间，不会和上一次混淆。

export const WORK_ESCALATION_INTERVAL_MS = 10 * 60 * 1000
const BATCH = 200
const MAX_BATCHES = 10

type Db = Pick<PrismaClient, 'workItem' | 'notification' | 'membership'>

export interface EscalationResult {
  escalated: number
}

export async function escalateOverdueWork(db: Db, now: Date = new Date()): Promise<EscalationResult> {
  let escalated = 0
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await db.workItem.findMany({
      where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lte: now }, slaBreachedAt: null, OR: [{ deferredUntil: null }, { deferredUntil: { lte: now } }] },
      select: { id: true, tenantId: true, title: true, ownerId: true, severity: true, dueAt: true },
      orderBy: { dueAt: 'asc' },
      take: BATCH,
    })
    if (rows.length === 0) break
    for (const row of rows) {
      const marked = await db.workItem.updateMany({ where: { id: row.id, slaBreachedAt: null }, data: { slaBreachedAt: now, escalatedAt: now } })
      if (marked.count !== 1) continue
      escalated += 1
      const link = entityDetailPath('WORK_ITEM', row.id) ?? undefined
      const stamp = row.dueAt?.getTime() ?? 0
      const severity = row.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING'
      await notifyUsers(db, row.tenantId, [row.ownerId], { kind: 'WORK_OVERDUE', title: '待办已超过处理时限', body: row.title, link, severity, dedupKey: `work-overdue:${row.id}:${stamp}` })
      await notifyHolders(
        db,
        row.tenantId,
        'alerts.manage',
        { kind: 'WORK_ESCALATED', title: '有待办超时未处理，已升级给管理员', body: row.title, link, severity, dedupKey: `work-escalated:${row.id}:${stamp}` },
        [row.ownerId],
      )
    }
    if (rows.length < BATCH) break
  }
  return { escalated }
}
