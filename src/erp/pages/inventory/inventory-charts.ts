import type { EChartsOption } from 'echarts'
import type { InventorySummaryResponse } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 库存健康页的 4 张图（纯函数）：库存结构、库龄分布、可售天数分布、仓储费趋势。没有数据的图由页面显示“尚无记录”，这里不画空图。

type Charts = InventorySummaryResponse['charts']

const count = (value: unknown) => formatNumber(Number(value), { digits: 0 })
const base = { tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { top: 0 }, grid: { left: 56, right: 16, top: 36, bottom: 28 } } as const

export function structureOption(rows: Charts['structure']): EChartsOption {
  const stack = (name: string, pick: (row: Charts['structure'][number]) => number) => ({ name, type: 'bar' as const, stack: 'qty', data: rows.map(pick), tooltip: { valueFormatter: count } })
  return {
    ...base,
    xAxis: { type: 'category', data: rows.map(row => row.storeName) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
    series: [
      stack('可售', row => row.sellable),
      stack('预留', row => row.reserved),
      stack('在途', row => row.inbound),
      stack('不可售', row => row.unsellable),
      stack('调查中', row => row.researching),
    ],
  }
}

export function ageOption(distribution: Charts['ageDistribution']): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 56, right: 16, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: distribution.buckets.map(bucket => bucket.label) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
    series: [{ name: '件数', type: 'bar', data: distribution.buckets.map(bucket => bucket.qty), tooltip: { valueFormatter: count } }],
  }
}

export function coverOption(bins: Charts['coverDistribution']): EChartsOption {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 56, right: 16, top: 16, bottom: 40 },
    xAxis: { type: 'category', data: bins.map(bin => bin.label), axisLabel: { interval: 0, rotate: 20 } },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ name: 'SKU 数', type: 'bar', data: bins.map(bin => bin.count), tooltip: { valueFormatter: count } }],
  }
}

export function feeOption(trend: Charts['feeTrend']): EChartsOption {
  const money = (value: unknown) => formatMoney(Number(value), 'USD', { digits: 2 })
  const stack = (name: string, pick: (month: Charts['feeTrend']['months'][number]) => number) => ({
    name,
    type: 'bar' as const,
    stack: 'fee',
    data: trend.months.map(pick),
    tooltip: { valueFormatter: money },
  })
  return {
    ...base,
    xAxis: { type: 'category', data: trend.months.map(month => month.month) },
    yAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true }) } },
    series: [stack('月度仓储费', month => month.storage), stack('超量仓储费', month => month.overage), stack('长期仓储费', month => month.longTerm)],
  }
}

/** 仓储费趋势里一个月也没有金额时，图不画（页面显示“尚无记录”）。 */
export const hasFeeData = (trend: Charts['feeTrend']) => trend.months.some(month => month.storage + month.overage + month.longTerm > 0)
