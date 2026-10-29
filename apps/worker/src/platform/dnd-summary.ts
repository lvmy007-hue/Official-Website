import { DND_SUMMARY_KIND, dndSummaryBody, dndSummaryLink, inDndWindow, notifyPrefsOf } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 免打扰汇总（P5-11，09 章 9.15）：免打扰时段内收到的普通通知只留在消息中心（带免打扰标记、不计未读），不逐条补发；
// 时段结束后，给每个有这类通知的成员发一条汇总，按业务域列出条数，并链接到对应的筛选结果。
// - 只处理“已不在免打扰时段”的成员（关掉免打扰或改了时段的，下一轮就会汇总）；
// - 先用“尚未汇总”作条件的条件更新认领这批通知，多个后台进程同时扫描时每条只汇总一次；
// - 汇总通知本身不受业务域开关限制（它是免打扰功能的一部分），也不会被再次压下。

export const DND_SUMMARY_INTERVAL_MS = 5 * 60 * 1000
const MEMBER_BATCH = 500
const ROW_LIMIT = 5000

type Db = Pick<PrismaClient, 'notification' | 'userPreference' | 'tenant' | '$transaction'>

export interface DndSummaryResult {
  /** 汇总了几位成员 */
  summaries: number
  /** 并入汇总的通知条数 */
  notices: number
}

export async function sendDndSummaries(db: Db, now: Date = new Date()): Promise<DndSummaryResult> {
  const pending = await db.notification.groupBy({
    by: ['tenantId', 'userId'],
    where: { silencedAt: { not: null }, summarizedAt: null },
    orderBy: [{ tenantId: 'asc' }, { userId: 'asc' }],
    take: MEMBER_BATCH,
  })
  if (pending.length === 0) return { summaries: 0, notices: 0 }
  const tenantIds = [...new Set(pending.map(item => item.tenantId))]
  const zones = new Map((await db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, localTimezone: true } })).map(row => [row.id, row.localTimezone]))
  const prefRows = await db.userPreference.findMany({
    where: { tenantId: { in: tenantIds }, userId: { in: pending.map(item => item.userId) } },
    select: { tenantId: true, userId: true, notifyJson: true },
  })
  const prefs = new Map(prefRows.map(row => [`${row.tenantId}|${row.userId}`, notifyPrefsOf(row.notifyJson)]))
  const result: DndSummaryResult = { summaries: 0, notices: 0 }
  for (const { tenantId, userId } of pending) {
    const dnd = (prefs.get(`${tenantId}|${userId}`) ?? notifyPrefsOf(null)).dnd
    if (inDndWindow(now, zones.get(tenantId), dnd)) continue
    const claimed = await summarizeOne(db, tenantId, userId, now)
    if (claimed > 0) {
      result.summaries += 1
      result.notices += claimed
    }
  }
  return result
}

/** 汇总一位成员：认领通知、按业务域计数、写入汇总通知；返回并入的条数（被别的进程先认领了返回 0）。 */
class ClaimedElsewhere extends Error {}

async function summarizeOne(db: Db, tenantId: string, userId: string, now: Date): Promise<number> {
  return db
    .$transaction(async tx => {
      const rows = await tx.notification.findMany({
        where: { tenantId, userId, silencedAt: { not: null }, summarizedAt: null },
        select: { id: true, domain: true },
        orderBy: { createdAt: 'asc' },
        take: ROW_LIMIT,
      })
      if (rows.length === 0) return 0
      const claimed = await tx.notification.updateMany({ where: { id: { in: rows.map(row => row.id) }, summarizedAt: null }, data: { summarizedAt: now } })
      // 条数对不上说明另一个进程刚认领了其中一部分：整体回滚，留给它汇总
      if (claimed.count !== rows.length) throw new ClaimedElsewhere()
      const counts: Record<string, number> = {}
      for (const row of rows) counts[row.domain ?? 'OTHER'] = (counts[row.domain ?? 'OTHER'] ?? 0) + 1
      await tx.notification.create({
        data: {
          tenantId,
          userId,
          kind: DND_SUMMARY_KIND,
          title: `免打扰期间收到 ${rows.length} 条通知`,
          body: dndSummaryBody(counts),
          link: dndSummaryLink(counts),
          severity: 'INFO',
          domain: 'SYSTEM',
          dedupKey: `dnd-summary:${userId}:${now.toISOString()}`,
        },
      })
      return rows.length
    })
    .catch(error => {
      if (error instanceof ClaimedElsewhere) return 0
      throw error
    })
}
