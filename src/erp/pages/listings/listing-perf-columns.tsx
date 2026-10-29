import type { ReactNode } from 'react'
import { Space, Tag, Tooltip } from 'antd'
import {
  LISTING_ANOMALY_INFO,
  LISTING_METRIC_NOTES,
  LISTING_PENDING_COLUMNS,
  PRODUCT_CHANNEL_LABEL,
  PRODUCT_LISTING_LABEL,
  type ListingDataState,
  type ListingGate,
  type ListingPendingColumn,
  type ListingPerfResponse,
  type ListingPerfRow,
} from '@nova/api-contracts'
import { renderColumn, headerNote, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatNumber, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { moneyCell, numberCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'

// 刊登表现表格的列（5.3；P6-28 迁到 MassiveGrid）：没有记录写“尚无记录”，没有权限写“无权限”，来源还没建好写“尚未接入”并标明哪个工作包交付——都不写 0。
// 列显示、顺序、固定与保存视图由表格自带的列设置和视图负责；权限与来源状态（gates）随每次读到的第一页变化，列定义取它的“当前值”，所以列本身是稳定的。
export type ListingColumnContext = { gates: ListingPerfResponse['gates']; pending: readonly ListingPendingColumn[] }

export const DEFAULT_CONTEXT: ListingColumnContext = {
  gates: { traffic: { state: 'OK', note: null }, ads: { state: 'OK', note: null }, returns: { state: 'OK', note: null }, stock: { state: 'OK', note: null } },
  pending: LISTING_PENDING_COLUMNS,
}

/** 列标识 → 服务端排序字段（列头点击排序）。 */
export const LISTING_SORTABLE: Readonly<Record<string, string>> = {
  product: 'asin',
  price: 'price',
  sessions: 'sessions',
  pageViews: 'pageViews',
  units: 'units',
  sales: 'sales',
  conversion: 'conversion',
  buyBox: 'buyBox',
  adsSales: 'adsSales',
  returnRate: 'returnRate',
  daysOfSupply: 'daysOfSupply',
}

const LISTING_COLOR: Record<string, string> = { ACTIVE: 'success', INACTIVE: 'default', INCOMPLETE: 'warning' }

/** 没有值时的说明：有权限但没数据时给出原因（悬停可见）。 */
const missing = (gate: ListingGate, why?: string): ReactNode =>
  (gate.note ?? why) ? (
    <Tooltip title={gate.note ?? why}>
      <span>
        <Muted>尚无记录</Muted>
      </span>
    </Tooltip>
  ) : (
    <Muted>尚无记录</Muted>
  )

const restricted = (state: ListingDataState) => state === 'RESTRICTED'
const NO_PERMISSION = <Muted>无权限</Muted>

function gated(gate: ListingGate, value: number | null, show: (value: number) => ReactNode, why?: string): ReactNode {
  if (restricted(gate.state)) return NO_PERMISSION
  if (gate.state === 'NOT_CONNECTED') return <Muted>尚未接入</Muted>
  return value === null ? missing(gate, why) : show(value)
}

function pendingColumn(key: ListingPendingColumn['key'], context: () => ListingColumnContext): ErpColDef<ListingPerfRow> {
  const label = (context().pending.find(item => item.key === key) ?? LISTING_PENDING_COLUMNS.find(item => item.key === key))?.label ?? key
  return renderColumn<ListingPerfRow>(
    label,
    key,
    () => {
      const info = context().pending.find(item => item.key === key)
      return (
        <Tooltip title={info ? `${info.workPackage} 交付：${info.note}` : '尚未接入'}>
          <span>
            <Muted>尚未接入</Muted>
          </span>
        </Tooltip>
      )
    },
    { width: 100 },
  )
}

/** 转化率格子：本期转化率，有上一周期时在下面小字给出对比。 */
function conversionCell(row: ListingPerfRow): ReactNode {
  if (row.conversion === null) return <Muted>尚无记录</Muted>
  return (
    <span className="erp-cell-stack">
      {percentCell(row.conversion)}
      {row.conversionPrev !== null ? (
        <span className="erp-cell-sub">
          <Muted>上期 {formatPercent(row.conversionPrev, { digits: 1 })}</Muted>
        </span>
      ) : null}
    </span>
  )
}

const num = (title: string, id: string, render: (row: ListingPerfRow) => ReactNode, width: number, note?: string): ErpColDef<ListingPerfRow> =>
  renderColumn<ListingPerfRow>(title, id, render, { width, ...RIGHT_ALIGNED, ...headerNote(note) })

/** 全部列；`context` 取当前的权限与来源状态（每次读到第一页后更新）。 */
export function listingColumns(context: () => ListingColumnContext): ErpColDef<ListingPerfRow>[] {
  const gates = () => context().gates
  return [
    renderColumn<ListingPerfRow>(
      '商品',
      'product',
      row => (
        <div className="erp-cell-product">
          {row.imageUrl ? <img className="erp-cell-product-img" src={row.imageUrl} alt="" loading="lazy" /> : <span className="erp-cell-product-img" aria-hidden="true" />}
          <div className="erp-cell-stack">
            <AppLink to={`/app/products/${encodeURIComponent(row.id)}`}>{row.title}</AppLink>
            <span className="erp-cell-sub erp-num">
              {row.asin} · {row.sku}
            </span>
            <span className="erp-cell-sub erp-num">{row.storeName}</span>
          </div>
        </div>
      ),
      { width: 340, pin: 'left' },
    ),
    renderColumn<ListingPerfRow>(
      '刊登状态',
      'status',
      row => (
        <Tag color={LISTING_COLOR[row.listingStatus] ?? 'default'} bordered={false}>
          {PRODUCT_LISTING_LABEL[row.listingStatus] ?? row.listingStatus}
        </Tag>
      ),
      { width: 100, sortable: false },
    ),
    renderColumn<ListingPerfRow>('品牌', 'brand', row => row.brand ?? <Muted>尚无记录</Muted>, { width: 110, sortable: false }),
    renderColumn<ListingPerfRow>('配送', 'channel', row => PRODUCT_CHANNEL_LABEL[row.fulfillmentChannel] ?? row.fulfillmentChannel, { width: 120, sortable: false }),
    num('价格', 'price', row => moneyCell(row.price, row.currency), 90, LISTING_METRIC_NOTES.price),
    num('会话', 'sessions', row => gated(gates().traffic, row.sessions, value => numberCell(value)), 90),
    num('浏览量', 'pageViews', row => gated(gates().traffic, row.pageViews, value => numberCell(value)), 90),
    num('销量', 'units', row => gated(gates().traffic, row.units, value => numberCell(value)), 90),
    num(
      '销售额',
      'sales',
      row => (
        <span>
          {gated(gates().traffic, row.sales, value => moneyCell(value))}
          {row.salesShared && row.sales !== null ? (
            <Tooltip title="同店铺 ASIN 的多个 SKU 共用这份销售与流量数字，不是按 SKU 拆分。">
              <Tag bordered={false} style={{ marginLeft: 4 }}>
                共用
              </Tag>
            </Tooltip>
          ) : null}
        </span>
      ),
      130,
    ),
    num('转化率', 'conversion', row => (gates().traffic.state === 'OK' ? conversionCell(row) : gated(gates().traffic, null, () => null)), 110, LISTING_METRIC_NOTES.conversion),
    num('购物车获得率', 'buyBox', row => gated(gates().traffic, row.buyBox, value => percentCell(value)), 130, LISTING_METRIC_NOTES.buyBox),
    num('广告销售', 'adsSales', row => gated(gates().ads, row.adsSales, value => moneyCell(value)), 110, LISTING_METRIC_NOTES.adsSales),
    num('退货率（估算）', 'returnRate', row => gated(gates().returns, row.returnRate, value => percentCell(value), '没有订购件数，无法计算退货率'), 130, LISTING_METRIC_NOTES.returnRate),
    num(
      '可售天数',
      'daysOfSupply',
      row => gated(gates().stock, row.daysOfSupply, value => <span className="erp-num">{formatNumber(value, { digits: 1 })} 天</span>, '没有这个 SKU 的库存记录，或范围最近 7 天没有销量'),
      100,
      LISTING_METRIC_NOTES.daysOfSupply,
    ),
    pendingColumn('rating', context),
    pendingColumn('ratingCount', context),
    pendingColumn('issueCount', context),
    pendingColumn('qualityScore', context),
    renderColumn<ListingPerfRow>(
      '异常',
      'anomaly',
      row =>
        row.anomalies.length > 0 ? (
          <Space size={[2, 2]}>
            {row.anomalies.map(kind => (
              <Tooltip key={kind} title={LISTING_ANOMALY_INFO[kind].basis}>
                <Tag color="error" bordered={false}>
                  {LISTING_ANOMALY_INFO[kind].label}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        ) : (
          <Muted>未触发</Muted>
        ),
      { width: 150, sortable: false },
    ),
    renderColumn<ListingPerfRow>('负责人', 'owner', row => (row.ownerUserId ? (row.ownerName ?? '已离开的成员') : <Muted>未指定</Muted>), { width: 110, sortable: false }),
  ]
}
