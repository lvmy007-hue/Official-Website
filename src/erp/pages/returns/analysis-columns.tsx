import { Tag } from 'antd'
import type { ReturnAsinRow, ReturnCategoryRow, ReturnCohortRow, ReturnCycleBucketRow, ReturnCycleSliceRow, ReturnDispositionRow, ReturnRankRow, ReturnReasonSummaryRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import { formatNumber, formatPercent } from '../../format'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { unitsText } from './analysis-shared'
import { CategoryText, rateText } from './returns-ui'

// 退货分析各张表的列（P6-13）。所有表都是小表（接口一次返回），用 PagedGrid 骨架显示；没有数据写“尚无记录”，不写 0。
// 指标问号取指标字典：退货率 M-310、退货周期 M-700、周期中位数 M-701、跨月占比 M-702、队列退货率 M-703。

const share = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)
const days = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 1 })} 天</span>)
const right = { sortable: false, ...RIGHT_ALIGNED } as const

function asinCell(row: { asin: string; productId: string | null }) {
  return row.productId ? (
    <LiveLink component="Asin360Page" id={row.productId}>
      {row.asin}
    </LiveLink>
  ) : (
    <span className="erp-num">{row.asin}</span>
  )
}

export const asinColumns: ErpColDef<ReturnAsinRow>[] = [
  renderColumn<ReturnAsinRow>('ASIN', 'asin', asinCell, { pin: 'left', width: 140, sortable: false }),
  renderColumn<ReturnAsinRow>('商品', 'title', row => row.title ?? <Muted>尚无记录</Muted>, { width: 280, sortable: false }),
  renderColumn<ReturnAsinRow>('退货件数', 'returnedUnits', row => unitsText(row.returnedUnits), { width: 110, ...right }),
  renderColumn<ReturnAsinRow>('销售件数', 'soldUnits', row => unitsText(row.soldUnits), { width: 110, ...right }),
  renderColumn<ReturnAsinRow>('退货率', 'rate', row => rateText(row.rate), { width: 110, metric: 'M-310', ...right }),
  renderColumn<ReturnAsinRow>('主要原因', 'topReason', row => (row.topReason ? `${row.topReason.label}（${row.topReason.units} 件）` : <Muted>尚无记录</Muted>), { width: 240, sortable: false }),
]

export const rankColumns: ErpColDef<ReturnRankRow>[] = [
  renderColumn<ReturnRankRow>('ASIN', 'asin', asinCell, { pin: 'left', width: 140, sortable: false }),
  renderColumn<ReturnRankRow>('商品', 'title', row => row.title ?? <Muted>尚无记录</Muted>, { width: 240, sortable: false }),
  renderColumn<ReturnRankRow>('本期件数', 'current', row => unitsText(row.current), { width: 110, ...right }),
  renderColumn<ReturnRankRow>('上期件数', 'previous', row => unitsText(row.previous), { width: 110, ...right }),
  renderColumn<ReturnRankRow>('上上期件数', 'beforePrevious', row => unitsText(row.beforePrevious), { width: 120, ...right }),
  renderColumn<ReturnRankRow>('比上期', 'delta', row => <span className="erp-num">{row.delta > 0 ? `+${row.delta}` : String(row.delta)}</span>, { width: 100, ...right }),
  renderColumn<ReturnRankRow>(
    '连续变化',
    'streak',
    row =>
      row.streak ? (
        <Tag color={row.delta > 0 ? 'error' : 'success'} bordered={false}>
          {row.delta > 0 ? '连续增加' : '连续减少'}
        </Tag>
      ) : (
        <Muted>—</Muted>
      ),
    { width: 120, sortable: false },
  ),
  renderColumn<ReturnRankRow>('本期退货率', 'rate', row => rateText(row.rates.current), { width: 120, metric: 'M-310', ...right }),
]

export const reasonColumns: ErpColDef<ReturnReasonSummaryRow>[] = [
  renderColumn<ReturnReasonSummaryRow>('原因代码', 'code', row => <span className="erp-num">{row.code}</span>, { group: '退货原因', pin: 'left', width: 230, sortable: false }),
  renderColumn<ReturnReasonSummaryRow>('中文释义', 'label', row => row.label, { group: '退货原因', width: 190, sortable: false }),
  renderColumn<ReturnReasonSummaryRow>('大类', 'category', row => <CategoryText category={row.category} />, { group: '退货原因', width: 140, sortable: false }),
  renderColumn<ReturnReasonSummaryRow>('退货件数', 'units', row => unitsText(row.units), { width: 110, ...right }),
  renderColumn<ReturnReasonSummaryRow>('占比', 'share', row => share(row.share), { width: 100, ...right }),
]

export const categoryColumns: ErpColDef<ReturnCategoryRow>[] = [
  renderColumn<ReturnCategoryRow>('大类', 'category', row => <CategoryText category={row.category} />, { pin: 'left', width: 200, sortable: false }),
  renderColumn<ReturnCategoryRow>('退货件数', 'units', row => unitsText(row.units), { width: 110, ...right }),
  renderColumn<ReturnCategoryRow>('占比', 'share', row => share(row.share), { width: 100, ...right }),
]

export const dispositionColumns: ErpColDef<ReturnDispositionRow>[] = [
  renderColumn<ReturnDispositionRow>('处置结果', 'label', row => row.label, { pin: 'left', width: 200, sortable: false }),
  renderColumn<ReturnDispositionRow>('退货件数', 'units', row => unitsText(row.units), { width: 110, ...right }),
  renderColumn<ReturnDispositionRow>('占比', 'share', row => share(row.share), { width: 100, ...right }),
]

export const cycleBucketColumns: ErpColDef<ReturnCycleBucketRow>[] = [
  renderColumn<ReturnCycleBucketRow>('天数段', 'label', row => row.label, { pin: 'left', width: 180, metric: 'M-700', sortable: false }),
  renderColumn<ReturnCycleBucketRow>('退货件数', 'units', row => unitsText(row.units), { width: 110, ...right }),
  renderColumn<ReturnCycleBucketRow>('占比', 'share', row => share(row.share), { width: 100, ...right }),
]

/** 周期切片表：每个切片一行，带中位数与各天数段的件数（列数随天数段设置变化）。 */
export function cycleSliceColumns(headerName: string, buckets: readonly ReturnCycleBucketRow[]): ErpColDef<ReturnCycleSliceRow>[] {
  return [
    renderColumn<ReturnCycleSliceRow>(headerName, 'label', row => row.label, { pin: 'left', width: 220, sortable: false }),
    renderColumn<ReturnCycleSliceRow>('退货件数', 'units', row => unitsText(row.units), { width: 110, ...right }),
    renderColumn<ReturnCycleSliceRow>('周期中位数', 'median', row => days(row.median), { width: 130, metric: 'M-701', ...right }),
    ...buckets.map((bucket, index) =>
      renderColumn<ReturnCycleSliceRow>(bucket.label, `bucket:${bucket.key}`, row => unitsText(row.buckets[index] ?? 0), {
        group: '各天数段件数',
        width: 120,
        metric: index === 0 ? 'M-700' : undefined,
        ...right,
      }),
    ),
  ]
}

export const cohortColumns: ErpColDef<ReturnCohortRow>[] = [
  renderColumn<ReturnCohortRow>('下单月', 'month', row => <span className="erp-num">{row.month}</span>, { group: '下单月', pin: 'left', width: 120, sortable: false }),
  renderColumn<ReturnCohortRow>(
    '退货窗口',
    'windowOpen',
    row =>
      row.windowOpen ? (
        <Tag color="warning" bordered={false}>
          窗口未结束
        </Tag>
      ) : (
        <Muted>已结束</Muted>
      ),
    { group: '下单月', width: 130, sortable: false },
  ),
  renderColumn<ReturnCohortRow>('销售件数', 'soldUnits', row => unitsText(row.soldUnits), { group: '队列口径（同一批订单）', width: 110, ...right }),
  renderColumn<ReturnCohortRow>('产生的退货件数', 'cohortReturnedUnits', row => unitsText(row.cohortReturnedUnits), { group: '队列口径（同一批订单）', width: 140, ...right }),
  renderColumn<ReturnCohortRow>('队列退货率', 'cohortRate', row => rateText(row.cohortRate), { group: '队列口径（同一批订单）', width: 120, metric: 'M-703', ...right }),
  renderColumn<ReturnCohortRow>('当月发生的退货件数', 'returnedInMonthUnits', row => unitsText(row.returnedInMonthUnits), { group: '退货日口径', width: 160, ...right }),
  renderColumn<ReturnCohortRow>('退货率', 'returnDateRate', row => rateText(row.returnDateRate), { group: '退货日口径', width: 110, metric: 'M-310', ...right }),
]

/** 矩阵的一行：行标题加各列的件数。 */
export type MatrixRow = { key: string; label: string; cells: readonly number[]; total: number }

/** 矩阵表（下单月 × 退货月、库存属性 × 处置结果）：列随数据变化；0 件写 0（这是确实退了 0 件，不是缺数据）。 */
export function matrixColumns(firstHeader: string, headers: readonly string[], options: { group: string; metric?: string }): ErpColDef<MatrixRow>[] {
  return [
    renderColumn<MatrixRow>(firstHeader, 'label', row => row.label, { pin: 'left', width: 200, sortable: false }),
    ...headers.map((header, index) =>
      renderColumn<MatrixRow>(header, `col:${index}`, row => <span className="erp-num">{formatNumber(row.cells[index] ?? 0, { digits: 0 })}</span>, {
        group: options.group,
        width: 120,
        metric: index === 0 ? options.metric : undefined,
        ...right,
      }),
    ),
    renderColumn<MatrixRow>('合计', 'total', row => <span className="erp-num">{formatNumber(row.total, { digits: 0 })}</span>, { width: 110, ...right }),
  ]
}

export function matrixRows(rows: ReadonlyArray<{ key: string; label: string }>, cells: readonly (readonly number[])[]): MatrixRow[] {
  return rows.map((row, index) => {
    const line = cells[index] ?? []
    return { key: row.key, label: row.label, cells: line, total: line.reduce((sum, value) => sum + value, 0) }
  })
}
