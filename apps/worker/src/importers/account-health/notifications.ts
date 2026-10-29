import { ACCOUNT_STATUS_FRESHNESS_KEY, ACCOUNT_STATUS_METRIC_KEY, ACCOUNT_STATUS_NOTIFICATION_TYPE, normalizeAccountStatus } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { recordFreshness } from '../../freshness/record'
import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { NtfSchemaError } from '../notifications/hourly-parse'
import { readJson, resolveSellerAccountId, type HourlyProcessorDeps } from '../notifications/hourly-write'
import { localDay } from '../shared'

// 账户状态变化推送处理器（importers.md N-17，ACCOUNT_STATUS_CHANGED，P5-02）。推送接收端按 14.10 暂缓：没有接收端就不会有事件进来，
// 处理器先备好，事件由重放接口或将来的接收端交给它。字段名按官方文档整理（大小写与驼峰都容忍），未经真实推送验证（CR-092 未验证清单）：
//   payload.accountStatusChangedNotification 带 sellerId、previousAccountStatus、currentAccountStatus（NORMAL / AT_RISK / DEACTIVATED）。
// 写入：事件发生那一天（企业数据口径时区）的 ACCOUNT_STATUS 快照，来源记为 PUSH；当天已有更晚的记录（后到的报告）时不覆盖。
// 预警由预警评估器（account.status-changed）读快照生成，推送本身不直接建预警；“推送触发报告即时刷新”随接收端一起做。

const US = 'ATVPDKIKX0DER'
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const pick = (row: Record<string, unknown>, ...names: string[]): unknown => {
  for (const name of names) if (row[name] !== undefined) return row[name]
  return undefined
}

export interface ParsedStatusChange {
  eventTime: Date
  sellerId: string
  currentRaw: string
  current: NonNullable<ReturnType<typeof normalizeAccountStatus>>
  previousRaw: string | null
  marketplaceId: string
}

export function parseStatusChange(raw: unknown): ParsedStatusChange {
  const root = obj(raw)
  if (!root) throw new NtfSchemaError('通知根对象必须是对象')
  const type = text(root.notificationType)
  if (type !== ACCOUNT_STATUS_NOTIFICATION_TYPE) throw new NtfSchemaError(`期望 ${ACCOUNT_STATUS_NOTIFICATION_TYPE}，收到 ${type || '空'}`)
  const eventTime = new Date(text(root.eventTime))
  if (Number.isNaN(eventTime.getTime())) throw new NtfSchemaError('eventTime 不是合法时间')
  const payload = obj(root.payload)
  if (!payload) throw new NtfSchemaError('payload 必须是对象')
  const inner = obj(pick(payload, 'accountStatusChangedNotification', 'AccountStatusChangedNotification')) ?? payload
  const currentRaw = text(pick(inner, 'currentAccountStatus', 'CurrentAccountStatus', 'accountStatus', 'status'))
  const current = normalizeAccountStatus(currentRaw)
  if (!current) throw new NtfSchemaError(`账户状态无法识别：${currentRaw || '空'}`)
  const previousRaw = text(pick(inner, 'previousAccountStatus', 'PreviousAccountStatus')) || null
  return { eventTime, sellerId: text(pick(inner, 'sellerId', 'SellerId')), currentRaw, current, previousRaw, marketplaceId: text(pick(inner, 'marketplaceId', 'MarketplaceId')) || US }
}

async function snapshotDayOf(deps: HourlyProcessorDeps, tenantId: string, eventTime: Date): Promise<Date> {
  const tenant = await deps.db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  try {
    return localDay(tenant?.timezone || 'UTC', eventTime)
  } catch {
    return localDay('UTC', eventTime)
  }
}

export function createAccountStatusProcessor(deps: HourlyProcessorDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const parsed = parseStatusChange(await readJson(deps.storage, event.payloadObjectKey))
    if (parsed.marketplaceId !== US) return // 只做美国站
    const sellerAccountId = await resolveSellerAccountId(deps.db, event.tenantId, event.sellerAccountId, [parsed.sellerId])
    if (!sellerAccountId) return
    const snapshotDate = await snapshotDayOf(deps, event.tenantId, parsed.eventTime)
    const where = { tenantId_sellerAccountId_snapshotDate_metricKey: { tenantId: event.tenantId, sellerAccountId, snapshotDate, metricKey: ACCOUNT_STATUS_METRIC_KEY } }
    const existing = await deps.db.accountHealthSnapshot.findUnique({ where, select: { sourceUpdatedAt: true } })
    if (!existing || existing.sourceUpdatedAt.getTime() <= parsed.eventTime.getTime()) {
      const data = {
        marketplaceId: parsed.marketplaceId,
        metricGroup: 'STATUS',
        accountStatus: parsed.current,
        status: 'UNKNOWN',
        detailJson: { rawStatus: parsed.currentRaw, previousRawStatus: parsed.previousRaw } as Prisma.InputJsonValue,
        source: 'PUSH',
        sourceReportJobId: null,
        sourceUpdatedAt: parsed.eventTime,
        syncedAt: new Date(),
      }
      await deps.db.accountHealthSnapshot.upsert({ where, create: { tenantId: event.tenantId, sellerAccountId, snapshotDate, metricKey: ACCOUNT_STATUS_METRIC_KEY, ...data }, update: data })
    }
    await recordFreshness(deps.db, { tenantId: event.tenantId, sellerAccountId, sourceKey: ACCOUNT_STATUS_FRESHNESS_KEY, ok: true, rowCount: 1, dataThrough: parsed.eventTime })
  }
}

export function registerAccountStatusProcessor(registry: { register(type: string, processor: NotificationProcessor): unknown }, deps: HourlyProcessorDeps) {
  registry.register(ACCOUNT_STATUS_NOTIFICATION_TYPE, createAccountStatusProcessor(deps))
}
