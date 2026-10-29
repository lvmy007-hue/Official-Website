import { Image, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_NEGATIVE_LEVEL_LABEL, type AdsGroupProductRow, type AdsNegativeList, type AdsNegativeRow } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'
import { Searchable } from './ads-campaign-tabs'
import { metricColumns } from './ads-campaigns-ui'

// 广告组详情自己的两个列表页签（08 章 8.4）：广告商品（带库存状态，断货标红）与否定投放（活动级与本广告组级）。
// 投放对象、搜索词页签复用活动详情的同一套（换接口前缀）；趋势、分时、操作记录复用活动详情的组件。

const base = (id: string, tab: string) => `/ads/ad-groups/${encodeURIComponent(id)}/${tab}`

const stockTag = (row: AdsGroupProductRow) =>
  row.stock === 'OUT_OF_STOCK' ? (
    <Tag color="error" bordered={false}>
      断货
    </Tag>
  ) : row.stock === 'IN_STOCK' ? (
    <Tag color="success" bordered={false}>
      有货
    </Tag>
  ) : (
    <Muted>库存未知</Muted>
  )

export function GroupProductsTab({ id, currency }: { id: string; currency: string }) {
  const columns: ColumnsType<AdsGroupProductRow> = [
    {
      title: '广告商品',
      key: 'asin',
      width: 300,
      render: (_value, row) => (
        <Space>
          {row.imageUrl ? <Image src={row.imageUrl} alt={row.asin ?? row.adId} width={36} height={36} style={{ objectFit: 'contain' }} /> : null}
          <div>
            <div className="erp-num">{row.asin ?? <Muted>广告里没有 ASIN</Muted>}</div>
            <Muted>
              {row.sku ? `SKU ${row.sku} · ` : ''}
              {row.title ?? '商品资料尚未同步'}
            </Muted>
          </div>
        </Space>
      ),
    },
    { title: '广告状态', dataIndex: 'state', width: 90 },
    {
      title: '库存',
      key: 'stock',
      width: 130,
      render: (_value, row) => (
        <span>
          {stockTag(row)} {row.sellable === null ? null : <span className="erp-num">{row.sellable}</span>}
        </span>
      ),
    },
    ...metricColumns<AdsGroupProductRow>(currency),
  ]
  return <Searchable<AdsGroupProductRow> path={base(id, 'products')} columns={columns} rowKey={row => row.adId} domain="广告商品" placeholder="搜索 ASIN、SKU 或商品名称" scrollX={1100} />
}

export function NegativesTab({ id }: { id: string }) {
  const columns: ColumnsType<AdsNegativeRow> = [
    { title: '否定词或商品', dataIndex: 'expression' },
    { title: '匹配方式', dataIndex: 'matchType', width: 150 },
    { title: '层级', dataIndex: 'level', width: 100, render: (value: AdsNegativeRow['level']) => ADS_NEGATIVE_LEVEL_LABEL[value] },
    { title: '编号', dataIndex: 'negativeId', width: 160, render: (value: string) => <span className="erp-num">{value}</span> },
  ]
  return (
    <Searchable<AdsNegativeRow, AdsNegativeList>
      path={base(id, 'negatives')}
      columns={columns}
      rowKey={row => row.negativeId}
      domain="否定投放"
      placeholder="搜索否定词"
      header={data => (data ? <WriteHint note={data.write.note} /> : null)}
    />
  )
}

function WriteHint({ note }: { note: string }) {
  return (
    <Tooltip title={note}>
      <span>
        <Tag bordered={false} color="blue">
          添加否定投放：用页面顶部的按钮
        </Tag>
        <Muted>{note}</Muted>
      </span>
    </Tooltip>
  )
}
