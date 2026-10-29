import { useState } from 'react'
import { Alert, Card, Space } from 'antd'
import type { DaypartingListResponse } from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { ConflictsPanel } from './ads-conflicts-panel'
import { HeatmapSection } from './ads-dayparting-heatmap'
import { StrategyEditor } from './ads-dayparting-editor'
import { runColumns, strategyColumns } from './ads-dayparting-tables'
import { Section, StateNote } from './ads-ui'

// 分时策略（P3-12，08 章 8.9）：热力图找出高峰与低谷时段，策略按“星期 × 小时”设置竞价系数或启停，可以先模拟效果再启用。
// 本页保存的策略只存在本系统里，不会改变亚马逊账户；调度执行写亚马逊，随“广告写入接入”提供（页面顶部有说明）。热力图需要营销数据流，没接入时写“尚未接入”。

export default function AdsDaypartingPage() {
  const [conflicts, setConflicts] = useState<Record<string, number>>({})
  const query = useApiQuery<DaypartingListResponse>({ domain: 'analytics', path: '/ads/dayparting' })
  const data = query.data
  const refetch = () => void query.refetch()
  return (
    <div data-testid="ads-dayparting-page">
      <PageHeader
        title="分时策略"
        description="按星期与小时设置竞价系数或启停：先在热力图里找出高峰与低谷，再创建策略并模拟效果。已启用的策略每小时按所在时区的当前时段执行，写入亚马逊需要对应的写入开关。"
      />
      {data ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message="策略的执行" description={data.execution.note} data-testid="dayparting-execution-note" /> : null}
      <HeatmapSection heatmap={data?.heatmap} loading={query.isLoading} error={query.error} onRetry={refetch} />
      <Section
        title="策略列表"
        loading={query.isLoading}
        error={query.error}
        onRetry={refetch}
        testId="dayparting-strategies"
        extra={data?.canWrite ? <StrategyEditor profiles={data.profiles} onDone={refetch} /> : null}
      >
        {data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            {data.strategies.truncated ? <Alert type="warning" showIcon message="策略超过显示上限，只列出了前 100 个" /> : null}
            <SimpleGrid
              gridId="advertising.ads-dayparting-page"
              columns={strategyColumns(data.profiles, data.canWrite, refetch, conflicts)}
              rows={data.strategies.items}
              rowKey={row => row.id}
              loading={query.isFetching}
              emptyState={{ kind: 'empty', domain: '分时策略', prerequisite: data.strategies.note ?? '还没有创建分时策略。' }}
            />
          </Space>
        ) : null}
      </Section>
      <ConflictsPanel onCounts={setConflicts} />
      <Section title="执行记录" loading={query.isLoading} error={query.error} onRetry={refetch} testId="dayparting-runs">
        {data ? (
          data.runs.state === 'OK' ? (
            <SimpleGrid
              gridId="advertising.dayparting-runs"
              columns={runColumns()}
              rows={data.runs.items}
              rowKey={row => row.id}
              emptyState={{ kind: 'empty', domain: '执行记录', prerequisite: '没有执行记录。' }}
            />
          ) : (
            <StateNote state={data.runs.state} note={data.runs.note} />
          )
        ) : null}
      </Section>
      <Card size="small" title="估算口径" data-testid="dayparting-assumptions">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {(data?.assumptions ?? []).map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
