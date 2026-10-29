import { useParams } from '@tanstack/react-router'
import { Card, Descriptions, Space, Tag } from 'antd'
import type { AttachmentRow, InboundShipmentView } from '@nova/api-contracts'
import { DataState, PageHeader, stateFromError } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { AttachmentsPanel } from '../procurement/procurement-ui'
import { diffText, qty, shipmentStatusText, timeText } from './inbound-ui'
import { AuditSection, DiscrepancySections, TimelineSection } from './receiving-sections'

// 货件接收详情（P2a-13，06 章 6.12）：货件身份、接收时间线、SKU 差异（含差异原因）、不合规问题、证据附件、赔付任务、审计记录。
// 证据附件（装箱单、提单、签收证明）挂在货件上，上传需要 inbound.plan.write；下载走几分钟内有效的签名链接。

type Detail = InboundShipmentView & { planId: string; planName: string; sellerAccountId: string; transportStatus: string | null }

const text = (value: string | null | undefined) => value ?? <Muted>尚无记录</Muted>

function Identity({ detail }: { detail: Detail }) {
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered data-testid="shipment-identity">
      <Descriptions.Item label="货件编号">{detail.shipmentId}</Descriptions.Item>
      <Descriptions.Item label="亚马逊确认号">{text(detail.shipmentConfirmationId)}</Descriptions.Item>
      <Descriptions.Item label="所属入仓计划">
        <AppLink to={`/app/supply-chain/${encodeURIComponent(detail.planId)}`}>{detail.planName}</AppLink>
      </Descriptions.Item>
      <Descriptions.Item label="目的运营中心">{text(detail.destinationFc)}</Descriptions.Item>
      <Descriptions.Item label="货件状态">
        <Tag bordered={false}>{shipmentStatusText(detail.status)}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="运输状态">{text(detail.transportStatus)}</Descriptions.Item>
      <Descriptions.Item label="承运商">{text(detail.carrier)}</Descriptions.Item>
      <Descriptions.Item label="追踪号">{text(detail.trackingNumber)}</Descriptions.Item>
      <Descriptions.Item label="箱数">{qty(detail.boxCount)}</Descriptions.Item>
      <Descriptions.Item label="应发 / 已收">
        {qty(detail.units)} / {qty(detail.receivedUnits)}
      </Descriptions.Item>
      <Descriptions.Item label="差异（应发−已收）">{diffText(detail.discrepancyUnits)}</Descriptions.Item>
      <Descriptions.Item label="首次接收 / 接收完成">
        {timeText(detail.receivedFirstAt)} / {timeText(detail.receivedDoneAt)}
      </Descriptions.Item>
    </Descriptions>
  )
}

export default function ShipmentReceivingDetailPage() {
  // 地址里可以是货件行编号，也可以是亚马逊的货件编号或确认号（库存台账的参考编号）；取到货件后一律用行编号请求其余内容
  const { shipmentId: ref } = useParams({ strict: false }) as { shipmentId: string }
  const query = useApiQuery<Detail>({ domain: 'list', path: `/inbound/shipments/${encodeURIComponent(ref)}`, scoped: false })
  const id = query.data?.id ?? ref
  const path = `/inbound/shipments/${encodeURIComponent(id)}`
  const attachments = useApiQuery<AttachmentRow[]>({ domain: 'list', path: `${path}/attachments`, scoped: false, enabled: !!query.data })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inbound.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data

  return (
    <div>
      <PageHeader title={`货件 ${detail.shipmentId}`} description="货件的接收情况、SKU 差异、不合规问题、证据附件与赔付任务。" />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <AppLink to="/app/warehouse">返回货件接收与差异</AppLink>
        <Identity detail={detail} />
        <TimelineSection id={id} />
        <DiscrepancySections id={id} />
        <Card size="small" title="证据附件">
          {attachments.error ? (
            <DataState {...stateFromError(describeError(attachments.error), { onRetry: () => void attachments.refetch() })} />
          ) : attachments.data ? (
            <AttachmentsPanel base={path} items={attachments.data} writePermission="inbound.plan.write" onChanged={() => void attachments.refetch()} />
          ) : (
            <DataState kind="skeleton" rows={2} />
          )}
        </Card>
        <AuditSection id={id} />
      </Space>
    </div>
  )
}
