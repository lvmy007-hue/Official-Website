import { useState } from 'react'
import { Button, Space } from 'antd'
import type { AdsRuleRunsResponse } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { StateNote } from './ads-ui'
import { runColumns } from './ads-rules-tables'

// 规则的运行记录（P3-13）：定时评估每命中一个对象记一条（已生成待办 / 已跳过 / 已执行 / 失败），按时间倒序，游标翻页。
// 游标由服务端签名，这里只保存走过的游标栈用来“上一页”。

const PAGE_SIZE = 20

export function RunsPanel({ ruleId }: { ruleId: string }) {
  const [stack, setStack] = useState<string[]>([])
  const cursor = stack[stack.length - 1]
  const query = useApiQuery<AdsRuleRunsResponse>({
    domain: 'analytics',
    path: `/ads/rules/${encodeURIComponent(ruleId)}/runs`,
    params: { pageSize: PAGE_SIZE, cursor },
    scoped: false,
  })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (!query.data) return <DataState kind="skeleton" rows={4} />
  const data = query.data
  if (data.state !== 'OK') return <StateNote state={data.state} note={data.note} />
  return (
    <div data-testid="rule-runs">
      <SimpleGrid
        gridId="advertising.ads-rules-runs"
        columns={runColumns()}
        rows={data.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        emptyState={{ kind: 'empty', domain: '运行记录', prerequisite: '这条规则还没有运行记录；启用后定时评估命中对象才会有记录。' }}
      />
      <Space style={{ marginTop: 8 }}>
        <Button disabled={stack.length === 0} onClick={() => setStack(stack.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!data.pageInfo.hasMore || !data.pageInfo.nextCursor} onClick={() => data.pageInfo.nextCursor && setStack([...stack, data.pageInfo.nextCursor])}>
          下一页
        </Button>
        {data.pageInfo.approxTotal !== null ? <span>共约 {data.pageInfo.approxTotal} 条</span> : null}
      </Space>
    </div>
  )
}
