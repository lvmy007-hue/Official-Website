import { Button, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AD_TERM_NEGATIVE_LEVEL_LABEL,
  ADS_WRITE_PENDING,
  type AdTermMetricBlock,
  type AdTermNegativeRow,
  type AdTermRootRow,
  type AdTermSearchRow,
  type AdTermTargetRow,
  type AdTermNegativeLevel,
} from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { EntityStateTag, moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'
import { AnomalyTags, StatusTag, TermLink } from './ad-terms-ui'

// 词级中心各页签的列（P3-10）。空值写“尚无记录”，不补 0；写入亚马逊的动作按钮一律禁用并说明原因（随 P3-17 接入）。

const write = ADS_WRITE_PENDING.note

/** 指标列：花费、广告销售额、订单、点击、广告成本销售比、转化率。 */
function metricColumns<T extends AdTermMetricBlock>(): ColumnsType<T> {
  return [
    { title: '花费', key: 'spend', width: 100, align: 'right', render: (_value, row) => moneyCell(row.totals.spend) },
    { title: '广告销售额', key: 'sales', width: 110, align: 'right', render: (_value, row) => moneyCell(row.totals.sales) },
    { title: '订单', key: 'orders', width: 70, align: 'right', render: (_value, row) => numberCell(row.totals.orders) },
    { title: '点击', key: 'clicks', width: 80, align: 'right', render: (_value, row) => numberCell(row.totals.clicks) },
    { title: '广告成本销售比', key: 'acos', width: 120, align: 'right', render: (_value, row) => percentCell(row.ratios.acos) },
    { title: '转化率', key: 'cvr', width: 80, align: 'right', render: (_value, row) => percentCell(row.ratios.cvr) },
  ]
}

const disabledButtons = (...labels: string[]) => (
  <Tooltip title={write}>
    <Space size={4}>
      {labels.map(label => (
        <Button key={label} size="small" disabled>
          {label}
        </Button>
      ))}
    </Space>
  </Tooltip>
)

export function searchTermColumns(): ColumnsType<AdTermSearchRow> {
  return [
    { title: '搜索词', key: 'searchTerm', width: 220, fixed: 'left', render: (_value, row) => <TermLink term={row.searchTerm} /> },
    { title: '状态', key: 'status', width: 90, render: (_value, row) => <StatusTag status={row.status} campaigns={row.campaigns} /> },
    { title: '异常', key: 'anomalies', width: 190, render: (_value, row) => <AnomalyTags anomalies={row.anomalies} /> },
    ...metricColumns<AdTermSearchRow>(),
    { title: '活动数', key: 'campaigns', width: 80, align: 'right', render: (_value, row) => numberCell(row.campaigns.total) },
    { title: '店铺数', key: 'stores', width: 80, align: 'right', render: (_value, row) => numberCell(row.stores) },
    { title: '操作', key: 'actions', width: 190, render: () => disabledButtons('添加为关键词', '添加否定') },
  ]
}

const dash = (value: string | null | undefined) => (value ? value : <Muted>—</Muted>)

export function targetColumns(): ColumnsType<AdTermTargetRow> {
  return [
    { title: '投放词', key: 'expression', width: 200, fixed: 'left', render: (_value, row) => <TermLink term={row.expression} /> },
    { title: '匹配方式', dataIndex: 'matchType', width: 100, render: (value: string | null) => dash(value) },
    { title: '活动', key: 'campaign', width: 200, render: (_value, row) => row.campaignName ?? <span className="erp-num">{row.externalCampaignId}</span> },
    { title: '广告组', key: 'adGroup', width: 160, render: (_value, row) => dash(row.adGroupName ?? row.adGroupId) },
    { title: '店铺', dataIndex: 'storeName', width: 120, render: (value: string | null) => dash(value) },
    { title: '竞价', dataIndex: 'bid', width: 90, align: 'right', render: (value: number | null) => moneyCell(value) },
    { title: '状态', dataIndex: 'state', width: 90, render: (value: string | null) => (value ? <EntityStateTag state={value} /> : NONE) },
    { title: '异常', key: 'anomalies', width: 190, render: (_value, row) => <AnomalyTags anomalies={row.anomalies} /> },
    ...metricColumns<AdTermTargetRow>(),
    { title: '操作', key: 'actions', width: 110, render: () => disabledButtons('调整竞价') },
  ]
}

export function negativeColumns(): ColumnsType<AdTermNegativeRow> {
  return [
    { title: '否定词', key: 'expression', width: 220, fixed: 'left', render: (_value, row) => <TermLink term={row.expression} /> },
    { title: '匹配方式', dataIndex: 'matchType', width: 130 },
    {
      title: '层级',
      key: 'level',
      width: 90,
      render: (_value, row) => <Tag bordered={false}>{AD_TERM_NEGATIVE_LEVEL_LABEL[row.level as AdTermNegativeLevel] ?? row.level}</Tag>,
    },
    { title: '活动', key: 'campaign', width: 220, render: (_value, row) => row.campaignName ?? <span className="erp-num">{row.externalCampaignId}</span> },
    { title: '广告组', key: 'adGroup', width: 180, render: (_value, row) => dash(row.adGroupName ?? row.adGroupId) },
    { title: '店铺', key: 'store', width: 160, render: (_value, row) => row.storeName ?? <Muted>{row.accountName}（未绑定店铺）</Muted> },
    { title: '最近同步', dataIndex: 'syncedAt', width: 150, render: (value: string) => formatDateTime(value) },
    { title: '操作', key: 'actions', width: 100, render: () => disabledButtons('移除否定') },
  ]
}

export function rootColumns(): ColumnsType<AdTermRootRow> {
  return [
    {
      title: '词根',
      key: 'root',
      width: 160,
      fixed: 'left',
      render: (_value, row) => (
        <div>
          <span>{row.root}</span>
          {row.forms.length > 1 ? <Muted> 写法：{row.forms.join('、')}</Muted> : null}
        </div>
      ),
    },
    { title: '搜索词数', dataIndex: 'terms', width: 90, align: 'right', render: (value: number) => numberCell(value) },
    { title: '店铺数', dataIndex: 'stores', width: 80, align: 'right', render: (value: number) => numberCell(value) },
    ...metricColumns<AdTermRootRow>(),
    {
      title: '例子词（按花费）',
      key: 'examples',
      width: 300,
      render: (_value, row) => (
        <Space size={[4, 4]} wrap>
          {row.examples.map(example => (
            <TermLink key={example.term} term={example.term} />
          ))}
        </Space>
      ),
    },
  ]
}
