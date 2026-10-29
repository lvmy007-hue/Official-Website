import { useEffect, useState } from 'react'
import { Popover } from 'antd'
import type { IHeaderParams } from 'ag-grid-community'

// 带“从哪个表取哪个字段”问号的列头（P6-25）：与指标字典问号（MetricHeader）同样的外观；
// 这里的口径是“数据来源”，由页面（来自契约里的列登记表）直接给文字，不走指标字典。

export function SourceHeader(params: IHeaderParams & { source: string }) {
  const { column } = params
  const [sort, setSort] = useState(column.getSort())
  useEffect(() => {
    const sync = () => setSort(column.getSort())
    column.addEventListener('sortChanged', sync)
    return () => column.removeEventListener('sortChanged', sync)
  }, [column])
  return (
    <div className="erp-metric-header">
      {params.enableSorting ? (
        <button type="button" className="erp-metric-header-name" onClick={event => params.progressSort(event.shiftKey)}>
          {params.displayName}
          {sort === 'asc' ? ' ↑' : sort === 'desc' ? ' ↓' : ''}
        </button>
      ) : (
        <span className="erp-metric-header-name">{params.displayName}</span>
      )}
      <Popover trigger="click" placement="bottom" title={`${params.displayName}的数据来源`} content={<div data-testid="source-help">{params.source}</div>}>
        <button type="button" className="erp-metric-help-trigger" aria-label={`${params.displayName}的数据来源`} onClick={event => event.stopPropagation()}>
          ?
        </button>
      </Popover>
    </div>
  )
}

/** 列定义里挂问号用：返回要合并进列定义的两个键。 */
export const withSource = (source: string) => ({ headerComponent: SourceHeader, headerComponentParams: { source } })
