import { useRef } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { Alert, Card, Tabs } from 'antd'
import type { AccountHealthResponse } from '@nova/api-contracts'
import { DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { AccountHealthStoreBlock } from './AccountHealthStoreBlock'
import { PolicyIssueDrawer } from './PolicyIssueDrawer'
import { PolicyIssuesPanel } from './PolicyIssuesPanel'

// 账户健康（P5-02，09 章 9.2）：每个店铺的账户状态与变更历史、账户健康评级、订单缺陷率与构成、政策合规指标与问题、其他指标。
// 数据来自亚马逊卖家表现报告（每日同步一次，每天留存一份快照）；账户状态变更推送尚未接入，状态最长会晚一天出现。
// 达标与否只按报告自带的目标判定；没有数据的指标写“尚无记录”，不补 0。地址栏的 ?issue=<编号> 直接打开问题详情（预警与待办的链接用它）。

export default function AccountHealthPage() {
  const search = useSearch({ strict: false }) as { tab?: string; issue?: string }
  const router = useRouter()
  const tab = search.tab === 'issues' || search.issue ? 'issues' : 'overview'
  const go = (next: { tab?: string; issue?: string }) => void router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, tab: next.tab, issue: next.issue })) as never })

  const query = useApiQuery<AccountHealthResponse>({ domain: 'list', path: '/account-health' })
  // 换范围重新读取期间沿用上一次的结果，避免整页闪烁
  const last = useRef<AccountHealthResponse>()
  if (query.data) last.current = query.data
  const data = query.data ?? last.current

  const overview = (() => {
    if (query.error && !data) return <DataState {...stateFromError(describeError(query.error), { permission: 'account.health.read', onRetry: () => void query.refetch() })} />
    if (!data) return <DataState kind="skeleton" rows={6} />
    if (data.stores.length === 0) return <DataState kind="empty" domain="账户健康" prerequisite="还没有可见的亚马逊店铺；接入店铺并完成首次同步后，这里显示账户状态与各项指标。" />
    return (
      <div data-testid="account-health-overview">
        {data.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="数据很多，只显示了最近的一部分" /> : null}
        {data.stores.map(view => (
          <AccountHealthStoreBlock key={view.sellerAccountId} view={view} onOpenIssues={() => go({ tab: 'issues' })} />
        ))}
        <Muted>{data.basis}</Muted>
      </div>
    )
  })()

  return (
    <div data-testid="account-health-page">
      <PageHeader
        title="账户健康"
        description="账户状态、账户健康评级、订单缺陷率、政策合规问题。数据来自亚马逊卖家表现报告，每日同步一次；达标与否只按报告自带的目标判定，报告没有给的指标显示“尚无记录”。"
      />
      <FreshnessBar freshness={data?.freshness} />
      {data?.push.state === 'NOT_CONNECTED' && data.push.note ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message={data.push.note} data-testid="push-not-connected" /> : null}
      <Card size="small" style={{ marginTop: 8 }}>
        <Tabs
          activeKey={tab}
          onChange={key => go({ tab: key === 'issues' ? 'issues' : undefined })}
          items={[
            { key: 'overview', label: '账户概览', children: overview },
            {
              key: 'issues',
              label: `政策合规问题${data ? `（未解决 ${data.stores.reduce((sum, view) => sum + view.policy.openCount, 0)}）` : ''}`,
              children: <PolicyIssuesPanel onOpen={id => go({ tab: 'issues', issue: id })} />,
            },
          ]}
        />
      </Card>
      <PolicyIssueDrawer id={search.issue ?? null} onClose={() => go({ tab: 'issues' })} />
    </div>
  )
}
