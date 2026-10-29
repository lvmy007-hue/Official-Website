import { useMemo } from 'react'
import { Drawer, Tag } from 'antd'
import { compareLines, LISTING_COMPARE_MAX, LISTING_COMPARE_MIN, type ListingCompareLine, type ListingPerfRow } from '@nova/api-contracts'
import { LocalGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatNumber } from '../../format'
import { moneyCell, numberCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'

// 对比模式（05 章 5.3 “对比模式”；P6-28 起勾选与“对比所选”按钮由表格工具栏提供）：选 2 到 5 个商品并排比较同一组指标。
// 没有记录的格子写“尚无记录”；“较优”只在至少两个对象都有值且不全相等时标出，价格与可售天数不判优劣；没有权限的列读回来就是空，同样写“尚无记录”并提示去看列表的权限说明。

function cell(line: ListingCompareLine, value: number | null) {
  if (value === null) return <Muted>尚无记录</Muted>
  if (line.kind === 'money') return moneyCell(value)
  if (line.kind === 'percent') return percentCell(value)
  if (line.kind === 'days') return <span className="erp-num">{formatNumber(value, { digits: 1 })} 天</span>
  return numberCell(value)
}

export const canCompare = (count: number) => count >= LISTING_COMPARE_MIN && count <= LISTING_COMPARE_MAX

export function CompareDrawer({ rows, open, onClose }: { rows: readonly ListingPerfRow[]; open: boolean; onClose: () => void }) {
  const lines = useMemo(() => compareLines(rows), [rows])
  const columns = useMemo<ErpColDef<ListingCompareLine>[]>(
    () => [
      renderColumn<ListingCompareLine>('指标', 'label', line => line.label, { width: 130, pin: 'left', sortable: false }),
      ...rows.map((row, index) =>
        renderColumn<ListingCompareLine>(
          `${row.title}｜${row.asin} · ${row.sku}`,
          `item:${row.id}`,
          line => (
            <span>
              {cell(line, line.values[index] ?? null)}
              {line.bestIndex === index ? (
                <Tag color="success" bordered={false} style={{ marginLeft: 4 }}>
                  较优
                </Tag>
              ) : null}
            </span>
          ),
          { width: 200, sortable: false, ...RIGHT_ALIGNED },
        ),
      ),
    ],
    [rows],
  )
  return (
    <Drawer title={`对比 ${rows.length} 个商品`} width={Math.min(260 + rows.length * 200, 1100)} open={open} onClose={onClose} destroyOnClose>
      <LocalGrid<ListingCompareLine>
        gridId="listings.performance.compare"
        columns={columns}
        rows={lines}
        getRowId={line => line.key}
        resetKey={rows.map(row => row.id).join(',')}
        emptyState={{ kind: 'empty', domain: '对比', prerequisite: `请选择 ${LISTING_COMPARE_MIN} 到 ${LISTING_COMPARE_MAX} 个商品。` }}
        initialPageSize={50}
        height={420}
      />
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>较优：数值越高越好，退货率越低越好；价格与可售天数不判优劣。同店同 ASIN 的商品共用同一份销售与流量数字。</p>
    </Drawer>
  )
}
