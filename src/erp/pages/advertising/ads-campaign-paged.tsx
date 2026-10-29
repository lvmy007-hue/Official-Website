import { useState, type Key, type ReactNode } from 'react'
import { Button, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AdsTabList } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { TabNote } from './ads-campaigns-ui'

// 活动详情里列表型页签的公共外壳：服务端游标翻页（上一页、下一页，游标由服务端签名）、数据状态说明、没有行时说明原因。
// 筛选条件变化时由调用方换 key 重新挂载，游标栈随之回到第一页。

export type PagedTabProps<T extends object, R extends AdsTabList<T>> = {
  path: string
  params?: Record<string, string | undefined>
  columns: ColumnsType<T>
  rowKey: (row: T) => Key
  /** 数据域名称，用在“没有数据”的说明里。 */
  domain: string
  scrollX?: number
  /** 表格上方的附加内容（筛选、说明）。 */
  header?: (data: R | undefined) => ReactNode
}

export function PagedTab<T extends object, R extends AdsTabList<T> = AdsTabList<T>>(props: PagedTabProps<T, R>) {
  const [pageSize, setPageSize] = useState(50)
  // 游标栈：栈顶是当前页的游标，undefined 表示第一页
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const query = useApiQuery<R>({ domain: 'analytics', path: props.path, params: { ...props.params, pageSize, cursor: stack[stack.length - 1] } })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  return (
    <div>
      {props.header?.(data)}
      {data && data.state === 'OK' ? <TabNote state={data.state} note={data.note} /> : null}
      <SimpleGrid<T>
        gridId="advertising.ads-campaign-paged"
        columns={props.columns}
        rows={data?.items}
        rowKey={props.rowKey}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: props.domain, prerequisite: data?.note ?? `所选范围内尚无${props.domain}记录。` }}
      />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
          上一页
        </Button>
        <Button size="small" disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
          下一页
        </Button>
        <Button
          size="small"
          type="text"
          onClick={() => {
            setPageSize(current => (current === 50 ? 100 : 50))
            setStack([undefined])
          }}
        >
          每页 {pageSize} 条（点击切换）
        </Button>
        {data ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            共 {data.pageInfo.approxTotal ?? data.items.length} 条{data.truncated ? '（已达读取上限）' : ''}
          </span>
        ) : null}
      </Space>
    </div>
  )
}
