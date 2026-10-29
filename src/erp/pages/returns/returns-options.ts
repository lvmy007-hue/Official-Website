import type { EChartsOption } from 'echarts'
import type { ReturnBucket, ReturnCategoryRow, ReturnCycleBucketRow, ReturnTrendPoint } from '@nova/api-contracts'
import { formatNumber, formatPercent } from '../../format'

// 退货分析趋势图配置（纯函数）：退货件数柱（左轴）加退货率线（右轴，没有销售件数的桶保持断开，不补 0）。

export function buildTrendOption(points: readonly ReturnTrendPoint[], bucket: ReturnBucket): EChartsOption {
  const suffix = bucket === 'WEEK' ? '（周起）' : '（月）'
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 48, right: 56, top: 36, bottom: 28 },
    xAxis: { type: 'category', name: bucket === 'WEEK' ? '按周' : '按月', data: points.map(point => point.bucket) },
    yAxis: [
      { type: 'value', name: '退货件数', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
      { type: 'value', name: '退货率', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 1 }) }, splitLine: { show: false } },
    ],
    series: [
      {
        name: `退货件数${suffix}`,
        type: 'bar',
        data: points.map(point => point.returnedUnits),
        itemStyle: { opacity: 0.55 },
        tooltip: { valueFormatter: value => formatNumber(Number(value), { digits: 0 }) },
      },
      {
        name: '退货率',
        type: 'line',
        yAxisIndex: 1,
        data: points.map(point => point.rate),
        connectNulls: false,
        showSymbol: points.length <= 45,
        tooltip: { valueFormatter: value => (value === null || value === undefined ? '尚无记录' : formatPercent(Number(value), { digits: 2 })) },
      },
    ],
  }
}

/** 原因大类的退货件数（横向条形图，件数多的在上）。 */
export function buildCategoryOption(rows: readonly ReturnCategoryRow[]): EChartsOption {
  const sorted = [...rows].sort((a, b) => a.units - b.units)
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 96, right: 24, top: 12, bottom: 24 },
    xAxis: { type: 'value', name: '退货件数' },
    yAxis: { type: 'category', data: sorted.map(row => row.category) },
    series: [{ name: '退货件数', type: 'bar', data: sorted.map(row => row.units), tooltip: { valueFormatter: value => formatNumber(Number(value), { digits: 0 }) } }],
  }
}

/** 退货周期分布：每个天数段的退货件数（缺起点日期的不在里面，单独提示）。 */
export function buildCycleOption(buckets: readonly ReturnCycleBucketRow[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 48, right: 24, top: 24, bottom: 28 },
    xAxis: { type: 'category', name: '退货周期', data: buckets.map(bucket => bucket.label) },
    yAxis: { type: 'value', name: '退货件数' },
    series: [{ name: '退货件数', type: 'bar', data: buckets.map(bucket => bucket.units), tooltip: { valueFormatter: value => formatNumber(Number(value), { digits: 0 }) } }],
  }
}
