import { useCallback, useMemo, useState } from 'react'
import { Alert } from 'antd'
import { ADS_ANOMALY_LABEL, ADS_PRODUCT_LABEL, type AdsCampaignListResponse, type AdsCampaignRow } from '@nova/api-contracts'
import type { FilterField, SearchMode } from '../../components'
import { CAMPAIGN_DEFAULT_SORT, CAMPAIGN_SORTABLE, campaignColumns } from './ads-campaigns-columns'
import { MetaAction } from './ads-campaigns-meta-action'
import { CampaignWrites } from './ads-campaigns-write'
import { AdsLevelGrid } from './ads-level-grid'

// 广告活动列表（P3-07，08 章 8.3；P6-04 迁到 MassiveGrid；P6-23 迁到广告层级统一骨架 AdsLevelGrid）：活动来自活动管理接口，指标来自广告日汇总（美元）；
// 筛选、区间、分类计数、排序、汇总都在服务端。暂停、启用、改预算、改竞价策略写亚马逊（P3-17）：勾选活动后在批量操作栏里先预览再提交，写入开关关着时按钮置灰并写明原因。

const STATES = [
  { value: 'ENABLED', label: '启用中' },
  { value: 'PAUSED', label: '已暂停' },
  { value: 'ARCHIVED', label: '已归档' },
]
const MODES: SearchMode[] = [
  { id: 'contains', label: '名称包含', key: 'q', placeholder: '搜索活动名称' },
  { id: 'excludes', label: '名称不包含', key: 'q', with: { qMode: 'excludes' }, placeholder: '排除名称里含有的词' },
]

function fieldsOf(response: AdsCampaignListResponse | null): FilterField[] {
  const options = response?.filterOptions
  return [
    { key: 'adProduct', label: '广告产品', kind: 'select', options: Object.entries(ADS_PRODUCT_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'state', label: '状态', kind: 'select', width: 112, options: STATES },
    { key: 'portfolioId', label: '广告组合', kind: 'select', width: 160, strict: false, hidden: true, options: (options?.portfolios ?? []).map(item => ({ value: item.id, label: item.name })) },
    { key: 'anomaly', label: '异常', kind: 'select', width: 160, options: Object.entries(ADS_ANOMALY_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'tag', label: '标签', kind: 'select', placement: 'more', strict: false, options: (options?.tags ?? []).map(tag => ({ value: tag, label: tag })) },
    { key: 'ownerId', label: '负责人', kind: 'select', placement: 'more', strict: false, options: (options?.owners ?? []).map(item => ({ value: item.id, label: item.name })) },
  ]
}

export default function AdsCampaignsPage() {
  const [overBudgetNote, setOverBudgetNote] = useState('')
  const [members, setMembers] = useState<AdsCampaignListResponse['members']>([])
  const columns = useMemo(() => campaignColumns(overBudgetNote), [overBudgetNote])
  const onFirstPage = useCallback((response: AdsCampaignListResponse) => {
    setOverBudgetNote(response.avgOverBudget.note)
    setMembers(response.members)
  }, [])

  return (
    <AdsLevelGrid<AdsCampaignRow, AdsCampaignListResponse>
      level="campaigns"
      testId="ads-campaigns-page"
      title="广告活动"
      description="所有广告活动的状态、预算与表现；点名称进入详情，末列图标看趋势。指标是所选日期范围内的合计（美元活动）；勾选活动后可暂停、启用、调整预算与竞价策略（先预览再提交，由后台写入亚马逊）。"
      gridId="ads.campaigns"
      path="/ads/campaigns"
      fieldsOf={fieldsOf}
      modes={MODES}
      columns={columns}
      sortableFields={CAMPAIGN_SORTABLE}
      defaultSort={CAMPAIGN_DEFAULT_SORT}
      getRowId={row => row.id}
      summaryOf={response => response.summary}
      emptyDomain="广告活动"
      emptyNote="还没有同步到广告活动；连接广告账户并同步活动后显示。"
      trendPathOf={row => `/ads/campaigns/${encodeURIComponent(row.id)}/trend`}
      onFirstPage={onFirstPage}
      notes={response => (response?.metricsTruncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="指标聚合超过读取上限，花费较低的活动可能没有指标" /> : null)}
      renderBulkActions={(rows, done) => (
        <>
          <MetaAction targets={rows} members={members} onDone={done} />
          <CampaignWrites ids={rows.map(row => row.id)} onDone={done} />
        </>
      )}
    />
  )
}
