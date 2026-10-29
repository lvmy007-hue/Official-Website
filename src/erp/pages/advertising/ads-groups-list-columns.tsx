import { ADS_AD_GROUP_SORTS, type AdsAdGroupListRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { EntityStateTag, moneyCell } from './ads-campaigns-ui'
import { levelMetricColumns } from './ads-level-columns'

// 广告组列表的列（P6-23）：名称链到广告组详情；上级活动链到活动详情；指标来自指标表（美元），没有指标行显示“尚无记录”，不是 0。

export const AD_GROUP_SORTABLE = Object.fromEntries(ADS_AD_GROUP_SORTS.map(field => [field, field])) as Readonly<Record<(typeof ADS_AD_GROUP_SORTS)[number], string>>
export const AD_GROUP_DEFAULT_SORT: SortSpec = { field: 'spend', direction: 'desc' }

export function adGroupColumns(): ErpColDef<AdsAdGroupListRow>[] {
  return [
    renderColumn<AdsAdGroupListRow>(
      '广告组',
      'name',
      row => (
        <div>
          <AppLink to={`/app/advertising/ad-groups/${encodeURIComponent(row.id)}`}>{row.name}</AppLink>
          <div className="erp-num">
            {row.accountName ?? '—'}
            {row.storeName ? ` · ${row.storeName}` : ' · 未绑定店铺'}
          </div>
        </div>
      ),
      { group: '广告组', pin: 'left', width: 280 },
    ),
    renderColumn<AdsAdGroupListRow>('状态', 'state', row => <EntityStateTag state={row.state} />, { group: '广告组', width: 100 }),
    renderColumn<AdsAdGroupListRow>(
      '所属活动',
      'campaign',
      row => (row.campaignId ? <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(row.campaignId)}`}>{row.campaignName ?? row.externalCampaignId}</AppLink> : <Muted>活动尚未同步</Muted>),
      {
        group: '广告组',
        width: 200,
      },
    ),
    renderColumn<AdsAdGroupListRow>('默认竞价', 'defaultBid', row => moneyCell(row.defaultBid, row.currency), { group: '广告组', width: 110, ...RIGHT_ALIGNED }),
    ...levelMetricColumns<AdsAdGroupListRow>(),
  ]
}
