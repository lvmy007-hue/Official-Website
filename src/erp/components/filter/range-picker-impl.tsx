import { DatePicker } from 'antd'
import type { RangePickerProps } from 'antd/es/date-picker'

// 日期区间选择器单独成块：日期组件体积大，范围栏先显示，选择器随后加载，不占首屏脚本预算（P1-09）。
export default function RangePickerImpl(props: RangePickerProps) {
  return <DatePicker.RangePicker {...props} />
}
