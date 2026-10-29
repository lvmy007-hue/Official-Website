import { useCallback, useState } from 'react'
import { Card, Checkbox, Input, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { InboundShipmentListResponse, InboundShipmentListRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FreshnessBar, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { ReceivingStatsPanel } from './ReceivingStatsPanel'
import { ShipmentGapPanel } from './ShipmentGapPanel'
import { ClaimTag, dayCount, diffText, inboundFreshnessInfo, noncomplianceText, qty, shipmentStatusText, timeText } from './inbound-ui'

// 货件接收与差异（P2a-13，06 章 6.12）：每个货件发出多少、收到多少、差在哪、赔付走到哪一步，加上按运营中心的接收时长统计。
// 差异只在货件关闭后判定（应发减已收，为正是少收、为负是多收）；首次接收与接收完成时间是同步时第一次看到的时间，不是亚马逊发生的时间。
// 没有数据的列写“尚无记录”，不合规报告没接入写“尚未接入”，都不写 0。

const columns: ColumnsType<InboundShipmentListRow> = [
  {
    title: '货件编号',
    dataIndex: 'shipmentId',
    width: 190,
    render: (value: string, row) => (
      <div>
        <AppLink to={`/app/warehouse/${encodeURIComponent(row.id)}`}>{value}</AppLink>
        {row.shipmentConfirmationId ? <div className="erp-num">{row.shipmentConfirmationId}</div> : null}
      </div>
    ),
  },
  { title: '目的运营中心', dataIndex: 'destinationFc', width: 120, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag bordered={false}>{shipmentStatusText(value)}</Tag> },
  { title: '应发', dataIndex: 'units', width: 80, align: 'right', render: qty },
  { title: '已收', dataIndex: 'receivedUnits', width: 80, align: 'right', render: qty },
  { title: '差异（应发−已收）', dataIndex: 'discrepancyUnits', width: 150, align: 'right', render: diffText },
  { title: '运输状态', key: 'transport', width: 110, render: (_value, row) => row.receiving.transportStatus ?? <Muted>尚无记录</Muted> },
  { title: '追踪号', dataIndex: 'trackingNumber', width: 160, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '首次接收时间', dataIndex: 'receivedFirstAt', width: 160, render: timeText },
  { title: '接收完成时间', dataIndex: 'receivedDoneAt', width: 160, render: timeText },
  { title: '差异天数', key: 'days', width: 90, align: 'right', render: (_value, row) => dayCount(row.receiving.discrepancyDays) },
  { title: '赔付状态', key: 'claim', width: 170, render: (_value, row) => <ClaimTag state={row.receiving.claimState} /> },
  { title: '不合规问题', key: 'noncompliance', width: 100, align: 'right', render: (_value, row) => noncomplianceText(row.receiving.noncomplianceCount) },
]

export default function ShipmentReceivingPage() {
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [fc, setFc] = useState('')
  const [fcText, setFcText] = useState('')
  const [onlyDiscrepancy, setOnlyDiscrepancy] = useState(false)
  // 新鲜度取自列表响应（只取一行）；货件行由表格按页码另取。
  const list = useApiQuery<InboundShipmentListResponse>({
    domain: 'list',
    path: '/inbound/shipments',
    params: { q: q || undefined, destinationFc: fc || undefined, discrepancy: onlyDiscrepancy ? '1' : undefined, page: 1, pageSize: 1 },
  })
  const data = list.data
  const fetchPage = useCallback<PageFetcher<InboundShipmentListRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<InboundShipmentListResponse>(
        buildPath('/inbound/shipments', { q: q || undefined, destinationFc: fc || undefined, discrepancy: onlyDiscrepancy ? '1' : undefined, page, pageSize }),
        { signal },
      )
      return { items: response.items, total: response.total }
    },
    [q, fc, onlyDiscrepancy],
  )

  return (
    <div>
      <PageHeader title="货件接收与差异" description="货件发出多少、运营中心收到多少、差在哪里、赔付走到哪一步。差异在货件关闭后才判定；首次接收与完成时间是同步时第一次看到的时间。" />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Card size="small">
          <FreshnessBar freshness={inboundFreshnessInfo(data?.freshness)} />
          <Space wrap style={{ marginBottom: 8 }}>
            <Input.Search
              allowClear
              style={{ width: 260 }}
              placeholder="搜索货件编号、确认号、追踪号"
              aria-label="搜索"
              value={text}
              onChange={event => setText(event.target.value)}
              onSearch={value => {
                setQ(value.trim())
              }}
            />
            <Input.Search
              allowClear
              style={{ width: 220 }}
              placeholder="目的运营中心，如 ONT8"
              aria-label="目的运营中心"
              value={fcText}
              onChange={event => setFcText(event.target.value)}
              onSearch={value => {
                setFc(value.trim().toUpperCase())
              }}
            />
            <Checkbox
              checked={onlyDiscrepancy}
              onChange={event => {
                setOnlyDiscrepancy(event.target.checked)
              }}
            >
              只看有未消除差异或不合规问题的货件
            </Checkbox>
            <Typography.Text type="secondary">点货件编号查看 SKU 差异、证据附件与赔付任务。</Typography.Text>
          </Space>
          <SimplePagedGrid<InboundShipmentListRow>
            gridId="inbound-shipments"
            columns={columns}
            fetchPage={fetchPage}
            rowKey={row => row.id}
            resetKey={JSON.stringify([q, fc, onlyDiscrepancy])}
            emptyState={{ kind: 'empty', domain: '货件', prerequisite: '还没有货件。入仓计划确认分仓方案后，亚马逊才会生成货件；同步入仓计划后这里会出现接收情况。' }}
          />
        </Card>
        <ShipmentGapPanel />
        <ReceivingStatsPanel />
      </Space>
    </div>
  )
}
