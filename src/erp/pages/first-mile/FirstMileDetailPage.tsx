import { useState } from 'react'
import { permissionDeniedMessage } from '@nova/api-contracts'
import { useParams } from '@tanstack/react-router'
import { Button, Tooltip } from 'antd'
import { FIRST_MILE_MODE_LABEL, type FirstMileDetail } from '@nova/api-contracts'
import { AttachmentsPanel, money } from '../procurement/procurement-ui'
import { DataState, DetailLayout, EntityCollaboration, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { AddCostAction, AddMilestoneAction, AllocateAction, ImportMilestonesAction, OutboundAction, RevertAction } from './fm-actions'
import { CostsTab, ItemsTab, LinkedTab, MilestonesTab } from './fm-tabs'
import { EstimatePanel, MissingFieldsAlert } from './fm-estimate'
import { delayText } from './first-mile-ui'
import { ShipmentDrawer } from './ShipmentDrawer'

// 头程运单详情（P2a-11，06 章 6.10）：身份区 → 节点时间线、费用与分摊、明细、关联入仓货件、附件。
// 动作按钮由服务端按运单状态给出；金额类内容需要字段权限 field.cost（没有权限整块不显示）。

const TABS = [
  ['milestones', '节点时间线'],
  ['costs', '费用与分摊'],
  ['items', '明细'],
  ['linked', '关联入仓货件'],
  ['attachments', '附件'],
] as const

const day = (value: string | null) => (value ? formatDate(value) : <Muted>未填写</Muted>)

function metricsOf(detail: FirstMileDetail): IdentityMetric[] {
  const { shipment, transitHint } = detail
  return [
    { label: '预计交付', value: day(shipment.etaDelivery) },
    { label: '实际交付', value: day(shipment.ataDelivery) },
    { label: '时效', value: delayText(shipment) },
    ...(shipment.estimatedCost !== undefined ? [{ label: '预估费用', value: money(shipment.estimatedCost, shipment.currency) }] : []),
    ...(shipment.actualCost !== undefined ? [{ label: '实际费用', value: money(shipment.actualCost, shipment.currency) }] : []),
    {
      label: '同类实际时效',
      value: transitHint?.p90Days ? (
        <Tooltip
          title={`${transitHint.forwarderName} ${FIRST_MILE_MODE_LABEL[transitHint.mode]}：已交付 ${transitHint.sampleCount} 单，中位 ${transitHint.p50Days ?? '—'} 天，九成不超过 ${transitHint.p90Days} 天`}
        >
          <span className="erp-num">
            {transitHint.p90Days} 天内（样本 {transitHint.sampleCount} 单）
          </span>
        </Tooltip>
      ) : (
        <Muted>样本不足</Muted>
      ),
    },
  ]
}

function statusesOf(detail: FirstMileDetail): StatusTag[] {
  const { shipment } = detail
  const tags: StatusTag[] = [
    { text: shipment.stageLabel, color: shipment.stage === 'DELIVERED' ? 'success' : 'processing' },
    { text: `清关：${shipment.customsLabel}`, color: shipment.customsStatus === 'HELD' ? 'error' : 'default' },
  ]
  if (shipment.outboundAt) tags.push({ text: '国内仓已出库', color: 'default' })
  if (shipment.allocated) tags.push({ text: '费用已分摊', color: 'success' })
  return tags
}

export default function FirstMileDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { canPermission } = useSession()
  const [tab, setTab] = useState<string>('milestones')
  const [editing, setEditing] = useState(false)
  const path = `/first-mile/${encodeURIComponent(id)}`
  const query = useApiQuery<FirstMileDetail>({ domain: 'list', path, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'firstmile.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const canWrite = canPermission('firstmile.write')
  const body: Record<string, JSX.Element> = {
    milestones: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <AddMilestoneAction detail={detail} />
          <ImportMilestonesAction detail={detail} />
        </div>
        <MilestonesTab detail={detail} />
      </div>
    ),
    costs: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <AddCostAction detail={detail} />
          <AllocateAction detail={detail} />
          <RevertAction detail={detail} />
        </div>
        <EstimatePanel detail={detail} />
        <CostsTab detail={detail} />
      </div>
    ),
    items: <ItemsTab detail={detail} />,
    linked: <LinkedTab detail={detail} />,
    attachments: <AttachmentsPanel base={path} items={detail.attachments} writePermission="firstmile.write" onChanged={() => void query.refetch()} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/first-mile">返回头程物流</AppLink>
      <MissingFieldsAlert detail={detail} />
      <DetailLayout
        title={detail.shipment.waybillNo}
        subtitle={[detail.shipment.forwarderName, detail.shipment.modeLabel, detail.shipment.containerNo ? `柜号 ${detail.shipment.containerNo}` : '未填柜号', detail.shipment.currency].join(' · ')}
        statuses={statusesOf(detail)}
        metrics={metricsOf(detail)}
        primaryActions={
          <>
            <Tooltip title={canWrite ? undefined : permissionDeniedMessage('firstmile.write')}>
              <span>
                <Button type="primary" disabled={!canWrite} onClick={() => setEditing(true)}>
                  编辑
                </Button>
              </span>
            </Tooltip>
            <OutboundAction detail={detail} />
          </>
        }
        tabs={TABS.map(([key, label]) => ({ key, label, children: body[key] }))}
        activeTab={tab}
        onTabChange={setTab}
        rail={[{ key: 'collab', title: '评论与关注', children: <EntityCollaboration entityType="FIRST_MILE" entityId={detail.shipment.id} /> }]}
      />
      <ShipmentDrawer open={editing} onClose={() => setEditing(false)} detail={detail} />
    </div>
  )
}
