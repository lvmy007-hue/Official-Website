import { Alert, Card, Space, Tag, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { InboundDiscrepancyResponse, InboundDiscrepancyRow, InboundOperationView, InboundOverview, InboundShipmentTimelineResponse, InboundShipmentView } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { TrackingAction } from './inbound-option-actions'
import { OpStatusTag, qty } from './inbound-ui'

// 入仓计划详情的“货件”“标签”“时间线”“接收与差异”页签。
// 时间线把每个异步操作的状态一直展示到亚马逊返回结果；接收与差异里，货件没有关闭前只显示“待关闭”，不判定少收或多收；
// 不合规问题与赔付任务显示条数并链到货件接收详情（P2a-13）；不合规报告没接入写“尚未接入”，没有记录写“尚无记录”，都不显示 0。

const planPath = (overview: InboundOverview) => `/inbound/plans/${encodeURIComponent(overview.plan.id)}`

function useShipments(overview: InboundOverview) {
  return useApiQuery<{ shipments: InboundShipmentView[] }>({ domain: 'list', path: `${planPath(overview)}/shipments`, scoped: false })
}

function Loaded<T>({ query, children }: { query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }; children: (data: T) => JSX.Element }) {
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={3} />
  return children(query.data)
}

export function ShipmentsTab({ overview }: { overview: InboundOverview }) {
  const query = useShipments(overview)
  const columns: ColumnsType<InboundShipmentView> = [
    { title: '货件编号', dataIndex: 'shipmentId', width: 170 },
    { title: '目的运营中心', dataIndex: 'destinationFc', width: 120, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '状态', dataIndex: 'status', width: 110 },
    { title: '箱数', dataIndex: 'boxCount', width: 80, align: 'right', render: qty },
    { title: '件数', dataIndex: 'units', width: 80, align: 'right', render: qty },
    { title: '承运商', dataIndex: 'carrier', width: 120, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '追踪号', dataIndex: 'trackingNumber', width: 160, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '操作', key: 'action', width: 140, render: (_value, row) => <TrackingAction overview={overview} shipment={row} /> },
  ]
  return (
    <Loaded query={query}>
      {data =>
        data.shipments.length === 0 ? (
          <Alert type="info" showIcon message="还没有货件" description="分仓方案确认后，亚马逊才会生成货件。" />
        ) : (
          <SimpleGrid<InboundShipmentView>
            gridId="inbound.inbound-tabs-ship"
            columns={columns}
            rows={data.shipments}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
        )
      }
    </Loaded>
  )
}

function ShipmentTimeline({ shipment }: { shipment: InboundShipmentView }) {
  const query = useApiQuery<InboundShipmentTimelineResponse>({ domain: 'list', path: `/inbound/shipments/${encodeURIComponent(shipment.id)}/timeline`, scoped: false })
  return (
    <Card size="small" title={`货件 ${shipment.shipmentId}`}>
      <Loaded query={query}>
        {data => (
          <>
            {data.events.length === 0 ? (
              <Muted>尚无记录</Muted>
            ) : (
              <Timeline
                items={data.events.map(event => ({
                  children: (
                    <>
                      <Typography.Text strong>{event.title}</Typography.Text> <Typography.Text type="secondary">{formatDateTime(event.at)}</Typography.Text>
                      {event.precision === 'OBSERVED' ? (
                        <Tag bordered={false} style={{ marginLeft: 6 }} title="这是我们同步时看到的时间，不是亚马逊实际发生的时间">
                          同步时观察到
                        </Tag>
                      ) : null}
                      {event.detail ? <div>{event.detail}</div> : null}
                    </>
                  ),
                }))}
              />
            )}
            <Typography.Text type="secondary">{data.note}</Typography.Text>
          </>
        )}
      </Loaded>
    </Card>
  )
}

export function TimelineTab({ overview }: { overview: InboundOverview }) {
  const operations = useApiQuery<{ operations: InboundOperationView[] }>({
    domain: 'list',
    path: `${planPath(overview)}/operations`,
    scoped: false,
    refetchIntervalMs: overview.plan.pendingOp ? 5000 : false,
  })
  const shipments = useShipments(overview)
  const columns: ColumnsType<InboundOperationView> = [
    { title: '操作', dataIndex: 'operationLabel', width: 160 },
    { title: '状态', key: 'status', width: 130, render: (_value, row) => <OpStatusTag status={row.status} /> },
    { title: '亚马逊操作编号', dataIndex: 'amazonOperationId', width: 280, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '发起时间', dataIndex: 'startedAt', width: 160, render: (value: string) => formatDateTime(value) },
    { title: '完成时间', dataIndex: 'finishedAt', width: 160, render: (value: string | null) => (value ? formatDateTime(value) : <Muted>处理中</Muted>) },
    {
      title: '问题',
      key: 'problems',
      render: (_value, row) =>
        row.problems.length > 0 ? (
          row.problems.map((problem, index) => (
            <div key={index}>
              {problem.code ? `${problem.code}：` : ''}
              {problem.message}
            </div>
          ))
        ) : row.errorCode ? (
          <Typography.Text type="danger">{row.errorCode}</Typography.Text>
        ) : (
          <Muted>无</Muted>
        ),
    },
  ]
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Loaded query={operations}>
        {data => (
          <>
            <div style={{ margin: '4px 0', fontWeight: 600 }}>{(() => '亚马逊异步操作（处理中会自动刷新，直到亚马逊返回结果）')()}</div>
            <SimpleGrid<InboundOperationView>
              gridId="inbound.inbound-tabs-ship-2"
              columns={columns}
              rows={data.operations}
              rowKey={row => row.id}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '还没有发起过操作' }}
            />
          </>
        )}
      </Loaded>
      {(shipments.data?.shipments ?? []).map(shipment => (
        <ShipmentTimeline key={shipment.id} shipment={shipment} />
      ))}
    </Space>
  )
}

const STATE_TAG: Record<InboundDiscrepancyRow['state'], { color: string; text: string }> = {
  SHORT: { color: 'error', text: '少收' },
  OVER: { color: 'warning', text: '多收' },
  MATCH: { color: 'success', text: '一致' },
  PENDING: { color: 'default', text: '待货件关闭' },
}

function ShipmentDiscrepancy({ shipment }: { shipment: InboundShipmentView }) {
  const query = useApiQuery<InboundDiscrepancyResponse>({ domain: 'list', path: `/inbound/shipments/${encodeURIComponent(shipment.id)}/discrepancies`, scoped: false })
  const columns: ColumnsType<InboundDiscrepancyRow> = [
    { title: 'SKU', dataIndex: 'sku', width: 180 },
    { title: '发出', dataIndex: 'shippedQty', width: 90, align: 'right', render: qty },
    { title: '已接收', dataIndex: 'receivedQty', width: 100, align: 'right', render: qty },
    { title: '差异', dataIndex: 'discrepancyQty', width: 90, align: 'right', render: qty },
    {
      title: '判定',
      dataIndex: 'state',
      width: 120,
      render: (value: InboundDiscrepancyRow['state']) => (
        <Tag color={STATE_TAG[value].color} bordered={false}>
          {STATE_TAG[value].text}
        </Tag>
      ),
    },
    { title: '差异原因', dataIndex: 'reason', render: (value: string | null) => value ?? <Muted>亚马逊未提供</Muted> },
  ]
  return (
    <Card size="small" title={`货件 ${shipment.shipmentId}`}>
      <Loaded query={query}>
        {data => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">{data.note}</Typography.Text>
            <SimpleGrid<InboundDiscrepancyRow>
              gridId="inbound.inbound-tabs-ship-3"
              columns={columns}
              rows={data.rows}
              rowKey={row => row.sku}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
            <Typography.Text>
              不合规问题：
              {data.compliance.state === 'NOT_CONNECTED' ? (
                <Muted>尚未接入（入仓不合规报告还没有同步成功过）</Muted>
              ) : data.compliance.items.length === 0 ? (
                <Muted>尚无记录</Muted>
              ) : (
                `${data.compliance.items.length} 条`
              )}
            </Typography.Text>
            <Typography.Text>
              赔付任务：
              {data.claims.state === 'NOT_JUDGED' ? <Muted>货件未关闭，暂不判断</Muted> : data.claims.items.length === 0 ? <Muted>尚无记录</Muted> : `${data.claims.items.length} 个`}
            </Typography.Text>
            <AppLink to={`/app/warehouse/${encodeURIComponent(shipment.id)}`}>查看货件接收详情（证据附件、赔付任务、审计记录）</AppLink>
          </Space>
        )}
      </Loaded>
    </Card>
  )
}

export function ReceivingTab({ overview }: { overview: InboundOverview }) {
  const shipments = useShipments(overview)
  return (
    <Loaded query={shipments}>
      {data =>
        data.shipments.length === 0 ? (
          <Alert type="info" showIcon message="还没有货件" description="货件生成并发出后，这里显示运营中心的接收情况与差异。" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {data.shipments.map(shipment => (
              <ShipmentDiscrepancy key={shipment.id} shipment={shipment} />
            ))}
          </Space>
        )
      }
    </Loaded>
  )
}
