import type { EChartsOption } from 'echarts'
import type { WidgetType } from '@nova/api-contracts'
import { ChartPanel } from '../../components'

// 图表组件（P6-33）。只被画布懒加载，不进入仪表盘列表和首屏。

interface Row {
  id: string
  label: string
  values: Record<string, number | null>
}

export default function DashboardChart(props: { type: WidgetType; rows: Row[]; metric: string; label: string }) {
  const categories = props.rows.map(row => row.label)
  const values = props.rows.map(row => row.values[props.metric] ?? 0)
  const option: EChartsOption =
    props.type === 'PIE'
      ? { series: [{ type: 'pie', data: props.rows.map(row => ({ name: row.label, value: row.values[props.metric] ?? 0 })) }] }
      : {
          xAxis: props.type === 'HORIZONTAL_BAR' ? { type: 'value' } : { type: 'category', data: categories },
          yAxis: props.type === 'HORIZONTAL_BAR' ? { type: 'category', data: categories } : { type: 'value' },
          series: [{ type: props.type === 'LINE' ? 'line' : 'bar', name: props.label, data: values }],
        }
  return <ChartPanel title={props.label || '图表'} ariaLabel={props.label || '图表'} option={option} height={220} />
}
