import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Alert, Space, Tabs } from 'antd'
import type { InboundOverview } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { PlanActions } from './inbound-actions'
import { defaultStepIndex, FlowSteps, StepPanel } from './inbound-flow'
import { BoxesTab, PackingTab, PlacementTab, TransportTab } from './inbound-tabs-options'
import { CostsTab, ItemsTab, OverviewTab } from './inbound-tabs-plan'
import { LabelsTab } from './labels/LabelsTab'
import { ReceivingTab, ShipmentsTab, TimelineTab } from './inbound-tabs-ship'
import { Countdown, DEADLINE_LABEL, money, qty, SOURCE_LABEL } from './inbound-ui'
import { PackingListTab } from './packing-list/PackingListTab'

// 入仓计划详情（P2a-12、P6-10，06 章 6.11、16 章 5.1）：五步流程条 → 当前步骤说明与可做的操作 → 页签。
// 页签按流程归位：选品（概览、商品）、装箱（装箱方案、箱内物品）、分仓、运输、标签与发货（货件、标签）；时间线、接收与差异、费用在流程之外。
// 亚马逊的每一步都是异步的：有操作在途时页面每 5 秒自动刷新，直到亚马逊返回结果；失败原因写在页面顶部。
// 每一步的状态与按钮的可用性、不可用的原因由服务端按计划状态给出（steps、actions）；调用亚马逊的动作要过“权限 → 连接 → 写入开关”，按钮禁用时写明卡在哪一步。

const STEP_TABS = ['items', 'boxes', 'placement', 'transport', 'ship'] as const
const OUTSIDE_TABS = [
  ['timeline', '时间线'],
  ['receiving', '接收与差异'],
  ['costs', '费用'],
] as const

function Inner({ items, activeKey, onChange }: { items: Array<{ key: string; label: string; children: JSX.Element }>; activeKey?: string; onChange?: (key: string) => void }) {
  return <Tabs size="small" items={items} {...(activeKey !== undefined ? { activeKey, onChange } : {})} />
}

function metricsOf(overview: InboundOverview): IdentityMetric[] {
  const { plan, costs } = overview
  return [
    { label: '总件数', value: qty(plan.totalUnits) },
    { label: 'SKU 数', value: qty(plan.skuCount) },
    { label: '货件数', value: qty(plan.shipmentCount) },
    { label: '来源', value: SOURCE_LABEL[plan.sourceType] ?? plan.sourceType },
    {
      label: '最近的截止时间',
      value: plan.nextDeadline ? (
        <span>
          {DEADLINE_LABEL[plan.nextDeadline.kind]}：<Countdown at={plan.nextDeadline.at} />
        </span>
      ) : (
        <Muted>无</Muted>
      ),
    },
    { label: '已知费用合计', value: money(costs.knownTotal, costs.currency) },
  ]
}

export default function InboundPlanDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState<string | null>(null)
  const [boxesTab, setBoxesTab] = useState('packing')
  const query = useApiQuery<InboundOverview>({
    domain: 'list',
    path: `/inbound/plans/${encodeURIComponent(id)}`,
    scoped: false,
    refetchIntervalMs: data => (data?.plan.pendingOp ? 5000 : false),
  })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inbound.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const overview = query.data
  const { plan } = overview
  const statuses: StatusTag[] = [{ text: plan.stageLabel, color: plan.stage === 'COMPLETED' ? 'success' : plan.stage === 'CANCELLED' ? 'default' : 'processing' }]
  if (plan.pendingOp) statuses.push({ text: '处理中', color: 'warning' })

  const body: Record<string, JSX.Element> = {
    items: (
      <Inner
        items={[
          { key: 'overview', label: '概览', children: <OverviewTab overview={overview} /> },
          { key: 'items', label: '商品', children: <ItemsTab overview={overview} /> },
        ]}
      />
    ),
    boxes: (
      <Inner
        activeKey={boxesTab}
        onChange={setBoxesTab}
        items={[
          { key: 'packing', label: '装箱方案', children: <PackingTab overview={overview} /> },
          { key: 'boxes', label: '箱内物品', children: <BoxesTab overview={overview} /> },
          { key: 'packing-list', label: '装箱单匹配', children: <PackingListTab overview={overview} onApplied={() => setBoxesTab('boxes')} /> },
        ]}
      />
    ),
    placement: <PlacementTab overview={overview} />,
    transport: <TransportTab overview={overview} />,
    ship: (
      <Inner
        items={[
          { key: 'shipments', label: '货件', children: <ShipmentsTab overview={overview} /> },
          { key: 'labels', label: '标签', children: <LabelsTab overview={overview} /> },
        ]}
      />
    ),
    timeline: <TimelineTab overview={overview} />,
    receiving: <ReceivingTab overview={overview} />,
    costs: <CostsTab overview={overview} />,
  }
  // 当前页签是流程里的一步就选中那一步，否则（时间线等）停在服务端判断的当前步骤
  const fallback = defaultStepIndex(overview.steps)
  const activeTab = tab ?? STEP_TABS[fallback]!
  const stepIndex = STEP_TABS.indexOf(activeTab as (typeof STEP_TABS)[number])
  const selected = stepIndex >= 0 ? stepIndex : fallback
  const tabs = [...STEP_TABS.map((key, index) => ({ key, label: overview.steps[index]!.label, children: body[key]! })), ...OUTSIDE_TABS.map(([key, label]) => ({ key, label, children: body[key]! }))]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/supply-chain">返回入仓计划</AppLink>
      <FlowSteps steps={overview.steps} selected={selected} onSelect={index => setTab(STEP_TABS[index]!)} />
      <StepPanel step={overview.steps[selected]!} />
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {plan.pendingOp ? <Alert type="info" showIcon message="有操作正在由后台任务处理" description="处理完成前不能再做其他操作；页面每 5 秒自动刷新，直到亚马逊返回结果。" /> : null}
        {plan.lastErrorMessage ? <Alert type="error" showIcon message="上一次操作没有成功" description={plan.lastErrorMessage} /> : null}
        {overview.nextAction.text ? <Alert type="success" showIcon message={`下一步：${overview.nextAction.text}`} /> : null}
      </Space>
      <DetailLayout
        title={plan.name}
        subtitle={`${plan.storeName} · ${plan.externalPlanId ?? '尚未提交亚马逊'}`}
        statuses={statuses}
        metrics={metricsOf(overview)}
        primaryActions={<PlanActions overview={overview} />}
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setTab}
      />
    </div>
  )
}
