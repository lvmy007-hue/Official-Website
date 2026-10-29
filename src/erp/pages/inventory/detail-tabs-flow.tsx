import { useMemo, useState } from 'react'
import { Button, Space, Typography } from 'antd'
import type { EChartsOption } from 'echarts'
import type { InventoryInboundResponse, InventoryLedgerResponse, InventorySnapshotsResponse, InventoryStructureResponse, LedgerItem } from '@nova/api-contracts'
import { ChartPanel, MetricCard, MetricStrip, SnapshotDiff, useChartLink, SimpleGrid } from '../../components'
import { formatNumber } from '../../format'
import { QueryBody, useDetailQuery } from './detail-hooks'
import { LiveLink, Muted, PendingPanel, StateBlock } from './inventory-ui'
import { SOURCE_LABEL, StructureTable } from './structure-table'

// 库存详情前 4 个页签：库存结构趋势、历史快照、库存台账、入仓与在途。

const count = (value: unknown) => formatNumber(Number(value), { digits: 0 })

function structureOption(data: InventoryStructureResponse): EChartsOption {
  const line = (name: string, pick: (point: InventoryStructureResponse['points'][number]) => number | null) => ({
    name,
    type: 'line' as const,
    data: data.points.map(pick),
    connectNulls: false,
    showSymbol: data.points.length <= 45,
    tooltip: { valueFormatter: count },
  })
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: data.points.map(point => point.date) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
    series: [line('可售', p => p.sellable), line('在途', p => p.inbound), line('预留', p => p.reserved), line('不可售', p => p.unsellable), line('调查中', p => p.researching)],
  }
}

export function StructureTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryStructureResponse>(id, 'structure')
  const link = useChartLink()
  const sources = useMemo(() => [...new Set((query.data?.points ?? []).map(point => SOURCE_LABEL[point.source] ?? point.source))], [query.data])
  return (
    <QueryBody query={query}>
      {data => (
        <StateBlock state={data.state} note={data.note}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ChartPanel
              title={`库存结构趋势（${data.from} 至 ${data.to}）`}
              ariaLabel="库存结构趋势折线图"
              option={structureOption(data)}
              height={300}
              eventSource={{ objectType: 'INVENTORY', objectId: id }}
              {...link.chartProps}
              onTableRowFocus={category => link.onRowFocus({ category })}
              tableFilterCategory={link.filterCategory}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              同一天有多个来源时取优先级最高的一个（接口 &gt; 未抑制库存报告 &gt; 全部库存报告 &gt; 亚马逊物流报告），不跨来源相加；本期来源：{sources.join('、')}。缺少记录的日期图线断开，不补 0。
            </Typography.Text>
            <StructureTable points={data.points} filterDate={link.filterCategory} onRowFocus={date => link.onRowFocus({ category: date })} onClear={link.clear} />
          </Space>
        </StateBlock>
      )}
    </QueryBody>
  )
}

export function SnapshotsTab({ id }: { id: string }) {
  const [dates, setDates] = useState<[string | null, string | null]>([null, null])
  const base = useDetailQuery<InventorySnapshotsResponse>(id, 'snapshots')
  const both = dates[0] !== null && dates[1] !== null
  const compare = useDetailQuery<InventorySnapshotsResponse>(id, 'snapshots', { a: dates[0] ?? undefined, b: dates[1] ?? undefined }, both)
  return (
    <QueryBody query={base}>
      {data => (
        <SnapshotDiff
          title="历史快照对比（库存数量、规划报告、库龄分段）"
          availableDates={data.availableDates}
          dates={dates}
          onDatesChange={setDates}
          labels={data.labels}
          loading={both && compare.isPending}
          snapshots={compare.data ? [compare.data.a.values, compare.data.b.values] : undefined}
        />
      )}
    </QueryBody>
  )
}

function ReferenceCell({ item }: { item: LedgerItem }) {
  if (!item.referenceId) return <Muted>—</Muted>
  if (item.referenceKind === 'ORDER')
    return (
      <LiveLink component="OrderDetailPage" id={item.referenceId}>
        {item.referenceId}
      </LiveLink>
    )
  if (item.referenceKind === 'INBOUND_SHIPMENT')
    return (
      <LiveLink component="ShipmentReceivingDetailPage" id={item.referenceId}>
        {item.referenceId}
      </LiveLink>
    )
  return <>{item.referenceId}</>
}

export function LedgerTab({ id }: { id: string }) {
  // 游标翻页：保存已翻过的页的游标，上一页就是退回上一个游标
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const cursor = cursors[cursors.length - 1]
  const query = useDetailQuery<InventoryLedgerResponse>(id, 'ledger', { cursor, pageSize: 50 })
  return (
    <QueryBody query={query}>
      {data => (
        <StateBlock state={data.state} note={data.note}>
          <SimpleGrid<LedgerItem>
            gridId="inventory.detail-tabs-flow"
            columns={[
              { title: '日期', dataIndex: 'eventDate', width: 110 },
              { title: '事件', dataIndex: 'eventType', width: 130 },
              { title: '原因', dataIndex: 'reasonCode', width: 90 },
              { title: '库存状态', dataIndex: 'disposition', width: 110 },
              { title: '运营中心', dataIndex: 'fulfillmentCenter', width: 100 },
              { title: '数量', dataIndex: 'quantity', width: 80, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0, sign: true })}</span> },
              { title: '关联单据', key: 'ref', render: (_, item) => <ReferenceCell item={item} /> },
            ]}
            rows={data.items}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          <Space style={{ marginTop: 8 }}>
            <Button size="small" disabled={cursors.length <= 1} onClick={() => setCursors(list => list.slice(0, -1))}>
              上一页
            </Button>
            <Button size="small" disabled={!data.pageInfo.hasMore || !data.pageInfo.nextCursor} onClick={() => setCursors(list => [...list, data.pageInfo.nextCursor ?? undefined])}>
              下一页
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              关联单据对应页面上线后会自动变成链接，此前只显示编号
            </Typography.Text>
          </Space>
        </StateBlock>
      )}
    </QueryBody>
  )
}

export function InboundTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryInboundResponse>(id, 'inbound')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <MetricStrip>
            <MetricCard label="处理中" value={data.counts.working} format="number" />
            <MetricCard label="已发货" value={data.counts.shipped} format="number" />
            <MetricCard label="接收中" value={data.counts.receiving} format="number" />
            <MetricCard label="在途合计" value={data.counts.total} format="number" />
            <MetricCard label="计入可售天数" value={data.counts.counted} format="number" />
          </MetricStrip>
          <SimpleGrid
            gridId="inventory.detail-tabs-flow"
            columns={[
              { title: '入仓计划', dataIndex: 'planName' },
              { title: '计划状态', dataIndex: 'planStatus', width: 110 },
              { title: '该 SKU 计划数量', dataIndex: 'planQuantity', width: 120, align: 'right' },
              { title: '货件', key: 'shipment', width: 130, render: (_, row) => row.shipmentId ?? <Muted>尚未生成货件</Muted> },
              { title: '货件状态', key: 'status', width: 110, render: (_, row) => row.shipmentStatus ?? '—' },
              { title: '目的仓', key: 'fc', width: 90, render: (_, row) => row.destinationFc ?? '—' },
              { title: '已接收 / 预计（整货件）', key: 'progress', width: 170, render: (_, row) => (row.unitsExpected === null ? '—' : `${row.unitsReceived ?? 0} / ${row.unitsExpected}`) },
            ]}
            rows={data.shipments}
            rowKey={row => `${row.planId}:${row.shipmentId ?? ''}`}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '没有含该 SKU 的入仓计划' }}
          />
          <PendingPanel note={data.eta.note} workPackage={data.eta.workPackage} />
        </Space>
      )}
    </QueryBody>
  )
}
