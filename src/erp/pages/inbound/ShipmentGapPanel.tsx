import { useCallback, useMemo, useState } from 'react'
import { Card, Input, Radio, Space, Tag, Typography } from 'antd'
import { SHIPMENT_GAP_FILTERS, SHIPMENT_GAP_FILTER_LABEL, type ShipmentGapResponse, type ShipmentGapRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PagedGrid, numberColumn, renderColumn, textColumn, type ErpColDef, type PageFetcher } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'
import { diffText, shipmentStatusText } from './inbound-ui'

// 货件三种数量差异（P6-26，16 章第 5.1 节）：申报（分仓方案的预计件数）、已发（各 SKU 已发数量合计）、签收（运营中心接收合计）三列，
// 加两两相减的三种差异。签收相关的差异只在货件关闭后判定；没有数据显示“尚无记录”，不是 0。表格走服务端分页，快捷筛选在服务端过滤。

type GapFilter = (typeof SHIPMENT_GAP_FILTERS)[number] | 'ALL'

const columns: ErpColDef<ShipmentGapRow>[] = [
  renderColumn<ShipmentGapRow>('货件编号', 'shipmentId', row => <AppLink to={`/app/warehouse/${encodeURIComponent(row.id)}`}>{row.shipmentId}</AppLink>, { width: 190, pin: 'left', sortable: false }),
  textColumn<ShipmentGapRow>('入仓计划', 'planName', { width: 200, sortable: false }),
  textColumn<ShipmentGapRow>('目的运营中心', 'destinationFc', { width: 120, sortable: false }),
  renderColumn<ShipmentGapRow>('状态', 'status', row => <Tag bordered={false}>{shipmentStatusText(row.status)}</Tag>, { width: 100, sortable: false }),
  numberColumn<ShipmentGapRow>('申报', 'declared', { width: 90, digits: 0, sortable: false }),
  numberColumn<ShipmentGapRow>('已发', 'shipped', { width: 90, digits: 0, sortable: false }),
  numberColumn<ShipmentGapRow>('签收', 'received', { width: 90, digits: 0, sortable: false }),
  renderColumn<ShipmentGapRow>('申报 − 已发', 'declaredVsShipped', row => diffText(row.declaredVsShipped), { width: 130, sortable: false }),
  renderColumn<ShipmentGapRow>('已发 − 签收', 'shippedVsReceived', row => diffText(row.shippedVsReceived), { width: 130, sortable: false }),
  renderColumn<ShipmentGapRow>('申报 − 签收', 'declaredVsReceived', row => diffText(row.declaredVsReceived), { width: 130, sortable: false }),
]

export function ShipmentGapPanel() {
  const [gap, setGap] = useState<GapFilter>('ALL')
  const [q, setQ] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const fetchPage = useCallback<PageFetcher<ShipmentGapRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<ShipmentGapResponse>(buildPath('/inbound/shipments/discrepancies', { gap: gap === 'ALL' ? undefined : gap, q: q || undefined, page, pageSize }), { signal })
      setNote(response.note)
      setTruncated(response.truncated)
      return { items: response.items, total: response.total }
    },
    [gap, q],
  )
  const filtered = gap !== 'ALL' || q !== ''
  const options = useMemo(() => [{ value: 'ALL', label: '全部' }, ...SHIPMENT_GAP_FILTERS.map(value => ({ value, label: SHIPMENT_GAP_FILTER_LABEL[value] }))], [])

  return (
    <Card size="small" title="三种数量差异：申报 / 已发 / 签收" data-testid="shipment-gap-panel">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Radio.Group optionType="button" aria-label="差异快捷筛选" value={gap} options={options} onChange={event => setGap(event.target.value as GapFilter)} />
          <Input.Search allowClear style={{ width: 240 }} placeholder="搜索货件编号、确认号、计划名称" aria-label="搜索差异货件" onSearch={value => setQ(value.trim())} />
        </Space>
        {note ? <Typography.Text type="secondary">{note}</Typography.Text> : null}
        {truncated ? <Typography.Text type="warning">候选货件很多，只统计了最近更新的一部分；请用搜索缩小范围。</Typography.Text> : null}
        <PagedGrid<ShipmentGapRow>
          gridId="inbound.shipment-gap"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([gap, q])}
          appliedFilterCount={filtered ? 1 : 0}
          onClearFilters={() => {
            setGap('ALL')
            setQ('')
          }}
          emptyState={{ kind: 'empty', domain: '货件差异', prerequisite: filtered ? '没有符合当前筛选的货件；可以改选“全部”。' : '还没有货件。入仓计划确认分仓方案后，亚马逊才会生成货件。' }}
          height={420}
        />
      </Space>
    </Card>
  )
}
