import { useCallback, useMemo } from 'react'
import { Space, Tag, Typography } from 'antd'
import type { StructurePoint } from '@nova/api-contracts'
import { PagedGrid, numberColumn, textColumn, type ErpColDef, type PageFetcher } from '../../components'
import { EMPTY_VALUE } from '../../format'

// 库存结构趋势的“每日明细”表（P6-06）：与上面的趋势图联动。
// 图上点某一天 → 这张表只显示那一天；表里点某一行 → 图上高亮那一天。数据和图是同一份，不另取数。

export const SOURCE_LABEL: Record<string, string> = { API: '库存接口', MYI_UNSUPPRESSED: '库存报告（未抑制）', MYI_ALL: '库存报告（全部）', AFN: '亚马逊物流库存报告' }

const quantity = (label: string, field: keyof StructurePoint & string): ErpColDef<StructurePoint> =>
  numberColumn<StructurePoint>(label, field, { digits: 0, valueFormatter: params => (typeof params.value === 'number' ? String(params.value) : EMPTY_VALUE) })

const COLUMNS: ErpColDef<StructurePoint>[] = [
  { ...textColumn<StructurePoint>('日期', 'date'), pin: 'left', minWidth: 110 },
  quantity('可售', 'sellable'),
  quantity('在途', 'inbound'),
  quantity('预留', 'reserved'),
  quantity('不可售', 'unsellable'),
  quantity('调查中', 'researching'),
  { ...textColumn<StructurePoint>('来源', 'source'), valueFormatter: params => SOURCE_LABEL[String(params.value)] ?? String(params.value ?? EMPTY_VALUE), minWidth: 160 },
]

export function StructureTable({ points, filterDate, onRowFocus, onClear }: { points: readonly StructurePoint[]; filterDate: string | null; onRowFocus: (date: string) => void; onClear: () => void }) {
  const rows = useMemo(() => points.filter(point => !filterDate || point.date === filterDate), [points, filterDate])
  const fetchPage = useCallback<PageFetcher<StructurePoint>>(async ({ page, pageSize }) => ({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }), [rows])
  const first = points[0]?.date ?? ''
  const last = points[points.length - 1]?.date ?? ''
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }} data-testid="structure-table">
      <Space size={8} wrap>
        <Typography.Text strong>每日明细</Typography.Text>
        {filterDate ? (
          <Tag closable bordered={false} color="processing" onClose={onClear}>
            仅显示 {filterDate}
          </Tag>
        ) : (
          <Typography.Text type="secondary">在趋势图上点某一天可以只看那一天；点表里的一行，图上会标出那一天。</Typography.Text>
        )}
      </Space>
      <PagedGrid<StructurePoint>
        gridId="inventory.structure-daily"
        columns={COLUMNS}
        fetchPage={fetchPage}
        getRowId={row => row.date}
        resetKey={JSON.stringify([first, last, points.length, filterDate])}
        emptyState={{ kind: 'empty', domain: '每日库存明细', prerequisite: '所选时间范围内需要有库存快照' }}
        onRowOpen={row => onRowFocus(row.date)}
        initialPageSize={20}
        height={320}
      />
    </Space>
  )
}
