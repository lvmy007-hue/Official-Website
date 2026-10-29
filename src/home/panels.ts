import type { EChartsOption } from 'echarts'

export type Lang = 'zh' | 'en'
const T = (lang: Lang, zh: string, en: string) => (lang === 'en' ? en : zh)

const AXIS_LINE = '#eceef2'
const SPLIT = '#f1f3f7'
const LABEL = '#9aa3b2'
const BRAND = '#2b63f0'

const areaFill = {
  type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
  colorStops: [
    { offset: 0, color: 'rgba(43,99,240,.26)' },
    { offset: 1, color: 'rgba(43,99,240,0)' },
  ],
}

const baseGrid = { left: 8, right: 14, top: 18, bottom: 24, containLabel: true }

export const days14 = ['10-07', '10-08', '10-09', '10-10', '10-11', '10-12', '10-13', '10-14', '10-15', '10-16', '10-17', '10-18', '10-19', '10-20']

/** 销售额趋势（面积折线，含毛利对照线） */
export function salesTrendOption(sales: number[], profit: number[], lang: Lang = 'zh'): EChartsOption {
  const nameSales = T(lang, '销售额', 'Sales')
  const nameProfit = T(lang, '毛利', 'Gross profit')
  return {
    color: [BRAND, '#12a38a'],
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: AXIS_LINE, textStyle: { color: '#1a1d23' }, valueFormatter: (v) => '$' + Number(v).toLocaleString('en-US') },
    legend: { data: [nameSales, nameProfit], right: 0, top: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4, textStyle: { color: '#86909c', fontSize: 11 } },
    grid: baseGrid,
    xAxis: {
      type: 'category', boundaryGap: false, data: days14,
      axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false },
      axisLabel: { color: LABEL, fontSize: 10, interval: 1 },
    },
    yAxis: {
      type: 'value', splitLine: { lineStyle: { color: SPLIT } },
      axisLabel: { color: LABEL, fontSize: 10, formatter: (v: number) => '$' + v / 1000 + 'k' },
    },
    series: [
      {
        name: nameSales, type: 'line', smooth: true, showSymbol: false, symbolSize: 7, data: sales,
        lineStyle: { width: 3, color: BRAND }, itemStyle: { color: BRAND },
        areaStyle: { color: areaFill as never },
        markPoint: { symbol: 'pin', symbolSize: 44, symbolOffset: [0, -4], data: [{ type: 'max', name: T(lang, '峰值', 'Peak') }], itemStyle: { color: BRAND }, label: { color: '#fff', fontSize: 10, formatter: (p: { value?: number | string }) => '$' + Math.round(Number(p.value ?? 0) / 1000) + 'k' } } as never,
      },
      {
        name: nameProfit, type: 'line', smooth: true, showSymbol: false, data: profit,
        lineStyle: { width: 2, color: '#12a38a', type: 'dashed' }, itemStyle: { color: '#12a38a' },
      },
    ],
  }
}

/** 站点销售额占比（环形） */
export function siteShareOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#2b63f0', '#5b86ff', '#8aacff', '#b7ccff', '#dbe6ff'],
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, left: 'center', icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#4e5969', fontSize: 11 } },
    series: [
      {
        type: 'pie', radius: ['56%', '78%'], center: ['50%', '42%'], avoidLabelOverlap: true,
        padAngle: 2, itemStyle: { borderRadius: 4 },
        label: {
          show: true, position: 'center',
          formatter: '{a|US 46%}\n{b|' + T(lang, '主站占比', 'Top market') + '}',
          rich: { a: { fontSize: 17, fontWeight: 700, color: '#1a1d23' }, b: { fontSize: 11, color: '#86909c', padding: [4, 0, 0, 0] } },
        },
        labelLine: { show: false },
        data: [
          { value: 46, name: 'US' }, { value: 18, name: 'UK' }, { value: 14, name: 'DE' },
          { value: 12, name: 'JP' }, { value: 10, name: T(lang, '其他', 'Other') },
        ],
      },
    ],
  }
}

/** 广告结构（横向柱 + ACoS 对照） */
export function adsBreakdownOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#2b63f0'],
    grid: { left: 8, right: 36, top: 10, bottom: 10, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: LABEL, fontSize: 10, formatter: '${value}' } },
    yAxis: { type: 'category', data: [T(lang, 'SB 品牌', 'SB'), T(lang, 'SP 手动', 'SP manual'), T(lang, 'SP 自动', 'SP auto')], axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#4e5969', fontSize: 11 } },
    series: [
      {
        type: 'bar', data: [1240, 3180, 4620], barWidth: 14,
        itemStyle: { borderRadius: [0, 7, 7, 0], color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#5b86ff' }, { offset: 1, color: '#2b63f0' }] } as never },
        label: { show: true, position: 'right', color: '#86909c', fontSize: 10, formatter: '${@[0]}' },
      },
    ],
  }
}

/** 库存周转（柱 + 安全线） */
export function inventoryTurnOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#2b63f0'],
    grid: baseGrid,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: ['SKU-A1', 'SKU-B2', 'SKU-C3', 'SKU-D4', 'SKU-E5', 'SKU-F6'], axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: { color: LABEL, fontSize: 10 } },
    yAxis: { type: 'value', name: T(lang, '可售天数', 'Days of cover'), nameTextStyle: { color: LABEL, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: LABEL, fontSize: 10 } },
    series: [
      {
        type: 'bar', data: [52, 18, 34, 9, 41, 27], barWidth: '46%',
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: (p: { value: number }) => (p.value < 20 ? '#e08a00' : '#2b63f0'),
        } as never,
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#d4380d', type: 'dashed' }, data: [{ yAxis: 20, label: { formatter: T(lang, '补货线 20 天', 'Reorder line 20d'), color: '#d4380d', fontSize: 10, position: 'insideEndTop' } }] },
      },
    ],
  }
}

/** 订单状态分布（环形） */
export function orderStatusOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#12a38a', '#2b63f0', '#e08a00'],
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, left: 'center', icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#4e5969', fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['56%', '78%'], center: ['50%', '44%'], padAngle: 2,
      itemStyle: { borderRadius: 4 }, labelLine: { show: false }, label: { show: false },
      data: [
        { value: 68, name: T(lang, '已送达', 'Delivered') },
        { value: 20, name: T(lang, '已发货', 'Shipped') },
        { value: 12, name: T(lang, '处理中', 'Processing') },
      ],
    }],
  }
}

/** 退款额按原订单月（柱） */
export function returnByMonthOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#2b63f0'],
    grid: baseGrid,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => '$' + Number(v).toLocaleString('en-US') },
    xAxis: { type: 'category', data: [T(lang, '07 月', 'Jul'), T(lang, '08 月', 'Aug'), T(lang, '09 月', 'Sep')], axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: { color: LABEL, fontSize: 10 } },
    yAxis: { type: 'value', name: T(lang, '退款额', 'Refunds'), nameTextStyle: { color: LABEL, fontSize: 10 }, splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: LABEL, fontSize: 10, formatter: '${value}' } },
    series: [{
      type: 'bar', data: [120, 260, 90], barWidth: '46%',
      itemStyle: { borderRadius: [6, 6, 0, 0], color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#5b86ff' }, { offset: 1, color: '#2b63f0' }] } as never },
    }],
  }
}

/** 刊登状态占比（环形） */
export function listingStatusOption(lang: Lang = 'zh'): EChartsOption {
  return {
    color: ['#12a38a', '#e08a00', '#86909c'],
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, left: 'center', icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#4e5969', fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['56%', '78%'], center: ['50%', '44%'], padAngle: 2,
      itemStyle: { borderRadius: 4 }, labelLine: { show: false }, label: { show: false },
      data: [
        { value: 72, name: T(lang, '在售', 'Active') },
        { value: 18, name: T(lang, '未完成', 'Incomplete') },
        { value: 10, name: T(lang, '已关闭', 'Closed') },
      ],
    }],
  }
}

/** FBA 入库接收进度（堆叠柱） */
export function inboundProgressOption(lang: Lang = 'zh'): EChartsOption {
  return {
    grid: baseGrid,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 6, textStyle: { color: '#86909c', fontSize: 10 } },
    xAxis: { type: 'category', data: [T(lang, '计划-A', 'Plan-A'), T(lang, '货件-1', 'Ship-1'), T(lang, '货件-2', 'Ship-2')], axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: { color: LABEL, fontSize: 10 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: SPLIT } }, axisLabel: { color: LABEL, fontSize: 10 } },
    series: [
      { name: T(lang, '已接收', 'Received'), type: 'bar', stack: 'x', data: [0, 120, 300], barWidth: '46%', itemStyle: { color: '#12a38a', borderRadius: [0, 0, 0, 0] } },
      { name: T(lang, '在途', 'In transit'), type: 'bar', stack: 'x', data: [200, 180, 0], barWidth: '46%', itemStyle: { color: '#5b86ff' } },
    ],
  }
}
