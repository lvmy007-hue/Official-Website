import { useState, type ReactNode } from 'react'
import { Alert, Button, Space } from 'antd'
import type { CursorPageInfo } from '@nova/api-contracts'
import { DataState, FreshnessBar, stateFromError } from '../../components'
import { formatMoney } from '../../format'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'

// 官方经济数据对账各页签共用：金额显示、游标分页、页签外框（新鲜度、错误、空状态说明）。
// 没有数据写“尚无记录”，官方没提供写“官方未提供”，没有数据来源写“尚未接入”，绝不写 0。

export const PAGE_SIZE = 20

export const signedMoney = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? (
    <Muted>尚无记录</Muted>
  ) : (
    <span className="erp-num" style={value < 0 ? { color: '#cf1322' } : undefined}>
      {formatMoney(value, 'USD', { digits: 2, sign: true })}
    </span>
  )

export const plainMoney = (value: number | null | undefined, missing: ReactNode = <Muted>尚无记录</Muted>): ReactNode =>
  value === null || value === undefined ? missing : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>

/** 游标栈：栈顶是当前页的游标，undefined 表示第一页；条件变化时回到第一页。 */
export function useCursorStack() {
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  return { stack, setStack, cursor: stack[stack.length - 1], reset: () => setStack([undefined]) }
}

export function Pager({
  stack,
  setStack,
  pageInfo,
  fetching,
}: {
  stack: Array<string | undefined>
  setStack: (next: (current: Array<string | undefined>) => Array<string | undefined>) => void
  pageInfo?: CursorPageInfo
  fetching: boolean
}) {
  const next = pageInfo?.hasMore ? pageInfo.nextCursor : null
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={stack.length <= 1 || fetching} onClick={() => setStack(current => current.slice(0, -1))}>
        上一页
      </Button>
      <Button disabled={!next || fetching} onClick={() => next && setStack(current => [...current, next])}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>
        第 {stack.length} 页{pageInfo?.approxTotal === null || pageInfo?.approxTotal === undefined ? '' : `，共约 ${pageInfo.approxTotal} 条`}
      </span>
    </Space>
  )
}

type Framed = { state: 'OK' | 'NO_DATA'; note: string | null; notes: string[]; freshness: Parameters<typeof FreshnessBar>[0]['freshness'] }
type QueryLike<T> = { data?: T; error: unknown; refetch: () => unknown }

export function TabFrame<T extends Framed>({ query, testId, children }: { query: QueryLike<T>; testId: string; children: (data: T) => ReactNode }) {
  const data = query.data
  return (
    <div data-testid={testId}>
      <FreshnessBar freshness={data?.freshness} />
      {query.error ? (
        <DataState {...stateFromError(describeError(query.error), { permission: 'finance.read', onRetry: () => void query.refetch() })} />
      ) : !data ? (
        <DataState kind="skeleton" rows={5} />
      ) : (
        <>
          {data.note ? <Alert type={data.state === 'NO_DATA' ? 'info' : 'warning'} showIcon style={{ margin: '8px 0' }} message={data.note} data-testid="economics-note" /> : null}
          {children(data)}
          <ul style={{ margin: '12px 0 0', paddingLeft: 18, color: 'rgba(0,0,0,0.55)', fontSize: 12 }} data-testid="economics-notes">
            {data.notes.map(text => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
