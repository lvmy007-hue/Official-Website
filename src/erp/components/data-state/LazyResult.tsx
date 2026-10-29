import { Suspense, lazy } from 'react'
import type { ResultProps } from 'antd'

const ResultView = lazy(() => import('./ResultView'))

/** 按需加载的结果视图；加载期间显示占位，不闪烁空白。 */
export function LazyResult(props: ResultProps) {
  return (
    <Suspense fallback={<div aria-busy="true" aria-label="正在加载" style={{ minHeight: 240 }} />}>
      <ResultView {...props} />
    </Suspense>
  )
}
