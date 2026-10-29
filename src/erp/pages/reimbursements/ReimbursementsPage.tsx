import { Card, Collapse, Tabs } from 'antd'
import { REIMBURSEMENT_TABS, REIMBURSEMENT_TAB_LABEL, type ReimbursementStatsResponse, type ReimbursementTab } from '@nova/api-contracts'
import { DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { CasesTab } from './CasesTab'
import { OpportunitiesTab } from './OpportunitiesTab'
import { StatsPanel } from './StatsPanel'
import { WindowsSettings } from './WindowsSettings'

// 赔付中心（P2b-03，07 章 7.3）：亚马逊该赔没赔的钱。赔付机会（7 类规则识别）→ 生成案件 → 在卖家后台提交并回填案件编号 → 官方赔付明细到账后自动匹配。
// 亚马逊的卖家支持接口不能创建案件，所以“提交”在卖家后台完成；实收只来自官方赔付明细，页面上没有手填实收的入口。

function Summary() {
  const stats = useApiQuery<ReimbursementStatsResponse>({ domain: 'analytics', path: '/reimbursements/stats' })
  if (stats.error) return <DataState {...stateFromError(describeError(stats.error), { permission: 'reimbursements.read', onRetry: () => void stats.refetch() })} />
  if (stats.isPending || !stats.data) return <DataState kind="skeleton" rows={3} />
  const data = stats.data
  return (
    <Collapse
      size="small"
      style={{ marginBottom: 12 }}
      items={[
        {
          key: 'stats',
          label: '回收率与成功率',
          children: (
            <>
              <FreshnessBar freshness={data.freshness} />
              <StatsPanel stats={data} />
            </>
          ),
        },
        { key: 'windows', label: '机会时限设置', children: <WindowsSettings stats={data} /> },
      ]}
    />
  )
}

export default function ReimbursementsPage() {
  return (
    <div>
      <PageHeader title="赔付中心" description="亚马逊该赔没赔的钱：按规则识别赔付机会，生成案件跟踪，提交后回填亚马逊案件编号；官方赔付明细到账后自动匹配，统计回收率。" />
      <Summary />
      <Card size="small">
        <Tabs
          items={REIMBURSEMENT_TABS.map(tab => ({
            key: tab,
            label: REIMBURSEMENT_TAB_LABEL[tab],
            children: tab === 'opportunities' ? <OpportunitiesTab /> : <CasesTab tab={tab as Exclude<ReimbursementTab, 'opportunities'>} />,
          }))}
        />
      </Card>
    </div>
  )
}
