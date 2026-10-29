import { Space, Tag, Tooltip } from 'antd'
import { ADS_ANOMALY_LABEL, ADS_CAMPAIGN_SORTS, ADS_TARGETING_LABEL, type AdsCampaignRow } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { SUMMARY_FORMAT } from './ads-level-columns'
import { EntityStateTag, moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'

// 广告活动列表的列（08 章 8.3；P6-04 迁到 MassiveGrid 骨架）：名称链到详情；指标是所选范围内的合计，没有汇总行的活动显示“尚无记录”，不是 0。

const money = (row: AdsCampaignRow, value: number | null | undefined) => moneyCell(value, row.currency)

/** 白名单：列标识 → 服务端排序字段（列标识与服务端字段同名）。 */
export const CAMPAIGN_SORTABLE = Object.fromEntries(ADS_CAMPAIGN_SORTS.map(field => [field, field])) as Readonly<Record<(typeof ADS_CAMPAIGN_SORTS)[number], string>>
export const CAMPAIGN_DEFAULT_SORT: SortSpec = { field: 'spend', direction: 'desc' }

const right = { ...RIGHT_ALIGNED }

export function campaignColumns(avgOverBudgetNote: string): ErpColDef<AdsCampaignRow>[] {
  return [
    renderColumn<AdsCampaignRow>(
      '活动',
      'name',
      row => (
        <div>
          <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(row.id)}`}>{row.name}</AppLink>
          {row.anomaly ? (
            <Tag color="warning" bordered={false} style={{ marginLeft: 6 }}>
              {ADS_ANOMALY_LABEL[row.anomaly]}
            </Tag>
          ) : null}
          <div className="erp-num">
            {row.accountName ?? '—'}
            {row.storeName ? ` · ${row.storeName}` : ' · 未绑定店铺'}
          </div>
        </div>
      ),
      { group: '活动', pin: 'left', width: 300 },
    ),
    renderColumn<AdsCampaignRow>('状态', 'state', row => <EntityStateTag state={row.state} />, { group: '活动', width: 100 }),
    renderColumn<AdsCampaignRow>('广告产品', 'adProduct', row => row.productLabel, { group: '活动', width: 110 }),
    renderColumn<AdsCampaignRow>('投放方式', 'targeting', row => (row.targetingType ? ADS_TARGETING_LABEL[row.targetingType] : <Muted>未同步</Muted>), { group: '活动', width: 100 }),
    renderColumn<AdsCampaignRow>('广告组合', 'portfolio', row => row.portfolioName ?? row.portfolioId ?? <Muted>无</Muted>, { group: '活动', width: 130 }),
    renderColumn<AdsCampaignRow>(
      '预算',
      'budget',
      row =>
        row.budget === null ? (
          NONE
        ) : (
          <span>
            {money(row, row.budget)}
            <Muted>{row.budgetType === 'DAILY' ? ' /日' : row.budgetType ? ` /${row.budgetType}` : ''}</Muted>
          </span>
        ),
      { group: '预算', width: 130, ...right },
    ),
    renderColumn<AdsCampaignRow>('预算利用率', 'budgetUtilization', row => percentCell(row.budgetUtilization), { group: '预算', width: 110, ...right }),
    renderColumn<AdsCampaignRow>(
      '平均超预算时长',
      'overBudget',
      () => (
        <Tooltip title={avgOverBudgetNote}>
          <span>
            <Muted>尚未接入</Muted>
          </span>
        </Tooltip>
      ),
      { group: '预算', width: 130 },
    ),
    renderColumn<AdsCampaignRow>('花费', 'spend', row => money(row, row.totals?.spend), { group: '表现', width: 110, metric: 'M-007', ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<AdsCampaignRow>('广告销售额', 'sales', row => money(row, row.totals?.sales), { group: '表现', width: 120, ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<AdsCampaignRow>('订单', 'orders', row => numberCell(row.totals?.orders), { group: '表现', width: 90, ...SUMMARY_FORMAT.number, ...right }),
    renderColumn<AdsCampaignRow>('广告成本销售比', 'acos', row => percentCell(row.ratios?.acos), { group: '表现', width: 130, metric: 'M-501', ...SUMMARY_FORMAT.percent(), ...right }),
    renderColumn<AdsCampaignRow>('广告回报率', 'roas', row => (row.ratios?.roas == null ? NONE : <span className="erp-num">{row.ratios.roas.toFixed(2)}</span>), {
      group: '表现',
      width: 110,
      metric: 'M-502',
      ...SUMMARY_FORMAT.ratio,
      ...right,
    }),
    renderColumn<AdsCampaignRow>('点击率', 'ctr', row => percentCell(row.ratios?.ctr, 2), { group: '表现', width: 90, ...SUMMARY_FORMAT.percent(2), ...right }),
    renderColumn<AdsCampaignRow>('单次点击成本', 'cpc', row => money(row, row.ratios?.cpc), { group: '表现', width: 120, ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<AdsCampaignRow>('转化率', 'cvr', row => percentCell(row.ratios?.cvr, 2), { group: '表现', width: 90, ...SUMMARY_FORMAT.percent(2), ...right }),
    renderColumn<AdsCampaignRow>('广告销售占比', 'adsShare', row => percentCell(row.adsShare), { group: '表现', width: 120, ...right }),
    renderColumn<AdsCampaignRow>(
      '标签',
      'tags',
      row =>
        row.tags.length ? (
          <Space size={[2, 2]}>
            {row.tags.map(tag => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            ))}
          </Space>
        ) : (
          <Muted>无</Muted>
        ),
      { group: '管理', width: 180 },
    ),
    renderColumn<AdsCampaignRow>('负责人', 'owner', row => (row.ownerId ? (row.ownerName ?? '已离开的成员') : <Muted>未指定</Muted>), { group: '管理', width: 120 }),
    renderColumn<AdsCampaignRow>('最近同步', 'syncedAt', row => formatDateTime(row.syncedAt), { group: '管理', width: 170 }),
  ]
}
