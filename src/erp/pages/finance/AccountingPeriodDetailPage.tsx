import { useState } from 'react'
import { Alert } from 'antd'
import { useParams } from '@tanstack/react-router'
import type { PeriodDetail, PeriodDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { timeText } from '../orders/orders-ui'
import { ApproveActions, CheckAction, CloseAction, ReopenAction } from './periods-actions'
import { ChecklistTab } from './periods-checklist'
import { PreviewTab } from './periods-preview'
import { SnapshotsTab } from './periods-snapshots'
import { PeriodStatusTag, checkText, personText, rangeText } from './periods-ui'

// 期间关账详情（P2b-13，07 章 7.12）：身份区 ≤6 项 → 完整性检查 / 关账报表预览 / 快照与差异。
// 流程：运行检查（通过 → 关账中）→ 另一位有权限的成员审批 → 锁定（再次验证身份，保存快照）；已关账的期间只能由更高权限的人重新开账。

const APPROVAL_TEXT = { APPROVED: '已通过', REJECTED: '已驳回' } as const

const metricsOf = (period: PeriodDetail): IdentityMetric[] => [
  { label: '状态', value: <PeriodStatusTag status={period.status} /> },
  { label: '店铺', value: period.storeName },
  { label: '日期范围', value: rangeText(period.periodStart, period.periodEnd) },
  { label: '完整性检查', value: checkText(period.checkPassed) },
  {
    label: '审批',
    value: period.approvalDecision ? (
      <>
        {APPROVAL_TEXT[period.approvalDecision]}（{personText(period.approvedBy)}）
      </>
    ) : (
      '尚未审批'
    ),
  },
  { label: '最近关账', value: period.closedAt ? timeText(period.closedAt) : '尚未关账' },
]

function StatusExtra({ period }: { period: PeriodDetail }) {
  return (
    <div style={{ marginTop: 8 }} data-testid="period-status-note">
      <Alert type={period.status === 'CLOSED' ? 'success' : 'info'} showIcon message={period.statusNote} />
      {period.closedAt ? (
        <p style={{ margin: '8px 0 0' }}>
          最近关账：{personText(period.closedBy)} · {timeText(period.closedAt)}（共关账 {period.closeCount} 次）
        </p>
      ) : null}
      {period.approvalComment ? <p style={{ margin: '8px 0 0' }}>审批意见：{period.approvalComment}</p> : null}
      {period.reopenReason ? (
        <p style={{ margin: '8px 0 0' }}>
          上次重新开账：{personText(period.reopenedBy)} · {timeText(period.reopenedAt)}，原因：{period.reopenReason}
        </p>
      ) : null}
    </div>
  )
}

export default function AccountingPeriodDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState('checklist')
  const query = useApiQuery<PeriodDetailResponse>({ domain: 'list', path: `/finance/periods/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'finance.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const data = query.data
  const { period, actions } = data
  return (
    <DetailLayout
      title={`${period.storeName} ${period.month} 关账`}
      subtitle={`已关账 ${period.closeCount} 次`}
      metrics={metricsOf(period)}
      identityExtra={<StatusExtra period={period} />}
      primaryActions={
        period.status === 'CLOSED' ? (
          <ReopenAction period={period} actions={actions} />
        ) : (
          <>
            <CheckAction period={period} actions={actions} />
            <ApproveActions period={period} actions={actions} />
            <CloseAction period={period} actions={actions} />
          </>
        )
      }
      activeTab={tab}
      onTabChange={setTab}
      tabs={[
        { key: 'checklist', label: '完整性检查', children: <ChecklistTab data={data} /> },
        { key: 'preview', label: '关账报表预览', children: <PreviewTab preview={data.preview} /> },
        { key: 'snapshots', label: `快照与差异${data.snapshots.length ? `（${data.snapshots.length}）` : ''}`, children: <SnapshotsTab data={data} /> },
      ]}
    />
  )
}
