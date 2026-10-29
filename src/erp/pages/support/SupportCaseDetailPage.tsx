import { useParams } from '@tanstack/react-router'
import { Alert, Descriptions } from 'antd'
import type { SupportCaseDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { ContactTimeline, SupportStatusTag, SyncNotice, contactCountText } from './support-ui'

// 支持案件详情（P2b-04，07 章 7.4）：身份区 ≤6 项 → 沟通记录 / 概览（预约回电、关联对象）。只读，所有修改都在卖家后台进行。
// 附件只保存名称（亚马逊给的下载链接 15 分钟失效）；买家邮箱、电话号码不保存。

const metricsOf = (detail: SupportCaseDetailResponse): IdentityMetric[] => {
  const row = detail.case
  return [
    { label: '状态', value: <SupportStatusTag row={row} /> },
    { label: '店铺', value: row.storeName },
    { label: '创建时间', value: timeText(row.createdAt) },
    { label: '最近更新', value: timeText(row.updatedAt) },
    { label: '解决时间', value: timeText(row.resolvedAt) },
    { label: '沟通条数', value: contactCountText(row.contactCount) },
  ]
}

function ContactsTab({ detail }: { detail: SupportCaseDetailResponse }) {
  return (
    <div>
      {detail.contactsNote ? <Alert type={detail.contactsState === 'OK' ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }} message={detail.contactsNote} data-testid="contacts-note" /> : null}
      <ContactTimeline contacts={detail.contacts} />
    </div>
  )
}

function OverviewTab({ detail }: { detail: SupportCaseDetailResponse }) {
  const { case: row, links } = detail
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="support-overview">
        <Descriptions.Item label="案件编号">{row.caseId}</Descriptions.Item>
        <Descriptions.Item label="店铺">{row.storeName}</Descriptions.Item>
        <Descriptions.Item label="主题" span={2}>
          {row.subject}
        </Descriptions.Item>
        <Descriptions.Item label="我方最近一次回复">{timeText(row.lastOutboundAt)}</Descriptions.Item>
        <Descriptions.Item label="赔付案件">
          {links.reimbursement ? (
            <LiveLink component="ReimbursementDetailPage" id={links.reimbursement.id}>
              {links.reimbursement.caseNo}（{links.reimbursement.statusLabel}）
            </LiveLink>
          ) : (
            <Muted>尚无关联：赔付案件里回填同一个亚马逊案件编号后会自动关联</Muted>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="货件" span={2}>
          {links.shipments.length ? (
            links.shipments.map(item => (
              <div key={item.ref}>
                <LiveLink component="ShipmentReceivingDetailPage" id={item.ref}>
                  {item.label}
                </LiveLink>
                <Muted>{item.via === 'SUBJECT' ? '（按案件主题里的货件编号推算）' : '（来自赔付案件的证据）'}</Muted>
              </div>
            ))
          ) : (
            <Muted>尚无关联</Muted>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="商品" span={2}>
          {links.products.length ? (
            links.products.map(item => (
              <div key={item.id}>
                <LiveLink component="Asin360Page" id={item.id}>
                  {item.sku}
                </LiveLink>
                {item.asin ? <Muted>（{item.asin}）</Muted> : null}
              </div>
            ))
          ) : (
            <Muted>尚无关联</Muted>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="预约回电" span={2}>
          {detail.appointments.length ? (
            detail.appointments.map(item => (
              <div key={item.appointmentId}>
                {item.statusLabel}：<span className="erp-num">{formatDateTime(item.earliestAt)}</span> 至 <span className="erp-num">{formatDateTime(item.latestAt)}</span>
                {item.answeringParty ? `（${item.answeringParty}）` : ''}
              </div>
            ))
          ) : (
            <Muted>尚无记录</Muted>
          )}
        </Descriptions.Item>
      </Descriptions>
      <Muted>这里只读：回复、上传附件、预约回电请在亚马逊卖家后台进行。</Muted>
    </div>
  )
}

export default function SupportCaseDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<SupportCaseDetailResponse>({ domain: 'list', path: `/support-cases/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'support.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  return (
    <div>
      <SyncNotice sync={detail.sync} />
      <DetailLayout
        title={`支持案件 ${detail.case.caseId}`}
        subtitle={detail.case.subject}
        metrics={metricsOf(detail)}
        freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
        tabs={[
          { key: 'contacts', label: '沟通记录', children: <ContactsTab detail={detail} /> },
          { key: 'overview', label: '概览', children: <OverviewTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
