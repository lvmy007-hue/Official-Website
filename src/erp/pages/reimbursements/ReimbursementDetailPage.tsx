import { useParams } from '@tanstack/react-router'
import { Space } from 'antd'
import type { CaseDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, EntityCollaboration, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { CaseActions } from './case-actions'
import { EvidenceTab, Overview, RecordsTab } from './case-tabs'
import { CaseStatusTag, amountOr, dayText, receivedText } from './reimbursements-ui'

// 赔付案件详情（P2b-03，07 章 7.3）：身份区 ≤6 项关键指标 → 概览 / 证据与附件 / 官方赔付匹配；评论与关注在右侧。
// 提交在亚马逊卖家后台完成（他们的支持接口只能读取），这里记录状态、回填案件编号、固化证据包；到账由官方赔付明细自动匹配。

const metricsOf = (detail: CaseDetailResponse): IdentityMetric[] => {
  const row = detail.case
  return [
    { label: '状态', value: <CaseStatusTag status={row.status} /> },
    { label: '应收', value: amountOr(row.expectedAmount, row.currency, '尚未填写') },
    { label: '亚马逊批准', value: amountOr(row.approvedAmount, row.currency, '尚无记录') },
    { label: '实收', value: receivedText(row.receivedAmount, row.currency) },
    { label: '亚马逊案件编号', value: row.amazonCaseId ?? <Muted>尚未回填</Muted> },
    { label: '申请截止', value: dayText(row.deadlineAt) },
  ]
}

const statusesOf = (detail: CaseDetailResponse): StatusTag[] => [{ text: detail.case.ruleLabel }]

export default function ReimbursementDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<CaseDetailResponse>({ domain: 'list', path: `/reimbursements/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'reimbursements.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  const refresh = () => void query.refetch()
  return (
    <DetailLayout
      title={`赔付案件 ${detail.case.caseNo}`}
      subtitle={`${detail.case.storeName} · ${detail.case.sku ?? '无 SKU'}${detail.case.qty === null ? '' : ` × ${detail.case.qty}`}`}
      statuses={statusesOf(detail)}
      metrics={metricsOf(detail)}
      freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
      primaryActions={
        <Space wrap>
          <CaseActions detail={detail} onChanged={refresh} />
        </Space>
      }
      tabs={[
        { key: 'overview', label: '概览', children: <Overview detail={detail} /> },
        { key: 'evidence', label: '证据与附件', children: <EvidenceTab detail={detail} onChanged={refresh} /> },
        { key: 'records', label: '官方赔付匹配', children: <RecordsTab detail={detail} /> },
      ]}
      rail={[{ key: 'collab', title: '评论与关注', children: <EntityCollaboration entityType="REIMBURSEMENT_CASE" entityId={detail.case.id} /> }]}
    />
  )
}
