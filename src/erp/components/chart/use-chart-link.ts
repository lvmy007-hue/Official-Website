import { useCallback, useMemo, useState } from 'react'

// 图表与同页表格联动的状态（P6-06）：
// - 图上点某个日期或系列 → filter：同页表格只显示它（再点一次取消）；
// - 表格里点某一行 → focus：图上高亮对应的日期或系列（再点一次取消）。
// 图的高亮取 focus，没有就取 filter（点选的日期在图上也保持高亮）。

export type LinkTarget = { category?: string | null; series?: string | null }

const same = (a: LinkTarget | null, b: LinkTarget) => a !== null && (a.category ?? null) === (b.category ?? null) && (a.series ?? null) === (b.series ?? null)

export function useChartLink() {
  const [filter, setFilter] = useState<LinkTarget | null>(null)
  const [focus, setFocus] = useState<LinkTarget | null>(null)

  const onChartClick = useCallback((category: string, series?: string) => {
    const target: LinkTarget = { category, series: series ?? null }
    setFilter(prev => (same(prev, target) ? null : target))
    setFocus(null)
  }, [])
  const onRowFocus = useCallback((target: LinkTarget) => setFocus(prev => (same(prev, target) ? null : target)), [])
  const clear = useCallback(() => {
    setFilter(null)
    setFocus(null)
  }, [])

  return useMemo(
    () => ({
      filterCategory: filter?.category ?? null,
      filterSeries: filter?.series ?? null,
      focusCategory: focus?.category ?? null,
      focusSeries: focus?.series ?? null,
      onChartClick,
      onRowFocus,
      clear,
      /** 直接展开给 ChartPanel。 */
      chartProps: {
        activeCategory: focus?.category ?? filter?.category ?? null,
        highlightSeries: focus?.series ?? filter?.series ?? null,
        onCategoryClick: onChartClick,
      },
    }),
    [filter, focus, onChartClick, onRowFocus, clear],
  )
}
