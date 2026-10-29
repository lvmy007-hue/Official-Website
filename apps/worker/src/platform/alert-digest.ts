import {
  ALERT_ESCALATION_TARGET_LABEL,
  digestBody,
  digestLink,
  digestTitle,
  entityDetailPath,
  localDateOf,
  escalationMinutesText,
  readEscalation,
  type AlertNotifyFrequency,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { chooseOwner, notifyTargetsOf, recipientsOf } from './alert-recipients'
import { isQuietNow, readQuietHours } from './alert-scope'
import { holdersOf, notifyUsers } from './notify'

// 预警通知的汇总与升级（P6-16）。
// 汇总：规则的通知频率是“每小时汇总 / 每日汇总”，或者命中时正处在静默时段，站内通知不逐条发，而是把预警并入一个批次（AlertDigest），
//   批次到时间后发一条汇总通知（列出 N 个对象，链接到预警中心按这条规则筛选的结果）。严重级别的预警一律立即通知，不进批次。
//   - 频率批次：每小时的批次在下一个整点（UTC）之后发，每日的批次在企业时区的次日发；若发送时仍处在静默时段，等静默结束再发；
//   - 静默批次：静默时段结束后发一条汇总（之前是直接丢弃，不补发）；一个规则同一时间只有一个待发送的静默批次。
//   发送前先用“待发送”条件更新认领批次，多个后台进程同时扫描时每批只发一次；汇总里只列发送时仍然开放（新、已确认）的预警，都已恢复或处理的批次不发。
// 升级：预警仍是“新”（没人确认）时，超过规则设置的各级时限依次通知待办负责人、规则的通知对象、预警管理员；
//   每一级用 AlertDigest 里一条 ESCALATION 记录做幂等（同一条预警同一级只发一次）；升级通知按“严重”级别发送，穿透个人免打扰；没有可通知的人时也记一笔，不反复重试。

const OPEN = ['NEW', 'ACKED']
const BATCH_LIMIT = 500
const ALERT_IDS_CAP = 500
const ESCALATION_ALERT_LIMIT = 500

type Db = Pick<PrismaClient, 'alertDigest' | 'alertInstance' | 'alertRule' | 'workItem' | 'membership' | 'notification'> & Partial<Pick<PrismaClient, 'userPreference' | 'tenant'>>

const scopeOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const isDuplicate = (error: unknown) => (error as { code?: string }).code === 'P2002'

/** 频率批次所属时段：每小时用 UTC 小时（2026-10-27T13），每日用企业时区的日期（2026-10-27）。 */
export function frequencyBucket(frequency: Exclude<AlertNotifyFrequency, 'IMMEDIATE'>, now: Date, zone: string | null): string {
  return frequency === 'HOURLY' ? now.toISOString().slice(0, 13) : localDateOf(now, zone)
}

async function appendToDigest(db: Db, tenantId: string, ruleId: string, kind: 'FREQUENCY' | 'QUIET', dedupKey: string, alertId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await db.alertDigest.findFirst({ where: { tenantId, dedupKey }, select: { id: true, status: true, alertIds: true, itemCount: true } })
    if (!existing) {
      try {
        await db.alertDigest.create({ data: { tenantId, ruleId, kind, dedupKey, alertIds: [alertId], itemCount: 1 } })
        return true
      } catch (error) {
        if (isDuplicate(error)) continue
        throw error
      }
    }
    if (existing.status !== 'PENDING') return false
    const ids = Array.isArray(existing.alertIds) ? existing.alertIds.filter((item): item is string => typeof item === 'string') : []
    if (ids.includes(alertId)) return true
    const claimed = await db.alertDigest.updateMany({
      where: { id: existing.id, tenantId, status: 'PENDING' },
      data: { alertIds: ids.length < ALERT_IDS_CAP ? [...ids, alertId] : ids, itemCount: existing.itemCount + 1 },
    })
    // 刚好被别的进程发走了：本条不再并入这一批，由调用方立即通知
    return claimed.count > 0
  }
  return false
}

export interface NoticeRule {
  id: string
  notifyFrequency: AlertNotifyFrequency
  scope: Record<string, unknown>
}

/**
 * 这条预警的通知要不要延后：要则并入批次并返回 true（调用方不再发站内通知），否则返回 false（立即发）。
 * 严重级别一律立即发；频率不是“立即”的规则并入频率批次；静默时段内并入静默批次。
 */
export async function deferNotice(db: Db, tenantId: string, rule: NoticeRule, alertId: string, severity: string, now: Date, zone: string | null): Promise<boolean> {
  if (severity === 'CRITICAL') return false
  if (rule.notifyFrequency !== 'IMMEDIATE') return appendToDigest(db, tenantId, rule.id, 'FREQUENCY', `freq:${rule.id}:${frequencyBucket(rule.notifyFrequency, now, zone)}`, alertId)
  if (isQuietNow(now, zone, readQuietHours(rule.scope))) return appendToDigest(db, tenantId, rule.id, 'QUIET', `quiet:${rule.id}:pending`, alertId)
  return false
}

export interface DigestResult {
  /** 发出的汇总条数（批次数） */
  sent: number
  /** 汇总里包含的预警条数 */
  items: number
}

function bucketDue(key: string, frequency: AlertNotifyFrequency, now: Date, zone: string | null): boolean {
  if (frequency === 'IMMEDIATE') return true
  const bucket = key.split(':').slice(2).join(':')
  // 批次键的时段样式与规则当前的频率不一致（规则改过频率）：直接发出，不让它悬着
  const style = bucket.length === 13 ? 'HOURLY' : 'DAILY'
  if (style !== frequency) return true
  return frequencyBucket(frequency, now, zone) > bucket
}

/** 发出到期的汇总批次（调用方已在企业的租户上下文里）。 */
export async function flushDigests(db: Db, tenantId: string, now: Date, zone: string | null): Promise<DigestResult> {
  const result: DigestResult = { sent: 0, items: 0 }
  const pending = await db.alertDigest.findMany({ where: { tenantId, status: 'PENDING', kind: { in: ['FREQUENCY', 'QUIET'] } }, orderBy: { createdAt: 'asc' }, take: BATCH_LIMIT })
  for (const digest of pending) {
    const rule = await db.alertRule.findFirst({ where: { id: digest.ruleId, tenantId }, select: { id: true, name: true, domain: true, severity: true, scopeJson: true, notifyFrequency: true } })
    if (!rule) continue
    const scope = scopeOf(rule.scopeJson)
    const quiet = isQuietNow(now, zone, readQuietHours(scope))
    const frequency = (rule.notifyFrequency === 'HOURLY' || rule.notifyFrequency === 'DAILY' ? rule.notifyFrequency : 'IMMEDIATE') as AlertNotifyFrequency
    // 静默时段内什么批次都不发（等静默结束一起补发）；频率批次还要等所属时段结束
    if (quiet) continue
    if (digest.kind === 'FREQUENCY' && !bucketDue(digest.dedupKey, frequency, now, zone)) continue
    const claimed = await db.alertDigest.updateMany({
      where: { id: digest.id, tenantId, status: 'PENDING' },
      // 静默批次发送时换成带发送时间的键，下一个静默时段才能另起一批
      data: { status: 'SENT', sentAt: now, ...(digest.kind === 'QUIET' ? { dedupKey: `quiet:${rule.id}:${now.toISOString()}` } : {}) },
    })
    if (claimed.count === 0) continue
    const ids = Array.isArray(digest.alertIds) ? digest.alertIds.filter((item): item is string => typeof item === 'string') : []
    const alerts =
      ids.length > 0
        ? await db.alertInstance.findMany({
            where: { tenantId, id: { in: ids }, status: { in: OPEN } },
            select: { id: true, title: true, entityLabel: true },
            orderBy: { firstTriggeredAt: 'asc' },
            take: ALERT_IDS_CAP,
          })
        : []
    if (alerts.length === 0) continue
    const ownerId = await chooseOwner(db, tenantId, scope)
    if (!ownerId) continue
    const total = Math.max(alerts.length, digest.itemCount)
    await notifyUsers(db, tenantId, await recipientsOf(db, tenantId, scope, ownerId), {
      kind: 'ALERT_RULE',
      domain: rule.domain,
      title: digestTitle(rule.name, total, digest.kind === 'QUIET' ? 'QUIET' : 'FREQUENCY'),
      body: digestBody(
        alerts.map(alert => alert.entityLabel ?? alert.title ?? alert.id),
        total,
      ),
      link: digestLink(rule.id),
      severity: rule.severity === 'INFO' ? 'INFO' : 'WARNING',
      dedupKey: `alert-digest:${digest.id}`,
    })
    result.sent += 1
    result.items += total
  }
  return result
}

export interface EscalationResult {
  /** 发出的升级条数（预警 × 级别） */
  escalated: number
}

/** 一条预警的第 level（从 0 开始）级升级通知谁。 */
async function targetsOf(db: Db, tenantId: string, level: number, scope: Record<string, unknown>, ownerId: string | null): Promise<string[]> {
  if (level === 0) return ownerId ? [ownerId] : []
  if (level === 1) return notifyTargetsOf(db, tenantId, scope)
  return holdersOf(db, tenantId, 'alerts.manage')
}

/** 按规则设置的时限推进“未确认”预警的升级链（调用方已在企业的租户上下文里）。 */
export async function runEscalations(db: Db, tenantId: string, now: Date): Promise<EscalationResult> {
  const result: EscalationResult = { escalated: 0 }
  const rules = await db.alertRule.findMany({
    where: { tenantId, enabled: true },
    select: { id: true, name: true, domain: true, escalation: true, scopeJson: true },
    take: 500,
  })
  for (const rule of rules) {
    const levels = readEscalation(rule.escalation)
    if (levels.length === 0) continue
    const scope = scopeOf(rule.scopeJson)
    const cutoff = new Date(now.getTime() - levels[0].afterMinutes * 60_000)
    const alerts = await db.alertInstance.findMany({
      where: { tenantId, ruleId: rule.id, status: 'NEW', firstTriggeredAt: { lte: cutoff } },
      select: { id: true, title: true, entityLabel: true, firstTriggeredAt: true, workItemId: true },
      orderBy: { firstTriggeredAt: 'asc' },
      take: ESCALATION_ALERT_LIMIT,
    })
    if (alerts.length === 0) continue
    const done = new Set(
      (
        await db.alertDigest.findMany({
          where: { tenantId, ruleId: rule.id, kind: 'ESCALATION', dedupKey: { in: alerts.flatMap(alert => levels.map((_, level) => `esc:${alert.id}:${level}`)) } },
          select: { dedupKey: true },
          take: ESCALATION_ALERT_LIMIT * 3,
        })
      ).map(row => row.dedupKey),
    )
    const owners = new Map(
      (alerts.some(alert => alert.workItemId)
        ? await db.workItem.findMany({
            where: { tenantId, id: { in: alerts.flatMap(alert => (alert.workItemId ? [alert.workItemId] : [])) } },
            select: { id: true, ownerId: true },
            take: ESCALATION_ALERT_LIMIT,
          })
        : []
      ).map(row => [row.id, row.ownerId]),
    )
    const fallbackOwner = await chooseOwner(db, tenantId, scope)
    for (const alert of alerts) {
      const elapsed = now.getTime() - alert.firstTriggeredAt.getTime()
      for (const [level, config] of levels.entries()) {
        if (elapsed < config.afterMinutes * 60_000 || done.has(`esc:${alert.id}:${level}`)) continue
        try {
          await db.alertDigest.create({
            data: { tenantId, ruleId: rule.id, kind: 'ESCALATION', dedupKey: `esc:${alert.id}:${level}`, status: 'SENT', sentAt: now, alertIds: [alert.id], itemCount: 1 },
          })
        } catch (error) {
          if (isDuplicate(error)) continue
          throw error
        }
        const ownerId = (alert.workItemId ? owners.get(alert.workItemId) : null) ?? fallbackOwner
        const targets = await targetsOf(db, tenantId, level, scope, ownerId)
        if (targets.length === 0) continue
        const label = alert.entityLabel ?? alert.title ?? '预警'
        // 升级通知按“严重”级别发，穿透个人免打扰
        const sent = await notifyUsers(db, tenantId, targets, {
          kind: 'ALERT_RULE',
          domain: rule.domain,
          title: `预警未确认已升级（第 ${level + 1} 级）：${label}`.slice(0, 200),
          body: `规则“${rule.name}”触发的预警已超过 ${escalationMinutesText(config.afterMinutes)}仍没有人确认，已通知${ALERT_ESCALATION_TARGET_LABEL[level]}。请尽快确认或处理。`,
          link: entityDetailPath('ALERT', alert.id) ?? undefined,
          severity: 'CRITICAL',
          dedupKey: `alert-escalation:${alert.id}:${level}`,
        })
        if (sent > 0) result.escalated += 1
      }
    }
  }
  return result
}
