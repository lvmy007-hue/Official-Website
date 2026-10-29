import { Tooltip, Button } from 'antd'
import type { AdsAdGroupListResponse, AdsAdGroupListRow } from '@nova/api-contracts'
import type { FilterField, SearchMode } from '../../components'
import { AdsLevelGrid } from './ads-level-grid'
import { AD_GROUP_DEFAULT_SORT, AD_GROUP_SORTABLE, adGroupColumns } from './ads-groups-list-columns'

// 广告组列表（P6-23，16 章第 8 节）：广告层级统一骨架的第二个层级。指标来自广告指标表（美元，范围内合计）；筛选、区间、分类计数、排序、汇总都在服务端。
// 广告组的写入接口按单个广告组（暂停、启用、默认竞价），没有批量接口：勾选后的批量栏写明原因，逐个到详情页修改（先预览再提交）。

const MODES: SearchMode[] = [{ id: 'contains', label: '名称包含', key: 'q', placeholder: '搜索广告组名称' }]
const STATES = [
  { value: 'ENABLED', label: '启用中' },
  { value: 'PAUSED', label: '已暂停' },
  { value: 'ARCHIVED', label: '已归档' },
]

function fieldsOf(response: AdsAdGroupListResponse | null): FilterField[] {
  return [
    { key: 'state', label: '状态', kind: 'select', width: 112, options: STATES },
    {
      key: 'portfolioId',
      label: '广告组合',
      kind: 'select',
      width: 160,
      strict: false,
      hidden: true,
      options: (response?.filterOptions.portfolios ?? []).map(item => ({ value: item.id, label: item.name })),
    },
    { key: 'campaignId', label: '所属活动', kind: 'text', hidden: true },
  ]
}

const columns = adGroupColumns()

export default function AdsAdGroupsPage() {
  return (
    <AdsLevelGrid<AdsAdGroupListRow, AdsAdGroupListResponse>
      level="ad-groups"
      testId="ads-ad-groups-page"
      title="广告组"
      description="所有广告组的状态与表现；点名称进入详情，末列图标看趋势。指标是所选日期范围内的合计（美元）；没有指标行的广告组显示“尚无记录”。"
      gridId="ads.ad-groups"
      path="/ads/ad-groups"
      fieldsOf={fieldsOf}
      modes={MODES}
      columns={columns}
      sortableFields={AD_GROUP_SORTABLE}
      defaultSort={AD_GROUP_DEFAULT_SORT}
      getRowId={row => row.id}
      summaryOf={response => response.summary}
      emptyDomain="广告组"
      emptyNote="还没有同步到广告组；连接广告账户并同步广告结构后显示。"
      trendPathOf={row => `/ads/ad-groups/${encodeURIComponent(row.id)}/trend`}
      renderBulkActions={rows => (
        <Tooltip title="广告组的写入接口按单个广告组提交（暂停、启用、默认竞价），暂无批量接口；请进入广告组详情修改，提交前会先预览。">
          <span>
            <Button size="small" disabled>
              批量修改（{rows.length} 个）暂不可用
            </Button>
          </span>
        </Tooltip>
      )}
    />
  )
}
