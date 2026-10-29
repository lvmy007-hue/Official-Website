import type { EChartsOption } from 'echarts'
import type { SalesTaxTrendPoint } from '@nova/api-contracts'
import { formatMoney } from '../../format'

// 销售税趋势图配置（纯函数，P2b-12）：每月一组柱，报告合计与订单接口合计并排。
// 某个月某一边没有记录就是空（图上不画柱，提示里写“尚无记录”），绝不画成 0。

const REPORT_COLOR = '#4c6ef5'
const ORDERS_COLOR = '#adb5bd'

export function buildSalesTaxTrendOption(points: readonly SalesTaxTrendPoint[]): EChartsOption {
  const money = (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true })
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatMoney(value, 'USD', { digits: 2 }) : '尚无记录') },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: points.map(point => point.month) },
    yAxis: { type: 'value', axisLabel: { formatter: money } },
    series: [
      { name: '税务文档库报告', type: 'bar', data: points.map(point => point.reportTax), itemStyle: { color: REPORT_COLOR } },
      { name: '订单接口', type: 'bar', data: points.map(point => point.ordersTax), itemStyle: { color: ORDERS_COLOR } },
    ],
  }
}
