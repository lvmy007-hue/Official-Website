import { Alert, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { DeliveryWindowView, InboundBoxesResponse, InboundOptionsResponse, InboundOverview, PackingOptionView, PlacementOptionView, TransportOptionView } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { GenerateAction } from './inbound-actions'
import { ConfirmPackingAction, ConfirmPlacementAction, EstimateAction } from './inbound-option-actions'
import { TransportConfirmAction, TransportGenerateAction, WindowConfirmAction, WindowGenerateAction } from './inbound-transport-actions'
import { BoxEditor } from './box-editor/BoxEditor'
import { Countdown, money } from './inbound-ui'

// 入仓计划详情的“装箱方案”“箱内物品”“分仓方案”“运输方案”页签。
// 方案都有有效期（倒计时）；分仓方案按总成本（分仓费 − 折扣 + 预估运费 + 断货风险成本）推荐，估算参数没填时写明依据不完整，不把缺的项当 0。

const planPath = (overview: InboundOverview) => `/inbound/plans/${encodeURIComponent(overview.plan.id)}`

export function useOptions(overview: InboundOverview) {
  return useApiQuery<InboundOptionsResponse>({ domain: 'list', path: `${planPath(overview)}/options`, scoped: false })
}

function Loaded<T>({ query, children }: { query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }; children: (data: T) => JSX.Element }) {
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={4} />
  return children(query.data)
}

const statusTag = (confirmed: boolean, status: string) =>
  confirmed ? (
    <Tag color="success" bordered={false}>
      已确认
    </Tag>
  ) : status === 'OFFERED' ? (
    <Tag color="processing" bordered={false}>
      可选
    </Tag>
  ) : (
    <Tag bordered={false}>已过期或不可选</Tag>
  )

export function PackingTab({ overview }: { overview: InboundOverview }) {
  const query = useOptions(overview)
  const columns: ColumnsType<PackingOptionView> = [
    { title: '方案', dataIndex: 'packingOptionId', width: 200 },
    {
      title: '装箱组',
      key: 'groups',
      width: 320,
      render: (_value, row) => row.groups.map(group => `${group.packingGroupId}（${group.items.map(item => `${item.sku}×${item.quantity}`).join('、')}）`).join('；') || <Muted>尚无记录</Muted>,
    },
    { title: '包装服务费', dataIndex: 'fees', width: 120, align: 'right', render: (value: number | null, row) => money(value, row.currency) },
    { title: '折扣', dataIndex: 'discounts', width: 100, align: 'right', render: (value: number | null, row) => money(value, row.currency) },
    { title: '有效期', key: 'expires', width: 170, render: (_value, row) => (row.confirmed ? <Muted>已确认</Muted> : <Countdown at={row.expiresAt} />) },
    { title: '状态', key: 'status', width: 120, render: (_value, row) => statusTag(row.confirmed, row.status) },
    { title: '操作', key: 'action', width: 160, render: (_value, row) => (row.confirmed ? null : <ConfirmPackingAction overview={overview} option={row} />) },
  ]
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space>
        <GenerateAction overview={overview} action="GENERATE_PACKING" path="/packing-options" label="生成装箱方案" hint="向亚马逊查询可用的装箱方案（只产生可比较的方案，不会确认任何方案）。" />
      </Space>
      <Loaded query={query}>
        {data =>
          data.packing.length === 0 ? (
            <Alert type="info" showIcon message="还没有装箱方案" description="计划创建成功后点击“生成装箱方案”；亚马逊处理完成前，这里会一直是空的。" />
          ) : (
            <SimpleGrid<PackingOptionView>
              gridId="inbound.inbound-tabs-options"
              columns={columns}
              rows={data.packing}
              rowKey={row => row.packingOptionId}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          )
        }
      </Loaded>
    </Space>
  )
}

export function BoxesTab({ overview }: { overview: InboundOverview }) {
  const query = useApiQuery<InboundBoxesResponse>({ domain: 'list', path: `${planPath(overview)}/boxes`, scoped: false })
  return <Loaded query={query}>{data => <BoxEditor overview={overview} data={data} />}</Loaded>
}

export function PlacementTab({ overview }: { overview: InboundOverview }) {
  const query = useOptions(overview)
  const columns: ColumnsType<PlacementOptionView> = [
    { title: '方案', key: 'id', width: 200, render: (_value, row) => <span>{row.placementOptionId}</span> },
    {
      title: '货件与去向',
      key: 'ships',
      width: 260,
      render: (_value, row) => row.shipments.map(item => `${item.destinationFc ?? '去向未给出'}（${item.units === null ? '件数未给出' : `${item.units} 件`}）`).join('；'),
    },
    { title: '分仓费', dataIndex: 'fees', width: 100, align: 'right', render: (value: number, row) => money(value, row.currency) },
    { title: '折扣', dataIndex: 'discounts', width: 90, align: 'right', render: (value: number, row) => money(value, row.currency) },
    { title: '预估运费', key: 'freight', width: 110, align: 'right', render: (_value, row) => (row.cost.freight === null ? <Muted>未填估算</Muted> : money(row.cost.freight, row.currency)) },
    { title: '断货风险成本', key: 'stockout', width: 120, align: 'right', render: (_value, row) => (row.cost.stockout === null ? <Muted>未填估算</Muted> : money(row.cost.stockout, row.currency)) },
    { title: '总成本', key: 'total', width: 120, align: 'right', render: (_value, row) => <strong>{money(row.cost.total, row.currency)}</strong> },
    { title: '有效期', key: 'expires', width: 170, render: (_value, row) => (row.confirmed ? <Muted>已确认</Muted> : <Countdown at={row.expiresAt} />) },
    {
      title: '标记',
      key: 'tags',
      width: 160,
      render: (_value, row) => (
        <>
          {row.recommended ? (
            <Tag color="success" bordered={false}>
              推荐（总成本最低）
            </Tag>
          ) : null}
          {row.cheapestFee ? (
            <Tag bordered={false} title="只比较亚马逊收取的分仓费">
              分仓费最低
            </Tag>
          ) : null}
          {statusTag(row.confirmed, row.status)}
        </>
      ),
    },
    { title: '操作', key: 'action', width: 150, render: (_value, row) => (row.confirmed ? null : <ConfirmPlacementAction overview={overview} option={row} />) },
  ]
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Loaded query={query}>
        {data => (
          <>
            <Space wrap>
              <GenerateAction
                overview={overview}
                action="GENERATE_PLACEMENT"
                path="/placement-options"
                label="生成分仓方案"
                hint="向亚马逊查询可选的分仓方案（只产生可比较的方案，不会确认任何方案）。"
              />
              <EstimateAction overview={overview} estimate={data.estimate} />
            </Space>
            {data.placement.length > 0 ? (
              <Alert type={data.recommendation.basis === 'PARTIAL' ? 'warning' : 'info'} showIcon message={data.recommendation.note} data-testid="placement-recommendation" />
            ) : (
              <Alert type="info" showIcon message="还没有分仓方案" description="箱内物品提交后点击“生成分仓方案”。" />
            )}
            {data.placement.length > 0 ? (
              <SimpleGrid<PlacementOptionView>
                gridId="inbound.inbound-tabs-options-2"
                columns={columns}
                rows={data.placement}
                rowKey={row => row.placementOptionId}
                emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
              />
            ) : null}
          </>
        )}
      </Loaded>
    </Space>
  )
}

export function TransportTab({ overview }: { overview: InboundOverview }) {
  const query = useOptions(overview)
  return (
    <Loaded query={query}>
      {data => {
        const transportColumns: ColumnsType<TransportOptionView> = [
          { title: '货件', dataIndex: 'shipmentId', width: 170 },
          { title: '承运商', dataIndex: 'carrier', width: 140, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
          { title: '方式', dataIndex: 'modeLabel', width: 100, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
          { title: '费用', dataIndex: 'cost', width: 110, align: 'right', render: (value: number | null, row) => money(value, row.currency) },
          { title: '前置条件', dataIndex: 'preconditions', width: 200, render: (value: string[]) => (value.length ? value.join('、') : <Muted>无</Muted>) },
          { title: '报价有效期', key: 'expires', width: 170, render: (_value, row) => (row.confirmed ? <Muted>已确认</Muted> : <Countdown at={row.expiresAt} />) },
          { title: '状态', key: 'status', width: 110, render: (_value, row) => statusTag(row.confirmed, row.status) },
        ]
        const windowColumns: ColumnsType<DeliveryWindowView> = [
          { title: '货件', dataIndex: 'shipmentId', width: 170 },
          { title: '时间窗', key: 'range', width: 330, render: (_value, row) => `${formatDateTime(row.windowStart)} 至 ${formatDateTime(row.windowEnd)}` },
          { title: '类型', dataIndex: 'availabilityType', width: 110, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
          { title: '有效期', key: 'expires', width: 170, render: (_value, row) => (row.confirmed ? <Muted>已确认</Muted> : <Countdown at={row.availabilityExpiresAt} />) },
          {
            title: '操作',
            key: 'action',
            width: 130,
            render: (_value, row) =>
              row.confirmed ? (
                <Tag color="success" bordered={false}>
                  已确认
                </Tag>
              ) : (
                <WindowConfirmAction overview={overview} window={row} />
              ),
          },
        ]
        return (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <TransportGenerateAction overview={overview} shipments={data.shipments} />
              <TransportConfirmAction overview={overview} shipments={data.shipments} transport={data.transport} />
              {data.shipments.map(item => (
                <WindowGenerateAction key={item.shipmentId} overview={overview} shipmentId={item.shipmentId} />
              ))}
            </Space>
            {data.transport.length === 0 ? (
              <Alert type="info" showIcon message="还没有运输方案" description="分仓方案确认、货件生成后，点击“生成运输方案”询价。部分运输方案要求先确认送达时间窗。" />
            ) : (
              <SimpleGrid<TransportOptionView>
                gridId="inbound.inbound-tabs-options-3"
                columns={transportColumns}
                rows={data.transport}
                rowKey={row => `${row.shipmentId}|${row.transportOptionId}`}
                emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
              />
            )}
            {data.windows.length > 0 ? (
              <>
                <div style={{ margin: '4px 0', fontWeight: 600 }}>{(() => '送达时间窗')()}</div>
                <SimpleGrid<DeliveryWindowView>
                  gridId="inbound.inbound-tabs-options-4"
                  columns={windowColumns}
                  rows={data.windows}
                  rowKey={row => `${row.shipmentId}|${row.deliveryWindowOptionId}`}
                  emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
                />
              </>
            ) : null}
          </Space>
        )
      }}
    </Loaded>
  )
}
