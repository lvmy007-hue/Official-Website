import { useCallback, useMemo } from 'react'
import { PagedGrid, type PagedGridProps } from './PagedGrid'
import type { PageFetcher } from './grid-types'

// 本地分页表格（P6-28）：整份数据页面已经读到（例如接口一次返回的逐日、逐子体明细，或抽屉里的对比行），
// 不再另取数，只在本地按页切片；列、工具栏、主题、分页与 PagedGrid 完全一致，页面不用再写自己的表格。
// 数据引用变了（重新读取）会自动回到第 1 页并重取；不支持服务端排序，列头不开排序。

export type LocalGridProps<T extends object> = Omit<PagedGridProps<T>, 'fetchPage' | 'sortableFields' | 'defaultSort' | 'resetKey' | 'fetchSummary'> & {
  rows: readonly T[]
  /** 行以外影响表格的条件（筛选、着色指标等）变化时也要重取，写进这里。 */
  resetKey?: string
}

let versionSeed = 0
const nextVersion = () => {
  versionSeed += 1
  return versionSeed
}

export function LocalGrid<T extends object>({ rows, resetKey = '', ...rest }: LocalGridProps<T>) {
  const version = useMemo(() => {
    void rows
    return nextVersion()
  }, [rows])
  const fetchPage = useCallback<PageFetcher<T>>(async ({ page, pageSize }) => ({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }), [rows])
  return <PagedGrid<T> {...rest} fetchPage={fetchPage} resetKey={`${resetKey}#${version}`} />
}
