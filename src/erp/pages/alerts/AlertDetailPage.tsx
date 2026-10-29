import { useEffect, useRef } from 'react'
import { useParams } from '@tanstack/react-router'
import { Descriptions } from 'antd'
import type { AlertDetailResponse, AlertReadResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, EntityCollaboration, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { AlertActions } from './alert-actions'
import { EvidenceTab, HistoryTab, TimelineTab } from './alert-detail-parts'
import { AlertStatusTag, EntityCell, SeverityTag, impactText, ownerText } from './alerts-ui'

// 预警详情（P5-01，09 章 9.1）：身份区 → 建议动作 → 证据与规则 / 历史触发 / 处理记录；右侧是关联待办、关闭信息、评论与关注。
// 阈值是触发那一刻的规则版本留存的快照；买家个人信息不在预警里，这里不展示。

const metricsOf = (detail: AlertDetailResponse): IdentityMetric[] => {
  const alert = detail.alert
  return [
    { label: '严重度', value: <SeverityTag severity={alert.severity} /> },
    { label: '状态', value: <AlertStatusTag status={alert.status} label={alert.statusLabel} /> },
    { label: '负责人', value: ownerText(alert.owner) },
    { label: '影响金额', value: impactText(alert.impact) },
    { label: '首次触发', value: timeText(alert.firstTriggeredAt) },
    { label: '触发次数', value: <span className="erp-num">{alert.triggerCount}</span> },
  ]
}

function Rail({ detail }: { detail: AlertDetailResponse }) {
  const { alert, workItem, closeInfo } = detail
  return (
    <Descriptions size="small" column={1} data-testid="alert-rail">
      <Descriptions.Item label="预警对象">
        <EntityCell entity={alert.entity} />
      </Descriptions.Item>
      <Descriptions.Item label="店铺">{alert.storeName ?? '企业级'}</Descriptions.Item>
      <Descriptions.Item label="关联待办">
        {workItem ? <AppLink to={workItem.path}>查看待办（{workItem.dueAt ? `截止 ${workItem.dueAt.slice(0, 10)}` : '无截止时间'}）</AppLink> : <Muted>尚未分派，没有待办</Muted>}
      </Descriptions.Item>
      {closeInfo ? (
        <>
          <Descriptions.Item label="结论">{closeInfo.conclusionLabel ?? <Muted>尚无</Muted>}</Descriptions.Item>
          <Descriptions.Item label="处理人">{closeInfo.closedByName ?? '系统'}</Descriptions.Item>
          <Descriptions.Item label="备注">{closeInfo.note ?? <Muted>尚无记录</Muted>}</Descriptions.Item>
        </>
      ) : null}
    </Descriptions>
  )
}

export default function AlertDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { canPermission } = useSession()
  const query = useApiQuery<AlertDetailResponse>({ domain: 'list', path: `/alerts/${encodeURIComponent(id)}`, scoped: false })
  // 打开详情就算已读（只改我自己的已读状态，不改预警的处理状态）；每条预警在本页只标记一次，失败不打扰（下次进来再标）
  const { mutate: markRead } = useApiMutation<{ ids: string[] }, AlertReadResponse>({ method: 'POST', path: '/alerts/read', invalidate: ['realtime'], silent: true })
  const unread = query.data ? !query.data.alert.read : false
  const marked = useRef<string | null>(null)
  useEffect(() => {
    if (!unread || marked.current === id) return
    marked.current = id
    markRead({ ids: [id] })
  }, [unread, id, markRead])

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'alerts.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  const alert = detail.alert
  const evidenceText = detail.evidence
    .slice(0, 4)
    .map(row => `${row.label} ${row.value}`)
    .join('；')
  return (
    <DetailLayout
      title={alert.title}
      subtitle={`${alert.domainLabel} · ${alert.ruleName}`}
      metrics={metricsOf(detail)}
      primaryActions={<AlertActions detail={detail} onChanged={() => void query.refetch()} />}
      suggestions={
        alert.suggestedAction
          ? [
              {
                id: 'suggested',
                rule: alert.suggestedAction,
                evidence: evidenceText || '见“证据与规则”页签',
                impact: alert.impact ? '见上方影响金额（区间估算，不是确定值）' : '尚无依据估算',
                risk: `忽略或关闭后，同一对象在冷却期（${detail.rule.cooldownMinutes} 分钟）内再次命中不会重复提醒`,
              },
            ]
          : undefined
      }
      tabs={[
        { key: 'evidence', label: '证据与规则', children: <EvidenceTab detail={detail} canManage={canPermission('alerts.manage')} /> },
        { key: 'history', label: `历史触发（${detail.history.length}）`, children: <HistoryTab items={detail.history} /> },
        { key: 'timeline', label: '处理记录', children: <TimelineTab items={detail.timeline} /> },
      ]}
      rail={[
        { key: 'related', title: '关联信息', children: <Rail detail={detail} /> },
        { key: 'collab', title: '评论与协作', children: <EntityCollaboration entityType="ALERT" entityId={alert.id} /> },
      ]}
    />
  )
}
