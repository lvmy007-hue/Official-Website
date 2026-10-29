import { DataState, LocalGrid, stateFromError, type LocalGridProps } from '../../components'
import { describeError } from '../../query/errors'

// 订单详情页签里的本地分页表格（P6-28 第 7 批）：读取失败、首次读取中由 DataState 统一显示，有数据后交给 LocalGrid。
// rows 为 undefined 表示还没读到；读到的空数组由骨架自己的空态说明。

export type DetailGridProps<T extends object> = Omit<LocalGridProps<T>, 'rows'> & {
  rows: readonly T[] | undefined
  loading?: boolean
  error?: unknown
  onRetry?: () => void
}

export function DetailGrid<T extends object>({ rows, loading, error, onRetry, ...rest }: DetailGridProps<T>) {
  if (error) return <DataState {...stateFromError(describeError(error), { onRetry })} />
  if (rows === undefined) return loading ? <DataState kind="skeleton" rows={4} /> : null
  return <LocalGrid<T> rows={rows} {...rest} />
}
