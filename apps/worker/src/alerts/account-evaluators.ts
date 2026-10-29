import {
  ACCOUNT_HEALTH_LIMITS,
  ACCOUNT_STATUS_METRIC_KEY,
  accountStatusChanges,
  formatHealthValue,
  healthMetricLabel,
  targetText,
  type AccountStatus,
  type HealthMetricGroup,
  type HealthTargetCondition,
} from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'

// 账户健康类预警评估器（P5-02，09 章 9.1 系统与账户域）：账户状态变化、账户健康指标未达标。
// 数据来自卖家表现报告（每日一份快照）与账户状态推送写下的 AccountHealthSnapshot；都是店铺级对象，没有 SKU 维度。
// 评估器返回“此刻仍然成立”的完整命中集合：状态恢复正常、指标恢复达标、快照过期后，下一轮评估预警自动恢复。

const DAY_MS = 86_400_000
const READ_LIMIT = ACCOUNT_HEALTH_LIMITS.readRows + 1

const dayOf = (date: Date) => date.toISOString().slice(0, 10)
const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

export interface StatusDay {
  sellerAccountId: string
  snapshotDate: Date
  accountStatus: string
}

const STATUS_VALUES = ['AT_RISK', 'DEACTIVATED'] as const satisfies readonly AccountStatus[]
const isStatus = (value: string): value is AccountStatus => value === 'NORMAL' || value === 'AT_RISK' || value === 'DEACTIVATED'

/**
 * 账户状态变化：按店铺取每日状态的变化点，最近一次变化发生在回看天数之内、变化后的状态仍是当前状态且在提醒的目标状态里、
 * 并且有“变化之前的状态”（第一次出现的状态不算变化）。一个店铺最多一个命中。
 */
export function buildStatusHits(rows: readonly StatusDay[], storeNames: ReadonlyMap<string, string>, params: { lookbackDays: number; statuses: readonly AccountStatus[] }, now: Date): AlertHit[] {
  const byStore = new Map<string, { date: string; status: AccountStatus }[]>()
  for (const row of [...rows].sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime())) {
    if (!isStatus(row.accountStatus)) continue
    const list = byStore.get(row.sellerAccountId) ?? []
    list.push({ date: dayOf(row.snapshotDate), status: row.accountStatus })
    byStore.set(row.sellerAccountId, list)
  }
  const earliest = dayOf(new Date(startOfUtcDay(now).getTime() - params.lookbackDays * DAY_MS))
  const hits: { at: string; hit: AlertHit }[] = []
  for (const [storeId, days] of byStore) {
    const last = accountStatusChanges(days).at(-1)
    if (!last || last.previousStatus === null || last.date < earliest || !params.statuses.includes(last.status)) continue
    if (days.at(-1)?.status !== last.status) continue
    const store = storeNames.get(storeId) ?? '店铺'
    hits.push({
      at: last.date,
      hit: {
        entityType: 'STORE',
        entityId: storeId,
        sellerAccountId: storeId,
        entityLabel: store,
        title: `${store} 的账户状态从“${last.previousLabel}”变为“${last.label}”`,
        suggestedAction: '到账户健康页查看订单缺陷与政策合规问题，按亚马逊的要求提交申诉或整改计划；状态数据来自每日的账户健康报告，可能比卖家后台晚一天',
        evidence: { storeName: store, from: last.previousStatus, fromLabel: last.previousLabel, to: last.status, toLabel: last.label, changedOn: last.date, hasWorsened: last.worse },
      },
    })
  }
  return hits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(item => item.hit)
}

export const statusChangedEvaluator: AlertEvaluator = {
  type: 'account.status-changed',
  async evaluate({ db, tenantId, rule, now }) {
    const scope = scopeFilter(rule)
    const params = {
      lookbackDays: numberParam(rule, 'lookbackDays', 7, { min: 1, max: 30 }),
      statuses: choiceListParam(rule, 'statuses', STATUS_VALUES, STATUS_VALUES),
    }
    const since = new Date(startOfUtcDay(now).getTime() - ACCOUNT_HEALTH_LIMITS.trendDays * DAY_MS)
    const rows = await db.accountHealthSnapshot.findMany({
      where: { tenantId, metricKey: ACCOUNT_STATUS_METRIC_KEY, snapshotDate: { gte: since }, ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}) },
      select: { sellerAccountId: true, snapshotDate: true, accountStatus: true },
      orderBy: [{ sellerAccountId: 'asc' }, { snapshotDate: 'asc' }],
      take: READ_LIMIT,
    })
    if (rows.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(rows.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    return buildStatusHits(rows, new Map(stores.map(store => [store.id, store.displayName])), params, now)
  },
}

export interface MetricDay {
  sellerAccountId: string
  snapshotDate: Date
  metricKey: string
  metricGroup: string
  status: string
  value: unknown
  target: unknown
  targetCondition: string | null
  unit: string | null
  windowDays: number | null
}

const numeric = (value: unknown): number | null => {
  const parsed = value === null || value === undefined ? NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 账户健康指标未达标：每个店铺只看“最近一份快照”（在最长天数之内），该快照里关注分组的指标有未达标的（报告自带目标且当前不满足）就是一个命中。
 * 最近一份快照里所有指标都达标（或报告没给目标）时不命中——更早的快照不参与，所以指标恢复达标后预警会恢复。
 */
export function buildDeclineHits(rows: readonly MetricDay[], storeNames: ReadonlyMap<string, string>): AlertHit[] {
  const latest = new Map<string, string>()
  for (const row of rows) {
    const date = dayOf(row.snapshotDate)
    if ((latest.get(row.sellerAccountId) ?? '') < date) latest.set(row.sellerAccountId, date)
  }
  const failing = new Map<string, MetricDay[]>()
  for (const row of rows) {
    if (row.status !== 'NOT_MET' || dayOf(row.snapshotDate) !== latest.get(row.sellerAccountId)) continue
    failing.set(row.sellerAccountId, [...(failing.get(row.sellerAccountId) ?? []), row])
  }
  const hits: AlertHit[] = []
  for (const [storeId, list] of failing) {
    const store = storeNames.get(storeId) ?? '店铺'
    const metrics = [...list]
      .sort((a, b) => (a.metricKey < b.metricKey ? -1 : a.metricKey > b.metricKey ? 1 : 0))
      .map(row => ({
        key: row.metricKey,
        label: healthMetricLabel(row.metricKey),
        value: numeric(row.value),
        valueText: formatHealthValue(numeric(row.value), row.unit),
        targetText: targetText(numeric(row.target), (row.targetCondition as HealthTargetCondition | null) ?? null, row.unit),
        windowDays: row.windowDays,
      }))
    const names = metrics.slice(0, 3).map(metric => metric.label)
    hits.push({
      entityType: 'STORE',
      entityId: storeId,
      sellerAccountId: storeId,
      entityLabel: store,
      title: `${store} 有 ${metrics.length} 项账户健康指标未达标：${names.join('、')}${metrics.length > 3 ? ' 等' : ''}`,
      suggestedAction: '到账户健康页查看未达标的指标与对应的政策问题；目标值来自亚马逊报告，请按亚马逊的要求整改',
      evidence: { storeName: store, snapshotDate: latest.get(storeId) ?? null, metrics },
    })
  }
  return hits.sort((a, b) => (a.entityLabel ?? '').localeCompare(b.entityLabel ?? ''))
}

const GROUP_VALUES = ['ORDER_DEFECT', 'POLICY', 'OTHER'] as const satisfies readonly HealthMetricGroup[]

export const healthDeclineEvaluator: AlertEvaluator = {
  type: 'account.health-decline',
  async evaluate({ db, tenantId, rule, now }) {
    const scope = scopeFilter(rule)
    const maxAgeDays = numberParam(rule, 'maxAgeDays', 3, { min: 1, max: 14 })
    const groups = choiceListParam(rule, 'groups', GROUP_VALUES, ['ORDER_DEFECT', 'POLICY'])
    const since = new Date(startOfUtcDay(now).getTime() - maxAgeDays * DAY_MS)
    const rows = await db.accountHealthSnapshot.findMany({
      where: { tenantId, metricGroup: { in: groups }, snapshotDate: { gte: since }, ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}) },
      select: { sellerAccountId: true, snapshotDate: true, metricKey: true, metricGroup: true, status: true, value: true, target: true, targetCondition: true, unit: true, windowDays: true },
      orderBy: [{ snapshotDate: 'desc' }, { sellerAccountId: 'asc' }, { metricKey: 'asc' }],
      take: READ_LIMIT,
    })
    if (rows.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(rows.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    return buildDeclineHits(rows, new Map(stores.map(store => [store.id, store.displayName])))
  },
}
