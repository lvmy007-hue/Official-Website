import { useState } from 'react'
import { Alert, Space } from 'antd'
import type { AdsRuleListResponse } from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { ConflictsPanel } from './ads-conflicts-panel'
import { RuleEditor } from './ads-rules-editor'
import { ruleColumns } from './ads-rules-tables'
import { Section } from './ads-ui'

// 自动规则（P3-13，08 章 8.10）：按条件（指标、窗口、阈值）筛出广告对象，建议模式命中后生成待办，自动执行模式（P3-17）命中活动或投放词时提交写入。
// 每条规则有护栏（最低最高值、单次幅度上限、每日处理上限）、试运行、运行记录与质量统计；规则本身保存在本系统里。

export default function AdsRulesPage() {
  const [conflicts, setConflicts] = useState<Record<string, number>>({})
  const query = useApiQuery<AdsRuleListResponse>({ domain: 'analytics', path: '/ads/rules' })
  const data = query.data
  const refetch = () => void query.refetch()
  return (
    <div data-testid="ads-rules-page">
      <PageHeader
        title="自动规则"
        description="按条件筛出广告对象并建议动作：建议模式命中后生成待办，由人处理；保存前可以先试运行看会命中谁。自动执行模式的规则命中活动或投放词时会写入亚马逊（需要写入开关），建议模式只生成待办。"
      />
      {data ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message="自动执行" description={data.execution.note} data-testid="rules-execution-note" /> : null}
      <Section
        title="规则列表"
        loading={query.isLoading}
        error={query.error}
        onRetry={refetch}
        testId="rules-list"
        extra={data?.canWrite ? <RuleEditor profiles={data.profiles} auto={data.auto} onDone={refetch} /> : null}
      >
        {data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            {data.rules.truncated ? <Alert type="warning" showIcon message="规则超过显示上限，只列出了前面一部分" /> : null}
            <SimpleGrid
              gridId="advertising.ads-rules-page"
              columns={ruleColumns(data.profiles, data.auto, data.canWrite, refetch, conflicts)}
              rows={data.rules.items}
              rowKey={row => row.id}
              loading={query.isFetching}
              emptyState={{ kind: 'empty', domain: '自动规则', prerequisite: data.rules.note ?? '还没有创建自动规则。' }}
            />
          </Space>
        ) : null}
      </Section>
      <ConflictsPanel onCounts={setConflicts} />
    </div>
  )
}
