import { Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ADS_TARGET_KIND_LABEL,
  ADS_TERM_STATUS_LABEL,
  isWastedTarget,
  type AdsSearchTermRow,
  type AdsTargetRow,
  type AdsTermStatus,
  type Asin360AdsAdGroupRow,
  type Asin360AdsCampaignRow,
} from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { EntityStateTag, metricColumns, moneyCell, numberCell } from '../advertising/ads-campaigns-ui'

// ASIN 360 广告页签里四张表的列定义：活动（这个 ASIN 自己的数字）、广告组、投放对象、搜索词（后三者是对象自己的合计，表头旁写明）。
// 活动记录还没同步下来的行没有系统编号，只显示外部编号，不给链接。

const CURRENCY = 'USD'
const SHARED_HINT = '这是该对象自己的合计，亚马逊没有按 ASIN 拆开；对象里还推广别的商品时，数字包含它们'

export const campaignColumns: ColumnsType<Asin360AdsCampaignRow> = [
  {
    title: '广告活动',
    key: 'name',
    render: (_value, row) => (
      <div>
        {row.id && row.name ? <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(row.id)}`}>{row.name}</AppLink> : <Muted>{row.name ?? '活动记录尚未同步'}</Muted>}
        <div className="erp-num">{row.externalCampaignId}</div>
      </div>
    ),
  },
  { title: '类型', dataIndex: 'productLabel', width: 110, render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '状态', key: 'state', width: 90, render: (_value, row) => (row.state ? <EntityStateTag state={row.state} /> : <Muted>—</Muted>) },
  ...metricColumns<Asin360AdsCampaignRow>(CURRENCY),
]

export const adGroupColumns: ColumnsType<Asin360AdsAdGroupRow> = [
  {
    title: '广告组',
    key: 'name',
    render: (_value, row) => (
      <div>
        <AppLink to={`/app/advertising/ad-groups/${encodeURIComponent(row.id)}`}>{row.name}</AppLink>
        <div className="erp-num">{row.adGroupId}</div>
      </div>
    ),
  },
  {
    title: '所属活动',
    key: 'campaign',
    width: 150,
    render: (_value, row) =>
      row.campaignId && row.campaignName ? (
        <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(row.campaignId)}`}>{row.campaignName}</AppLink>
      ) : (
        <span className="erp-num">{row.externalCampaignId}</span>
      ),
  },
  { title: '状态', key: 'state', width: 90, render: (_value, row) => <EntityStateTag state={row.state} /> },
  { title: '默认竞价', dataIndex: 'defaultBid', width: 90, align: 'right', render: (value: number | null) => moneyCell(value, CURRENCY) },
  { title: '本商品广告', key: 'asinAds', width: 100, align: 'right', render: (_value, row) => <span className="erp-num">{`${row.asinAds.enabled} / ${row.asinAds.total}`}</span> },
  {
    title: (
      <Tooltip title="这个广告组里一共推广了几个不同的 ASIN（含本商品）；大于 1 时，右边的数字包含别的商品">
        <span>组内商品数</span>
      </Tooltip>
    ),
    key: 'groupAsins',
    width: 100,
    align: 'right',
    render: (_value, row) =>
      row.groupAsins > 1 ? (
        <Tag color="warning" bordered={false}>
          {row.groupAsins}
        </Tag>
      ) : (
        numberCell(row.groupAsins)
      ),
  },
  ...metricColumns<Asin360AdsAdGroupRow>(CURRENCY).map(column => ({
    ...column,
    title:
      typeof column.title === 'string' ? (
        <Tooltip title={SHARED_HINT}>
          <span>{column.title}</span>
        </Tooltip>
      ) : (
        column.title
      ),
  })),
]

export const targetColumns: ColumnsType<AdsTargetRow> = [
  {
    title: '投放对象',
    dataIndex: 'expression',
    width: 220,
    render: (value: string, row) => (
      <span title={value}>
        <AppLink to={`/app/advertising/targets/${encodeURIComponent(row.id)}`}>{value}</AppLink>
      </span>
    ),
  },
  { title: '类型', dataIndex: 'kind', width: 80, render: (value: string) => ADS_TARGET_KIND_LABEL[value as keyof typeof ADS_TARGET_KIND_LABEL] ?? value },
  { title: '匹配方式', dataIndex: 'matchType', width: 100, render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '状态', key: 'state', width: 90, render: (_value, row) => <EntityStateTag state={row.state} /> },
  { title: '竞价', dataIndex: 'bid', width: 90, align: 'right', render: (value: number | null) => moneyCell(value, CURRENCY) },
  { title: '广告组', dataIndex: 'adGroupName', width: 140, render: (value: string | null, row) => value ?? <span className="erp-num">{row.adGroupId}</span> },
  ...metricColumns<AdsTargetRow>(CURRENCY),
]

const TERM_COLOR: Record<AdsTermStatus, string> = { TARGETED: 'success', NEGATED: 'error', UNTARGETED: 'default' }

export const termColumns: ColumnsType<AdsSearchTermRow> = [
  {
    title: '搜索词',
    key: 'searchTerm',
    width: 240,
    render: (_value, row) => (
      <div>
        {row.searchTerm}
        {isWastedTarget(row.metrics) ? (
          <Tag color="warning" bordered={false} style={{ marginLeft: 6 }}>
            花费无转化
          </Tag>
        ) : null}
      </div>
    ),
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (_value, row) => (
      <Tag color={TERM_COLOR[row.status]} bordered={false}>
        {ADS_TERM_STATUS_LABEL[row.status]}
      </Tag>
    ),
  },
  ...metricColumns<AdsSearchTermRow>(CURRENCY),
]
