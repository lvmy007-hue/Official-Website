import { Suspense, lazy, useMemo } from 'react'
import { Button, Select, Tag } from 'antd'
import type { RangePickerProps } from 'antd/es/date-picker'
import dayjs, { type Dayjs } from 'dayjs'
import { SCOPE_MAX_DAYS } from '@nova/api-contracts'
import { compareRangeOf, rangePresets, spanDays, type DateRange } from '../../scope/dates'

// 统一日期组件（P6-04，15 章第 7 节）：日期区间（快捷项：今天、昨天、近 7/14/30/90 天、本月、上月、本季、本年，自定义靠手选）
// + 对比方式（不对比 / 环比 / 同比 / 自定义区间）。“今天”以 today 为准——由调用方按站点时区算好传入（P6-31 之前用美国站时区）。
// 全局范围栏与页面自己的日期字段共用它；本身不读写地址栏，取值与回调都由调用方管理。
// 日期选择器体积大，单独懒加载（首屏脚本预算）：加载完成前显示一个禁用的输入框占位。

export type CompareMode = 'none' | 'previous' | 'yoy' | 'custom'
export type CompareModeOption = { id: CompareMode; label: string }

export const DEFAULT_COMPARE_MODES: CompareModeOption[] = [
  { id: 'none', label: '不对比' },
  { id: 'previous', label: '上一期' },
  { id: 'yoy', label: '去年同期' },
  { id: 'custom', label: '自定义' },
]

const LazyRangePicker = lazy(() => import('./range-picker-impl'))
function RangePicker(props: RangePickerProps) {
  const label = Array.isArray(props.placeholder) ? props.placeholder.join('至') : '时间范围'
  return (
    <Suspense
      fallback={
        <Button disabled style={{ width: 240, textAlign: 'left' }} aria-label={props['aria-label'] ?? label}>
          {label}
        </Button>
      }
    >
      <LazyRangePicker {...props} />
    </Suspense>
  )
}

const DATE_FORMAT = 'YYYY-MM-DD'
const toRange = (value: [Dayjs | null, Dayjs | null] | null): DateRange | null => (value?.[0] && value[1] ? { from: value[0].format(DATE_FORMAT), to: value[1].format(DATE_FORMAT) } : null)
const asPair = (range: DateRange | null | undefined): [Dayjs, Dayjs] | null => (range ? [dayjs(range.from), dayjs(range.to)] : null)

export type DateRangeControlProps = {
  /** 站点时区的“今天”（YYYY-MM-DD）：快捷项以它为基准，晚于它的日期不可选。 */
  today: string
  range: DateRange | null
  compare: CompareMode
  compareRange: DateRange | null
  /** 对比方式的选项（服务端给的文案）；不传用默认。 */
  compareModes?: CompareModeOption[]
  /** 时间范围最长天数，超过的选择被忽略。 */
  maxDays?: number
  onRangeChange: (range: DateRange | null) => void
  onCompareChange: (mode: CompareMode) => void
  onCompareRangeChange: (range: DateRange | null) => void
}

export function DateRangeControl(props: DateRangeControlProps) {
  const { today, range, compare, compareRange, maxDays = SCOPE_MAX_DAYS } = props
  const presets = useMemo(() => rangePresets(today).map(item => ({ label: item.label, value: [dayjs(item.range.from), dayjs(item.range.to)] as [Dayjs, Dayjs] })), [today])
  // 自定义以外的对比区间由规则推出，用来在旁边说明“对比的是哪一段”
  const derived = compare === 'custom' ? null : compareRangeOf(range, compare)
  return (
    <>
      <RangePicker
        allowClear
        presets={presets}
        value={asPair(range)}
        placeholder={['开始日期', '结束日期']}
        disabledDate={date => date.format(DATE_FORMAT) > today}
        onChange={value => {
          const next = toRange(value as [Dayjs | null, Dayjs | null] | null)
          if (next && spanDays(next.from, next.to) > maxDays) return
          props.onRangeChange(next)
        }}
        aria-label="时间范围"
      />
      <Select
        style={{ width: 112 }}
        value={compare}
        options={(props.compareModes ?? DEFAULT_COMPARE_MODES).map(item => ({ value: item.id, label: item.label }))}
        onChange={value => props.onCompareChange(value as CompareMode)}
        aria-label="对比期"
      />
      {compare === 'custom' ? (
        <RangePicker
          allowClear
          value={asPair(compareRange)}
          placeholder={['对比开始', '对比结束']}
          onChange={value => props.onCompareRangeChange(toRange(value as [Dayjs | null, Dayjs | null] | null))}
          aria-label="自定义对比期"
        />
      ) : derived ? (
        <Tag bordered={false} title="对比期由所选时间范围自动推算">{`对比：${derived.from} 至 ${derived.to}`}</Tag>
      ) : null}
    </>
  )
}
