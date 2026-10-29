import { Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PRODUCT_CHANNEL_LABEL, PRODUCT_COPY_NOTE, PRODUCT_LISTING_LABEL, PRODUCT_MARGIN_STATE_LABEL, type ProductListRow } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { moneyCell, numberCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'

// 商品主数据列表的列（05 章 5.1）：没有记录的列写“尚无记录”，没有权限的列写“无权限”，来源还没建好的列写“尚未接入”——都不写 0。

export type ColumnContext = { stockAllowed: boolean; profitAllowed: boolean; notConnected: string }

const LISTING_COLOR: Record<string, string> = { ACTIVE: 'success', INACTIVE: 'default', INCOMPLETE: 'warning' }
const MARGIN_TEXT: Record<string, string> = { NO_SALES: '无销售额', COST_MISSING: '缺成本', NO_RECORD: '尚无记录' }

const never = (title: string, notConnected: string) => ({
  title,
  key: title,
  width: 100,
  render: () => (
    <Tooltip title={notConnected}>
      <span>
        <Muted>尚未接入</Muted>
      </span>
    </Tooltip>
  ),
})

export function productColumns(context: ColumnContext): ColumnsType<ProductListRow> {
  return [
    {
      title: '商品',
      key: 'product',
      width: 340,
      fixed: 'left',
      render: (_value, row) => (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {row.imageUrl ? (
            <img src={row.imageUrl} alt="" width={36} height={36} style={{ objectFit: 'cover', borderRadius: 4, flex: 'none' }} />
          ) : (
            <span
              style={{ width: 36, height: 36, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.04)', borderRadius: 4, fontSize: 12 }}
            >
              <Muted>无图</Muted>
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <AppLink to={`/app/products/${encodeURIComponent(row.id)}`}>{row.title}</AppLink>
            <div className="erp-num">
              {row.asin} · {row.sku}
              {row.fnsku ? ` · ${row.fnsku}` : ''}
            </div>
            <div className="erp-num">{row.storeName}</div>
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_value, row) => (
        <Space size={[2, 2]} wrap>
          <Tag color={LISTING_COLOR[row.listingStatus] ?? 'default'} bordered={false}>
            {PRODUCT_LISTING_LABEL[row.listingStatus] ?? row.listingStatus}
          </Tag>
          {row.catalogState === 'NOT_FOUND' ? (
            <Tag color="warning" bordered={false}>
              目录里没有
            </Tag>
          ) : null}
          {row.catalogState === 'NOT_SYNCED' ? <Muted>目录未同步</Muted> : null}
        </Space>
      ),
    },
    { title: '品牌', key: 'brand', width: 110, render: (_value, row) => row.brand ?? <Muted>尚无记录</Muted> },
    { title: '类目', key: 'category', width: 160, render: (_value, row) => row.categoryPath ?? <Muted>尚无记录</Muted> },
    { title: '父 ASIN', key: 'parentAsin', width: 110, render: (_value, row) => (row.parentAsin ? <span className="erp-num">{row.parentAsin}</span> : <Muted>无</Muted>) },
    { title: '配送', key: 'channel', width: 120, render: (_value, row) => PRODUCT_CHANNEL_LABEL[row.fulfillmentChannel] ?? row.fulfillmentChannel },
    { title: '售价', key: 'price', width: 90, align: 'right', render: (_value, row) => moneyCell(row.price, row.currency) },
    {
      title: '近 30 天销售额',
      key: 'sales30',
      width: 130,
      align: 'right',
      render: (_value, row) => (
        <span>
          {moneyCell(row.sales30)}
          {row.salesShared && row.sales30 !== null ? (
            <Tooltip title={PRODUCT_COPY_NOTE}>
              <Tag bordered={false} style={{ marginLeft: 4 }}>
                共用
              </Tag>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    { title: '近 30 天销量', key: 'units30', width: 100, align: 'right', render: (_value, row) => numberCell(row.units30) },
    {
      title: '近 30 天利润率',
      key: 'margin30',
      width: 120,
      align: 'right',
      render: (_value, row) => {
        if (!context.profitAllowed || row.marginState === undefined) return <Muted>无权限</Muted>
        if (row.margin30 !== null && row.margin30 !== undefined) return percentCell(row.margin30)
        return (
          <Tooltip title={PRODUCT_MARGIN_STATE_LABEL[row.marginState]}>
            <span>
              <Muted>{MARGIN_TEXT[row.marginState] ?? '尚无记录'}</Muted>
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: '可售库存',
      key: 'sellable',
      width: 100,
      align: 'right',
      render: (_value, row) => (!context.stockAllowed ? <Muted>无权限</Muted> : numberCell(row.sellable)),
    },
    never('刊登问题数', context.notConnected),
    never('刊登质量分', context.notConnected),
    {
      title: '标签',
      key: 'tags',
      width: 160,
      render: (_value, row) =>
        row.tags.length ? (
          <Space size={[2, 2]} wrap>
            {row.tags.map(tag => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            ))}
          </Space>
        ) : (
          <Muted>无</Muted>
        ),
    },
    { title: '负责人', key: 'owner', width: 110, render: (_value, row) => (row.ownerUserId ? (row.ownerName ?? '已离开的成员') : <Muted>未指定</Muted>) },
    {
      title: '关注',
      key: 'watched',
      width: 70,
      render: (_value, row) =>
        row.watched ? (
          <Tag color="blue" bordered={false}>
            已关注
          </Tag>
        ) : (
          <Muted>—</Muted>
        ),
    },
    { title: '最近更新', dataIndex: 'updatedAt', width: 150, render: (value: string) => formatDateTime(value) },
  ]
}
