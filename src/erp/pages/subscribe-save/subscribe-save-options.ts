import type { EChartsOption } from 'echarts'
import type { SnsMonthPoint, SnsTrendPoint } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 订阅省页面的图表配置（纯函数）：逐日趋势与月度对照。
// 某天没有记录是 null：柱缺失、线断开，不画成 0；提示框里写“尚无记录”。金额只画趋势币种（金额最大的币种）。

const SHIPPED = '#4c6ef5'
const ACTIVE = '#2f9e44'
const REVENUE = '#f08c00'

const count = (value: unknown) => (typeof value === 'number' ? formatNumber(value, { digits: 0 }) : '尚无记录')

interface Row {
  label: string
  activeSubscribers: number | null
  shippedUnits: number | null
  revenue: number | null
}

function build(rows: readonly Row[], currency: string | null, includeActive: boolean): EChartsOption {
  const money = (value: unknown) => (typeof value === 'number' ? formatMoney(value, currency ?? 'USD', { digits: 2 }) : '尚无记录')
  const series: NonNullable<EChartsOption['series']> = [
    { name: '订阅出货件数', type: 'bar', itemStyle: { color: SHIPPED }, data: rows.map(row => row.shippedUnits), tooltip: { valueFormatter: count } },
  ]
  if (includeActive)
    series.push({ name: '活跃订阅数', type: 'line', connectNulls: false, itemStyle: { color: ACTIVE }, data: rows.map(row => row.activeSubscribers), tooltip: { valueFormatter: count } })
  if (currency !== null) {
    series.push({
      name: `订阅销售额（${currency}）`,
      type: 'line',
      yAxisIndex: 1,
      connectNulls: false,
      itemStyle: { color: REVENUE },
      data: rows.map(row => row.revenue),
      tooltip: { valueFormatter: money },
    })
  }
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: currency === null ? 16 : 72, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: rows.map(row => row.label) },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0, compact: true }) } },
      ...(currency === null ? [] : [{ type: 'value' as const, splitLine: { show: false }, axisLabel: { formatter: (value: number) => formatMoney(value, currency, { digits: 0, compact: true }) } }]),
    ],
    series,
  }
}

/** 逐日趋势：横轴取日期的“月-日”。 */
export const buildDailyOption = (points: readonly SnsTrendPoint[], currency: string | null): EChartsOption =>
  build(
    points.map(point => ({ ...point, label: point.date.slice(5) })),
    currency,
    true,
  )

/** 月度对照：横轴是自然月（YYYY-MM）；只画出货与销售额（月度记录里活跃订阅数的口径没有对照真实响应核对过，不画）。 */
export const buildMonthlyOption = (months: readonly SnsMonthPoint[], currency: string | null): EChartsOption =>
  build(
    months.map(point => ({ ...point, label: point.month })),
    currency,
    false,
  )
