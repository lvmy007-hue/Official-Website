import {
  ACCOUNT_HEALTH_ROLE_GUIDE,
  ACCOUNT_RATING_METRIC_KEY,
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_METRIC_KEY,
  HEALTH_METRIC_GROUPS,
  HEALTH_METRIC_STATUSES,
  HEALTH_TARGET_CONDITIONS,
  POLICY_ISSUE_KINDS,
  POLICY_ISSUE_KIND_LABEL,
  accountStatusChanges,
  healthMetricLabel,
  isOrderDefectTotal,
  orderDefectBreakdown,
  ratingStatusLabel,
  toMetricView,
  type AccountHealthState,
  type AccountHealthStoreView,
  type AccountHealthSync,
  type AccountStatus,
  type HealthMetricGroup,
  type HealthMetricStatus,
  type HealthMetricView,
  type HealthSource,
  type HealthTargetCondition,
  type HealthTrendPoint,
  type HealthTrendSeries,
  type PolicyIssueKind,
  type PolicyKindCount,
} from '@nova/api-contracts'
import { num, ymd } from './account-health-common'

// 一个店铺的账户健康视图（P5-02）：纯函数，把快照行整理成页面要的结构。
// 取数分两份：history（账户状态、评级、订单缺陷率的近 90 天历史，按日期升序）与 latest（最近一份快照里的全部指标）。

export interface SnapshotRecord {
  snapshotDate: Date
  metricKey: string
  metricGroup: string
  accountStatus: string
  status: string
  value: { toString(): string } | null
  target: { toString(): string } | null
  targetCondition: string | null
  unit: string | null
  windowDays: number | null
  detailJson: unknown
  source: string
}

export interface StoreViewInput {
  store: { id: string; name: string }
  /** 店铺有在用的亚马逊授权。 */
  connected: boolean
  sync: AccountHealthSync
  history: readonly SnapshotRecord[]
  latest: readonly SnapshotRecord[]
  latestDate: string | null
  openByKind: readonly { kind: string; count: number }[]
}

const isStatus = (value: string): value is AccountStatus => value in ACCOUNT_STATUS_LABEL
const groupOf = (value: string): HealthMetricGroup => ((HEALTH_METRIC_GROUPS as readonly string[]).includes(value) ? (value as HealthMetricGroup) : 'OTHER')
const metricStatusOf = (value: string): HealthMetricStatus => ((HEALTH_METRIC_STATUSES as readonly string[]).includes(value) ? (value as HealthMetricStatus) : 'UNKNOWN')
const conditionOf = (value: string | null): HealthTargetCondition | null => ((HEALTH_TARGET_CONDITIONS as readonly string[]).includes(value ?? '') ? (value as HealthTargetCondition) : null)
const sourceOf = (value: string): HealthSource => (value === 'PUSH' ? 'PUSH' : 'REPORT')
const ratingStatusOf = (detail: unknown): string | null => {
  const value = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).ratingStatus : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metricView(row: SnapshotRecord): HealthMetricView {
  return toMetricView({
    metricKey: row.metricKey,
    metricGroup: groupOf(row.metricGroup),
    value: num(row.value),
    target: num(row.target),
    targetCondition: conditionOf(row.targetCondition),
    status: metricStatusOf(row.status),
    unit: row.unit,
    windowDays: row.windowDays,
  })
}

const byKey = (a: HealthMetricView, b: HealthMetricView) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

function trendOf(rows: readonly SnapshotRecord[]): HealthTrendPoint[] {
  return rows
    .filter(row => row.value !== null)
    .map(row => ({ date: ymd(row.snapshotDate), value: num(row.value) as number }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

function noDataNote(input: StoreViewInput): { state: AccountHealthState; note: string } {
  if (!input.connected) return { state: 'NOT_CONNECTED', note: '这个店铺还没有接入亚马逊授权，没有账户健康数据；接入后每日同步一次' }
  if (input.sync.rolePending) return { state: 'ROLE_PENDING', note: ACCOUNT_HEALTH_ROLE_GUIDE }
  if (input.sync.status === 'FAILED' || input.sync.status === 'UNAUTHORIZED') return { state: 'NO_DATA', note: input.sync.errorMessage ?? '账户健康报告同步失败，请到同步中心查看原因' }
  return { state: 'NO_DATA', note: '已接入，但还没有同步到账户健康报告；报告每日同步一次，首次同步后出现' }
}

export function buildStoreView(input: StoreViewInput): AccountHealthStoreView {
  const statusRows = input.history.filter(row => row.metricKey === ACCOUNT_STATUS_METRIC_KEY && isStatus(row.accountStatus)).sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime())
  const days = statusRows.map(row => ({ date: ymd(row.snapshotDate), status: row.accountStatus as AccountStatus }))
  const changes = accountStatusChanges(days)
  const lastChange = changes.at(-1)
  const lastRow = statusRows.at(-1)
  const ratingRows = input.history.filter(row => row.metricKey === ACCOUNT_RATING_METRIC_KEY).sort((a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime())
  const ratingRow = ratingRows.at(-1)
  const rating = ratingRow ? { score: num(ratingRow.value), status: ratingStatusOf(ratingRow.detailJson), statusLabel: ratingStatusLabel(ratingStatusOf(ratingRow.detailJson)) } : null

  const metrics = input.latest.filter(row => groupOf(row.metricGroup) !== 'STATUS' && groupOf(row.metricGroup) !== 'RATING').map(metricView)
  const odr = metrics.filter(metric => metric.group === 'ORDER_DEFECT')
  const breakdown = orderDefectBreakdown(odr)
  const used = new Set(breakdown.flatMap(item => (item.metric ? [item.metric.key] : [])))
  const trend: HealthTrendSeries[] = [...new Set(input.history.filter(row => isOrderDefectTotal(row.metricKey)).map(row => row.metricKey))].sort().map(key => {
    const rows = input.history.filter(row => row.metricKey === key)
    return { key, label: healthMetricLabel(key), unit: rows.at(-1)?.unit ?? null, points: trendOf(rows) }
  })
  const openByKind: PolicyKindCount[] = input.openByKind
    .map(item => ({ kind: ((POLICY_ISSUE_KINDS as readonly string[]).includes(item.kind) ? item.kind : 'OTHER') as PolicyIssueKind, count: item.count }))
    .reduce<PolicyKindCount[]>((list, item) => {
      const existing = list.find(entry => entry.kind === item.kind)
      if (existing) existing.count += item.count
      else list.push({ kind: item.kind, label: POLICY_ISSUE_KIND_LABEL[item.kind], count: item.count })
      return list
    }, [])
  const openCount = openByKind.reduce((sum, item) => sum + item.count, 0)

  const empty = input.history.length === 0 && input.latest.length === 0 && openCount === 0
  const noData = empty ? noDataNote(input) : null
  return {
    sellerAccountId: input.store.id,
    storeName: input.store.name,
    state: noData?.state ?? 'OK',
    note: noData?.note ?? null,
    sync: input.sync,
    snapshotDate: input.latestDate,
    accountStatus: {
      status: lastRow ? (lastRow.accountStatus as AccountStatus) : null,
      label: lastRow ? ACCOUNT_STATUS_LABEL[lastRow.accountStatus as AccountStatus] : null,
      asOf: lastRow ? ymd(lastRow.snapshotDate) : null,
      source: lastRow ? sourceOf(lastRow.source) : null,
      previousStatus: lastChange?.previousStatus ?? null,
      previousLabel: lastChange?.previousLabel ?? null,
      changedAt: lastChange && lastChange.previousStatus !== null ? lastChange.date : null,
    },
    rating,
    ratingTrend: trendOf(ratingRows),
    statusHistory: changes,
    orderDefect: { metrics: odr.filter(metric => !used.has(metric.key)).sort(byKey), breakdown, trend },
    policy: { metrics: metrics.filter(metric => metric.group === 'POLICY').sort(byKey), openByKind, openCount },
    other: metrics.filter(metric => metric.group === 'OTHER').sort(byKey),
  }
}
