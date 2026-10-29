import { AD_TERM_SORTS, type AdTermSearchRow, type AdTermTargetRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { Muted } from '../inventory/inventory-ui'
import { EntityStateTag, moneyCell, NONE, numberCell } from './ads-campaigns-ui'
import { levelMetricColumns } from './ads-level-columns'
import { AnomalyTags, StatusTag, TermLink } from './ad-terms-ui'

// 投放、搜索词列表的列（P6-23）：和活动、广告组共用同一套指标列；词链到词级分析页。空值写“尚无记录”，不是 0。
// 排序字段与词级接口一致（AD_TERM_SORTS），词本身的排序字段叫 term。

const metricSorts = Object.fromEntries(AD_TERM_SORTS.filter(field => field !== 'term').map(field => [field, field]))
export const TARGET_SORTABLE: Readonly<Record<string, string>> = { ...metricSorts, expression: 'term' }
export const SEARCH_TERM_SORTABLE: Readonly<Record<string, string>> = { ...metricSorts, searchTerm: 'term' }
export const TERM_DEFAULT_SORT: SortSpec = { field: 'spend', direction: 'desc' }

const dash = (value: string | null | undefined) => (value ? value : <Muted>—</Muted>)
const right = { ...RIGHT_ALIGNED }

export function targetColumns(): ErpColDef<AdTermTargetRow>[] {
  return [
    renderColumn<AdTermTargetRow>('投放词', 'expression', row => <TermLink term={row.expression} />, { group: '投放', pin: 'left', width: 220 }),
    renderColumn<AdTermTargetRow>('匹配方式', 'matchType', row => dash(row.matchType), { group: '投放', width: 110, sortable: false }),
    renderColumn<AdTermTargetRow>('活动', 'campaign', row => row.campaignName ?? <span className="erp-num">{row.externalCampaignId}</span>, { group: '投放', width: 200, sortable: false }),
    renderColumn<AdTermTargetRow>('广告组', 'adGroup', row => dash(row.adGroupName ?? row.adGroupId), { group: '投放', width: 160, sortable: false }),
    renderColumn<AdTermTargetRow>('店铺', 'store', row => dash(row.storeName), { group: '投放', width: 120, sortable: false }),
    renderColumn<AdTermTargetRow>('竞价', 'bid', row => moneyCell(row.bid), { group: '投放', width: 90, sortable: false, ...right }),
    renderColumn<AdTermTargetRow>('状态', 'state', row => (row.state ? <EntityStateTag state={row.state} /> : NONE), { group: '投放', width: 100, sortable: false }),
    renderColumn<AdTermTargetRow>('异常', 'anomalies', row => <AnomalyTags anomalies={row.anomalies} />, { group: '投放', width: 200, sortable: false }),
    ...levelMetricColumns<AdTermTargetRow>(),
  ]
}

export function searchTermColumns(): ErpColDef<AdTermSearchRow>[] {
  return [
    renderColumn<AdTermSearchRow>('搜索词', 'searchTerm', row => <TermLink term={row.searchTerm} />, { group: '搜索词', pin: 'left', width: 240 }),
    renderColumn<AdTermSearchRow>('状态', 'status', row => <StatusTag status={row.status} campaigns={row.campaigns} />, { group: '搜索词', width: 100, sortable: false }),
    renderColumn<AdTermSearchRow>('异常', 'anomalies', row => <AnomalyTags anomalies={row.anomalies} />, { group: '搜索词', width: 200, sortable: false }),
    ...levelMetricColumns<AdTermSearchRow>(),
    renderColumn<AdTermSearchRow>('活动数', 'campaigns', row => numberCell(row.campaigns.total), { group: '覆盖', width: 90, sortable: false, ...right }),
    renderColumn<AdTermSearchRow>('店铺数', 'stores', row => numberCell(row.stores), { group: '覆盖', width: 90, sortable: false, ...right }),
  ]
}
