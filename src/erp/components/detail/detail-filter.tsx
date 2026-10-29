import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { SCOPE_MAX_DAYS } from '@nova/api-contracts'
import { compareRangeOf, rangePresets, todayInMarketplace, type DateRange } from '../../scope/dates'
import { DateRangeControl, type CompareMode } from '../filter/DateRangeControl'

// 整页详情的共享筛选（P6-05，15 章 5.3）：日期范围与对比方式放在吸顶导航同一行右侧，全页共用；
// 各板块通过 useDetailFilter() 取同一份值，变化后板块自己的查询键随 params 变化而重新取数。
// 值只在本页内有效（不写地址栏，不影响顶部全局范围栏）；日期按站点时区计算。

export type DetailFilterValue = {
  range: DateRange | null
  compare: CompareMode
  /** 对比区间：环比、同比由规则推出，自定义取手选值，不对比为 null。 */
  compareRange: DateRange | null
  /** 直接拼进请求的参数（与全局范围栏同名：from、to、compare、compareFrom、compareTo）；没有选日期时为空对象。 */
  params: Record<string, string>
  /** 值的指纹，用作查询键或 resetKey。 */
  signature: string
}

export type DetailFilterInit = { range?: DateRange | null; compare?: CompareMode; compareRange?: DateRange | null }

/** 纯函数：由选择结果算出对外的值。 */
export function buildDetailFilter(range: DateRange | null, compare: CompareMode, custom: DateRange | null): DetailFilterValue {
  const compareRange = range ? compareRangeOf(range, compare, custom) : null
  const params: Record<string, string> = {}
  if (range) {
    params.from = range.from
    params.to = range.to
    if (compareRange && compare !== 'none') {
      params.compare = compare
      params.compareFrom = compareRange.from
      params.compareTo = compareRange.to
    }
  }
  return { range, compare, compareRange, params, signature: JSON.stringify(params) }
}

/** 没有放进整页详情时的取值：没有日期、不对比。 */
const NONE: DetailFilterValue = buildDetailFilter(null, 'none', null)

const DetailFilterContext = createContext<DetailFilterValue>(NONE)

/** 各板块取共享筛选。不在带共享筛选的整页详情里使用时，返回“没有日期”的空值。 */
export const useDetailFilter = () => useContext(DetailFilterContext)

export type DetailFilterState = { value: DetailFilterValue; control: ReactNode }

/** 状态与控件一起给出：状态给 Provider，控件放进吸顶导航。 */
export function useDetailFilterState(enabled: boolean, init?: DetailFilterInit): DetailFilterState {
  const today = useMemo(() => todayInMarketplace(), [])
  const [range, setRange] = useState<DateRange | null>(init?.range !== undefined ? init.range : (rangePresets(today).find(item => item.key === 'last30')?.range ?? null))
  const [compare, setCompare] = useState<CompareMode>(init?.compare ?? 'none')
  const [custom, setCustom] = useState<DateRange | null>(init?.compareRange ?? null)
  const value = useMemo(() => (enabled ? buildDetailFilter(range, compare, custom) : NONE), [enabled, range, compare, custom])
  const control = enabled ? (
    <div className="erp-detail-filter" role="group" aria-label="共享筛选">
      <DateRangeControl
        today={today}
        range={range}
        compare={compare}
        compareRange={custom}
        maxDays={SCOPE_MAX_DAYS}
        onRangeChange={setRange}
        onCompareChange={setCompare}
        onCompareRangeChange={setCustom}
      />
    </div>
  ) : null
  return { value, control }
}

export function DetailFilterProvider({ value, children }: { value: DetailFilterValue; children: ReactNode }) {
  return <DetailFilterContext.Provider value={value}>{children}</DetailFilterContext.Provider>
}
