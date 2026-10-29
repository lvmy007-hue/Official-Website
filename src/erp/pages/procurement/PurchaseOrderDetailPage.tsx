import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Alert, Card, Steps } from 'antd'
import { PAYMENT_STATUS_LABEL, PO_BRANCH_STATUSES, PO_DETAIL_TABS, PO_DETAIL_TAB_LABEL, PO_STEPS, PO_STATUS_LABEL, type PoDetailTab, type PurchaseOrderDetail } from '@nova/api-contracts'
import { DataState, DetailLayout, EntityCollaboration, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { formatDate, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { PoActions } from './po-actions'
import { ApprovalTab, AttachmentsTab, BasicTab, LinesTab, LinksTab, LogTab, PaymentTab } from './po-tabs'
import { InspectionTab, ReceivingTab } from './po-tabs-receiving'
import { PoDrawer } from './PoDrawer'
import { count, money } from './procurement-ui'

// 采购订单详情（P2a-10，06 章 6.7）：步骤条（草稿 → 待审批 → 已下单 → 生产中 → 部分到货 → 全部到货 → 已关闭；取消与退货是分支）
// → 身份区 → 9 个页签。动作按钮由服务端按状态给出；金额类内容需要字段权限 field.cost。

const STEP_ORDER = PO_STEPS as readonly string[]

function StepBar({ status }: { status: string }) {
  const branch = (PO_BRANCH_STATUSES as readonly string[]).includes(status)
  const current = STEP_ORDER.indexOf(status)
  return (
    <Card size="small" data-testid="po-steps">
      <Steps size="small" current={branch ? -1 : current} items={PO_STEPS.map(step => ({ title: PO_STATUS_LABEL[step] }))} />
      {branch ? <Alert type={status === 'CANCELLED' ? 'info' : 'error'} showIcon style={{ marginTop: 8 }} message={`订单已${status === 'CANCELLED' ? '取消' : '退货给供应商'}，流程终止`} /> : null}
    </Card>
  )
}

function metrics(detail: PurchaseOrderDetail): IdentityMetric[] {
  const { order } = detail
  return [
    { label: '订单金额', value: money(order.totalAmount, order.currency) },
    { label: '已付金额', value: money(order.paidAmount, order.currency) },
    { label: '订购数量', value: count(order.orderedQty) },
    { label: '已收数量', value: count(order.receivedQty) },
    { label: '收货进度', value: order.receiveRatio === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(order.receiveRatio * 100, { digits: 0 })}%</span> },
    { label: '预计到货', value: order.expectedDate ? formatDate(order.expectedDate) : <Muted>未填写</Muted> },
  ]
}

function statuses(detail: PurchaseOrderDetail): StatusTag[] {
  const { order } = detail
  const tags: StatusTag[] = [
    { text: order.statusLabel, color: order.status === 'RECEIVED' ? 'success' : order.status === 'PENDING_APPROVAL' ? 'warning' : order.status === 'RETURNED_TO_SUPPLIER' ? 'error' : 'processing' },
  ]
  tags.push({ text: PAYMENT_STATUS_LABEL[order.paymentStatus] ?? order.paymentStatus, color: order.paymentStatus === 'PAID' ? 'success' : 'default' })
  if (order.deviation) tags.push({ text: `交期晚于需求 ${order.deviation.lateDays} 天`, color: 'warning' })
  return tags
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState<PoDetailTab>('basic')
  const [editing, setEditing] = useState(false)
  const query = useApiQuery<PurchaseOrderDetail>({ domain: 'list', path: `/purchase-orders/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'purchase.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { order } = detail
  const body: Record<PoDetailTab, JSX.Element> = {
    basic: <BasicTab detail={detail} />,
    lines: <LinesTab detail={detail} />,
    approval: <ApprovalTab detail={detail} />,
    payment: <PaymentTab detail={detail} />,
    receiving: <ReceivingTab detail={detail} />,
    inspection: <InspectionTab detail={detail} />,
    attachments: <AttachmentsTab detail={detail} onChanged={() => void query.refetch()} />,
    links: <LinksTab detail={detail} />,
    log: <LogTab detail={detail} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/purchase-orders">返回采购订单</AppLink>
      <StepBar status={order.status} />
      <DetailLayout
        title={order.number}
        subtitle={`${order.supplierName} · ${order.currency}`}
        statuses={statuses(detail)}
        metrics={metrics(detail)}
        primaryActions={<PoActions detail={detail} onEdit={() => setEditing(true)} />}
        tabs={PO_DETAIL_TABS.map(key => ({ key, label: PO_DETAIL_TAB_LABEL[key], children: body[key] }))}
        activeTab={tab}
        onTabChange={key => setTab(key as PoDetailTab)}
        rail={[{ key: 'collab', title: '评论与关注', children: <EntityCollaboration entityType="PURCHASE_ORDER" entityId={order.id} /> }]}
      />
      <PoDrawer
        open={editing}
        onClose={() => setEditing(false)}
        order={{ id: order.id, version: order.version, supplierName: order.supplierName, expectedDate: order.expectedDate, notes: order.notes, lines: detail.lines }}
      />
    </div>
  )
}
