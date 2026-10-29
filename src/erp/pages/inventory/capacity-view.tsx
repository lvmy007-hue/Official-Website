import type { ColumnsType } from 'antd/es/table'
import type { EChartsOption } from 'echarts'
import { Progress, Space, Typography } from 'antd'
import type { CapacityCrossing, CapacityRow, CapacitySuggestion, FeeMonth } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { Muted } from './inventory-ui'

// 仓储容量与费用页的表格列与图表（06 章 6.6）。费用没有记录写“尚无记录”，不写 0；
// 利用率（月度报告，只有比率）与限额、已用量（文件导入，逐项标注来源）分开显示，不互相推算。

const money = (value: number | null | undefined) => (value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>)
const count = (value: number | null | undefined) => (value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)

export const utilizationColumns: ColumnsType<CapacityRow> = [
  { title: '店铺', dataIndex: 'storeName', width: 140 },
  { title: '存储类型', dataIndex: 'storageTypeLabel', width: 100 },
  {
    title: '利用率（月度报告）',
    key: 'report',
    width: 220,
    render: (_value, row) =>
      row.report ? (
        <Space direction="vertical" size={0} style={{ width: '100%' }}>
          <Progress
            percent={Math.round(row.report.utilization * 100)}
            size="small"
            status={row.report.utilization >= 1 ? 'exception' : 'normal'}
            format={() => formatPercent(row.report!.utilization, { digits: 0 })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.report.month} 月报告
          </Typography.Text>
        </Space>
      ) : (
        <Muted>尚无记录</Muted>
      ),
  },
  { title: '限额（立方英尺）', key: 'limit', width: 130, align: 'right', render: (_value, row) => (row.limit ? count(row.limit.limitQty) : <Muted>尚未导入</Muted>) },
  { title: '已用', key: 'used', width: 100, align: 'right', render: (_value, row) => (row.limit ? count(row.limit.usedQty) : <Muted>尚未导入</Muted>) },
  {
    title: '已用比',
    key: 'ratio',
    width: 90,
    align: 'right',
    render: (_value, row) => (row.limit?.usedRatio != null ? <span className="erp-num">{formatPercent(row.limit.usedRatio, { digits: 1 })}</span> : <Muted>尚无记录</Muted>),
  },
  {
    title: '限额来源',
    key: 'source',
    render: (_value, row) =>
      row.limit ? (
        <span>
          文件导入 · {row.limit.sourceFileName ?? '未记录文件名'} · 采集 {row.limit.captureDate}
          {row.limit.importedBy ? ` · 导入人 ${row.limit.importedBy}` : ''}
        </span>
      ) : (
        <Muted>尚未导入限额文件</Muted>
      ),
  },
]

export const feeColumns: ColumnsType<FeeMonth> = [
  { title: '月份', dataIndex: 'month', width: 100 },
  { title: '月度仓储费', dataIndex: 'storage', align: 'right', render: money },
  { title: '超限费', dataIndex: 'overage', align: 'right', render: money },
  { title: '长期仓储费', dataIndex: 'longTerm', align: 'right', render: money },
  { title: '利用率附加费', dataIndex: 'utilization', align: 'right', render: money },
]

export const crossingColumns: ColumnsType<CapacityCrossing> = [
  { title: '店铺', dataIndex: 'storeName', width: 130 },
  { title: 'SKU', dataIndex: 'sku', width: 170 },
  { title: '即将跨入', dataIndex: 'toLabel', width: 110 },
  { title: '涉及件数', dataIndex: 'qty', align: 'right', width: 90, render: count },
  { title: '最早跨档日', dataIndex: 'earliestDate', width: 110 },
  { title: '最晚跨档日', dataIndex: 'latestDate', width: 110 },
  { title: '预估增加的附加费', dataIndex: 'estimatedIncrease', align: 'right', width: 140, render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : money(value)) },
]

export const suggestionColumns: ColumnsType<CapacitySuggestion> = [
  { title: '店铺', dataIndex: 'storeName', width: 130 },
  {
    title: 'SKU',
    key: 'sku',
    width: 220,
    render: (_value, row) => (
      <Space direction="vertical" size={0}>
        <span>{row.sku}</span>
        {row.title ? (
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 200 }}>
            {row.title}
          </Typography.Text>
        ) : null}
      </Space>
    ),
  },
  {
    title: '占用体积',
    key: 'volume',
    align: 'right',
    width: 130,
    render: (_value, row) =>
      row.occupiedVolume === null ? (
        <Muted>尚无记录</Muted>
      ) : (
        <span className="erp-num">
          {formatNumber(row.occupiedVolume, { digits: 1 })} {row.volumeUnit ?? ''}
        </span>
      ),
  },
  { title: '可售', dataIndex: 'sellable', align: 'right', width: 80, render: count },
  {
    title: '可售天数',
    dataIndex: 'daysOfCover',
    align: 'right',
    width: 100,
    render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>),
  },
  { title: '预计下月仓储费', dataIndex: 'nextMonthStorage', align: 'right', width: 130, render: money },
  { title: '建议', dataIndex: 'actionLabel', width: 110 },
  { title: '原因', dataIndex: 'reason' },
]

/** 费用趋势：没有记录的月份留空，不画成 0。 */
export function feeTrendOption(months: FeeMonth[]): EChartsOption {
  const series = (name: string, key: 'storage' | 'overage' | 'longTerm') => ({
    name,
    type: 'bar' as const,
    stack: 'fee',
    data: months.map(month => month[key]),
    tooltip: { valueFormatter: (value: unknown) => formatMoney(Number(value), 'USD', { digits: 2 }) },
  })
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: months.map(month => month.month) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true }) } },
    series: [series('月度仓储费', 'storage'), series('超限费', 'overage'), series('长期仓储费', 'longTerm')],
  }
}

export const hasFeeData = (months: FeeMonth[]) => months.some(month => month.storage !== null || month.overage !== null || month.longTerm !== null)
