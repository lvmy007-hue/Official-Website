import { Descriptions, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ALLOCATION_METHOD_LABEL,
  type AllocationLineView,
  type FirstMileCostView,
  type FirstMileDetail,
  type FirstMileItemView,
  type FirstMileMilestoneView,
  type LinkedInboundView,
} from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { formatDateTime, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { count, money } from '../procurement/procurement-ui'
import { useFmCalls } from './fm-actions'

// 头程运单详情的各个页签：节点时间线、费用与分摊、明细、关联入仓货件。
// 没有字段权限 field.cost 时费用明细与分摊整块不返回，页面写明“无权查看”，不显示 0。

const WRITE = 'firstmile.write'
const quantity = (value: number | null) => (value === null ? <Muted>未填写</Muted> : <span className="erp-num">{formatNumber(value, { digits: 4 })}</span>)

export function MilestonesTab({ detail }: { detail: FirstMileDetail }) {
  const { del } = useFmCalls(detail.shipment.id)
  const columns: ColumnsType<FirstMileMilestoneView> = [
    { title: '节点', dataIndex: 'label', width: 140 },
    { title: '发生时间', dataIndex: 'occurredAt', width: 170, render: (value: string) => formatDateTime(value) },
    { title: '地点', dataIndex: 'location', width: 160, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
    { title: '来源', dataIndex: 'sourceLabel', width: 110 },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null) => value ?? <Muted>无</Muted> },
    { title: '录入人', dataIndex: 'createdByName', width: 110, render: (value: string | null) => value ?? <Muted>货代文件</Muted> },
    {
      title: '操作',
      key: 'op',
      width: 80,
      render: (_value, row) =>
        row.source === 'MANUAL' ? (
          <FormAction
            label="删除"
            danger
            buttonProps={{ type: 'link', size: 'small' }}
            guard={{ permission: WRITE }}
            title="删除这条节点"
            okText="删除"
            successText="已删除"
            onSubmit={() => del.mutateAsync({ suffix: `milestones/${encodeURIComponent(row.id)}?version=${detail.shipment.version}` })}
          />
        ) : (
          <Muted>—</Muted>
        ),
    },
  ]
  return detail.milestones.length ? (
    <SimpleGrid<FirstMileMilestoneView>
      gridId="first-mile.fm-tabs"
      columns={columns}
      rows={detail.milestones}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  ) : (
    <Muted>还没有节点。手工录入，或导入货代给的节点文件。</Muted>
  )
}

export function ItemsTab({ detail }: { detail: FirstMileDetail }) {
  const withValue = detail.items.some(item => item.goodsValue !== undefined)
  const columns: ColumnsType<FirstMileItemView> = [
    { title: 'SKU', dataIndex: 'sku', width: 170 },
    {
      title: '采购单',
      dataIndex: 'purchaseOrderNo',
      width: 190,
      render: (value: string | null, row) => (row.purchaseOrderId && value ? <AppLink to={`/app/purchase-orders/${encodeURIComponent(row.purchaseOrderId)}`}>{value}</AppLink> : <Muted>未关联</Muted>),
    },
    { title: '数量', dataIndex: 'quantity', width: 90, align: 'right', render: count },
    { title: '箱数', dataIndex: 'cartons', width: 80, align: 'right', render: (value: number | null) => (value === null ? <Muted>未填写</Muted> : count(value)) },
    { title: '体积（m³）', dataIndex: 'volumeCbm', width: 110, align: 'right', render: quantity },
    { title: '重量（kg）', dataIndex: 'weightKg', width: 110, align: 'right', render: quantity },
    ...(withValue
      ? ([{ title: '货值', key: 'goodsValue', width: 140, align: 'right', render: (_value, row) => money(row.goodsValue, detail.shipment.currency) }] as ColumnsType<FirstMileItemView>)
      : []),
  ]
  return (
    <SimpleGrid<FirstMileItemView>
      gridId="first-mile.fm-tabs-2"
      columns={columns}
      rows={detail.items}
      rowKey={row => row.sku}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  )
}

export function LinkedTab({ detail }: { detail: FirstMileDetail }) {
  const columns: ColumnsType<LinkedInboundView> = [
    { title: '入仓货件', dataIndex: 'shipmentId', width: 190 },
    { title: '状态', dataIndex: 'status', width: 120, render: (value: string | null, row) => (row.found ? (value ?? <Muted>未知</Muted>) : <Muted>未在同步数据里找到</Muted>) },
    { title: '目的仓', dataIndex: 'destinationFc', width: 120, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '预计件数', dataIndex: 'unitsExpected', width: 100, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : count(value)) },
    { title: '已收件数', dataIndex: 'unitsReceived', width: 100, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : count(value)) },
  ]
  return detail.linkedInbound.length ? (
    <SimpleGrid<LinkedInboundView>
      gridId="first-mile.fm-tabs-3"
      columns={columns}
      rows={detail.linkedInbound}
      rowKey={row => row.shipmentId}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  ) : (
    <Muted>没有关联入仓货件。在“编辑”里填写亚马逊入仓货件编号即可关联。</Muted>
  )
}

export function CostsTab({ detail }: { detail: FirstMileDetail }) {
  const { del } = useFmCalls(detail.shipment.id)
  if (detail.costs === undefined) return <Muted>无权查看：费用与分摊需要字段权限 field.cost</Muted>
  const currency = detail.shipment.currency
  const canDelete = detail.actions.includes('ADD_COST')
  const columns: ColumnsType<FirstMileCostView> = [
    { title: '费用项', dataIndex: 'itemLabel', width: 120 },
    { title: '金额', key: 'amount', width: 150, align: 'right', render: (_value, row) => money(row.amount, currency) },
    { title: '发生日期', dataIndex: 'incurredAt', width: 120 },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null) => value ?? <Muted>无</Muted> },
    { title: '录入人', dataIndex: 'createdByName', width: 110 },
    {
      title: '操作',
      key: 'op',
      width: 80,
      render: (_value, row) => (
        <FormAction
          label="删除"
          danger
          buttonProps={{ type: 'link', size: 'small' }}
          guard={{ permission: WRITE, condition: { ok: canDelete, reason: '费用已分摊，要删除请先撤销分摊' } }}
          title="删除这条费用"
          okText="删除"
          successText="已删除"
          onSubmit={() => del.mutateAsync({ suffix: `costs/${encodeURIComponent(row.id)}?version=${detail.shipment.version}` })}
        />
      ),
    },
  ]
  const allocation = detail.allocation
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {detail.costs.length ? (
        <SimpleGrid<FirstMileCostView>
          gridId="first-mile.fm-tabs-4"
          columns={columns}
          rows={detail.costs}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>还没有费用记录</Muted>
      )}
      <div>
        <Typography.Title level={5}>费用分摊</Typography.Title>
        {allocation ? (
          <>
            <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ marginBottom: 8 }}>
              <Descriptions.Item label="口径">{ALLOCATION_METHOD_LABEL[allocation.method]}</Descriptions.Item>
              <Descriptions.Item label="分摊合计">{money(allocation.total, allocation.currency)}</Descriptions.Item>
              <Descriptions.Item label="分摊时间">{formatDateTime(allocation.createdAt)}</Descriptions.Item>
            </Descriptions>
            <SimpleGrid<AllocationLineView>
              gridId="first-mile.fm-tabs-5"
              columns={[
                { title: 'SKU', dataIndex: 'sku', width: 170 },
                { title: '数量', dataIndex: 'quantity', width: 90, align: 'right', render: count },
                { title: '分摊金额', key: 'amount', width: 150, align: 'right', render: (_value, row) => money(row.allocatedAmount, allocation.currency) },
                { title: '单位头程成本', key: 'unit', width: 150, align: 'right', render: (_value, row) => money(row.unitCost, allocation.currency) },
                {
                  title: '成本版本',
                  key: 'version',
                  render: (_value, row) =>
                    row.costVersionNo === null ? <Muted>未生成</Muted> : `v${row.costVersionNo}（${row.costVersionStatus === 'DRAFT' ? '草稿，待确认' : (row.costVersionStatus ?? '')}）`,
                },
              ]}
              rows={allocation.lines}
              rowKey={row => row.sku}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          </>
        ) : (
          <>
            <Muted>尚未分摊</Muted>
            {detail.allocationReady ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {(Object.keys(detail.allocationReady) as Array<keyof typeof detail.allocationReady>).map(method => (
                  <li key={method}>
                    {ALLOCATION_METHOD_LABEL[method]}：{detail.allocationReady?.[method] ?? '可用'}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
