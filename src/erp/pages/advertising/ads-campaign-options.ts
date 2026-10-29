import type { EChartsOption } from 'echarts'
import type { AdsCampaignTrendResponse } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 活动详情趋势图的配置（纯函数）。没有汇总行的日期保持为空（图上断开），不补成 0；对比期按位置对齐（第 n 天对第 n 天）。

export function buildTrendOption(data: Pick<AdsCampaignTrendResponse, 'points' | 'previousPoints' | 'events' | 'currency'>): EChartsOption {
  const money = (value: unknown) => formatMoney(Number(value), data.currency, { digits: 2 })
  const dates = data.points.map(point => point.date)
  const eventLines = data.events.filter(event => dates.includes(event.date)).map(event => ({ xAxis: event.date, label: { formatter: event.label.slice(0, 16), position: 'insideEndTop' as const } }))
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: 48, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: dates },
    yAxis: [
      { type: 'value', name: '金额', axisLabel: { formatter: (value: number) => formatMoney(value, data.currency, { digits: 0, compact: true }) } },
      { type: 'value', name: '点击', splitLine: { show: false }, axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0 }) } },
    ],
    series: [
      { name: '花费', type: 'bar', data: data.points.map(point => point.spend), tooltip: { valueFormatter: money }, markLine: eventLines.length ? { symbol: 'none', data: eventLines } : undefined },
      { name: '广告销售额', type: 'line', data: data.points.map(point => point.sales), connectNulls: false, showSymbol: false, tooltip: { valueFormatter: money } },
      { name: '点击', type: 'line', yAxisIndex: 1, data: data.points.map(point => point.clicks), connectNulls: false, showSymbol: false },
      ...(data.previousPoints.length
        ? [
            {
              name: '对比期花费',
              type: 'line' as const,
              data: dates.map((_date, index) => data.previousPoints[index]?.spend ?? null),
              connectNulls: false,
              showSymbol: false,
              lineStyle: { type: 'dashed' as const, opacity: 0.6 },
              tooltip: { valueFormatter: money },
            },
          ]
        : []),
    ],
  }
}
