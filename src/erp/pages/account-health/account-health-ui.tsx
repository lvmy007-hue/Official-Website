import type { ReactNode } from 'react'
import { Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ACCOUNT_STATUS_LABEL, formatHealthValue, type AccountStatus, type HealthMetricStatus, type HealthMetricView, type PolicyHandlingStatus, type PolicyIssueStatus } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'
import { SimpleGrid } from '../../components'

// 账户健康页面共用的小件：状态标签、指标取值与判定的写法、指标表。
// 没有数据的写法：没有值写“尚无记录”，没有目标写“报告没给目标”，没有统计周期写“报告未说明”，任何时候都不拿 0 或“正常”冒充。

const STATUS_COLOR: Record<AccountStatus, string> = { NORMAL: 'success', AT_RISK: 'warning', DEACTIVATED: 'error' }

export function AccountStatusTag({ status }: { status: AccountStatus | null }) {
  if (!status) return <Muted>尚无记录</Muted>
  return (
    <Tag color={STATUS_COLOR[status]} bordered={false}>
      {ACCOUNT_STATUS_LABEL[status]}
    </Tag>
  )
}

const METRIC_COLOR: Record<HealthMetricStatus, string> = { MET: 'success', NOT_MET: 'error', UNKNOWN: 'default' }

export function MetricStatusTag({ metric }: { metric: Pick<HealthMetricView, 'status' | 'statusLabel'> }) {
  return (
    <Tag color={METRIC_COLOR[metric.status]} bordered={false}>
      {metric.statusLabel}
    </Tag>
  )
}

export const valueCell = (metric: Pick<HealthMetricView, 'value' | 'unit'>): ReactNode =>
  metric.value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatHealthValue(metric.value, metric.unit)}</span>

export const windowCell = (days: number | null): ReactNode => (days === null ? <Muted>报告未说明</Muted> : <span className="erp-num">近 {days} 天</span>)

const metricColumns: ColumnsType<HealthMetricView> = [
  { title: '指标', dataIndex: 'label', width: 240 },
  { title: '当前值', key: 'value', width: 120, align: 'right', render: (_value, metric) => valueCell(metric) },
  { title: '目标', key: 'target', width: 160, render: (_value, metric) => metric.targetText ?? <Muted>报告没给目标</Muted> },
  { title: '统计周期', key: 'window', width: 120, render: (_value, metric) => windowCell(metric.windowDays) },
  { title: '判定', key: 'status', width: 120, render: (_value, metric) => <MetricStatusTag metric={metric} /> },
]

/** 指标表：行数很少，不分页；没有指标时写明原因而不是画空表。 */
export function MetricTable({ metrics, testId, empty }: { metrics: readonly HealthMetricView[]; testId: string; empty: string }) {
  if (metrics.length === 0) return <Muted>{empty}</Muted>
  return (
    <div data-testid={testId}>
      <SimpleGrid<HealthMetricView>
        gridId="account-health.account-health-ui"
        columns={metricColumns}
        rows={metrics as HealthMetricView[]}
        rowKey={metric => metric.key}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </div>
  )
}

const HANDLING_COLOR: Record<PolicyHandlingStatus, string> = { OPEN: 'default', IN_PROGRESS: 'processing', DONE: 'success' }

export function HandlingTag({ status, label }: { status: PolicyHandlingStatus; label: string }) {
  return (
    <Tag color={HANDLING_COLOR[status]} bordered={false}>
      {label}
    </Tag>
  )
}

export function IssueStatusTag({ status, label }: { status: PolicyIssueStatus; label: string }) {
  return (
    <Tag color={status === 'OPEN' ? 'error' : 'success'} bordered={false}>
      {label}
    </Tag>
  )
}
