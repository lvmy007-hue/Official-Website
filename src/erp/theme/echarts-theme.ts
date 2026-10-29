import { erpChartPalette, erpTokens as t } from './tokens'

// ECharts 主题：与 Ant Design、AG Grid 同一套令牌。
// 由 P1-05 的图表容器在初始化前通过 registerTheme 注册，主题名固定为 ERP_ECHARTS_THEME。
export const ERP_ECHARTS_THEME = 'nova-erp'

const axisCommon = {
  axisLine: { lineStyle: { color: t.line } },
  axisTick: { show: false },
  axisLabel: { color: t.inkMute, fontSize: t.fontSizes.caption },
  splitLine: { lineStyle: { color: t.line } },
}

export const erpEchartsTheme = {
  color: [...erpChartPalette],
  backgroundColor: 'transparent',
  textStyle: { color: t.inkSoft, fontFamily: t.fontFamily, fontSize: t.fontSizes.caption },
  title: { textStyle: { color: t.ink, fontSize: t.fontSizes.cardTitle, fontWeight: 600 } },
  legend: { textStyle: { color: t.inkSoft }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
  tooltip: {
    backgroundColor: t.canvas,
    borderColor: t.lineStrong,
    borderWidth: 1,
    textStyle: { color: t.ink, fontSize: t.fontSizes.caption },
    extraCssText: `box-shadow: ${t.shadowPopup};`,
  },
  grid: { left: 52, right: 16, top: 24, bottom: 28 },
  categoryAxis: axisCommon,
  valueAxis: axisCommon,
  timeAxis: axisCommon,
  line: { smooth: false, symbolSize: 4, lineStyle: { width: 2 } },
  bar: { barMaxWidth: 24 },
}
