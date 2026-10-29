import { Descriptions, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ProfitCostDetail, ProfitGroupRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { margin, signedMoney } from './profit-ui'

// ASIN 利润页签的列与展开明细。商品列按维度显示：SKU 视图给 SKU 与 ASIN，ASIN 视图给 ASIN，父体视图给父 ASIN。
// 成本相关列（成本覆盖率、折算明细）只在有成本字段权限时由接口返回，没有就不显示这些列。

function Product({ row }: { row: ProfitGroupRow }) {
  const id = row.dimension === 'PARENT' ? row.parentAsin : row.asin
  const label = id ?? row.sku ?? '—'
  const link =
    row.productId && row.dimension !== 'PARENT' ? (
      <LiveLink component="Asin360Page" id={row.productId}>
        {label}
      </LiveLink>
    ) : (
      label
    )
  return (
    <div>
      <div>
        <span className="erp-num">{link}</span>
        {row.dimension === 'SKU' && row.sku ? <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>{row.sku}</span> : null}
      </div>
      <div style={{ color: 'rgba(0,0,0,0.65)' }}>{row.title ?? <Muted>尚无商品名</Muted>}</div>
    </div>
  )
}

export function groupColumns(withCost: boolean): ColumnsType<ProfitGroupRow> {
  const columns: ColumnsType<ProfitGroupRow> = [
    { title: '商品', key: 'product', width: 300, render: (_value, row) => <Product row={row} /> },
    { title: '店铺', dataIndex: 'storeName', width: 120, render: (value: string | null) => value ?? <Muted>多个店铺合计</Muted> },
    { title: '销量（件）', dataIndex: 'units', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
    { title: '销售额', dataIndex: 'revenue', width: 120, align: 'right', render: (value: number) => money(value) },
    { title: '平台费用', dataIndex: 'fees', width: 120, align: 'right', render: (value: number) => money(value) },
    { title: '净利润', dataIndex: 'profit', width: 130, align: 'right', render: (value: number | null) => signedMoney(value) },
    { title: '利润率', dataIndex: 'margin', width: 90, align: 'right', render: (value: number | null) => margin(value) },
  ]
  if (withCost)
    columns.push({
      title: '成本覆盖率',
      dataIndex: 'costCoverage',
      width: 110,
      align: 'right',
      render: (value: number | null | undefined) => (value === null || value === undefined ? <Muted>尚无记录</Muted> : formatPercent(value, { digits: 1 })),
    })
  columns.push({
    title: '状态',
    key: 'state',
    width: 130,
    render: (_value, row) =>
      row.incompleteRows > 0 ? (
        <Tag color="warning" bordered={false}>
          缺成本 {row.incompleteRows} 行
        </Tag>
      ) : (
        ''
      ),
  })
  return columns
}

const costColumns: ColumnsType<ProfitCostDetail> = [
  { title: '成本币种', dataIndex: 'currency', width: 90, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  {
    title: '商品成本（原币）',
    key: 'productOriginal',
    width: 150,
    align: 'right',
    render: (_value, row) => (row.productOriginal === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(row.productOriginal, row.currency ?? 'USD', { digits: 2 })}</span>),
  },
  { title: '折算美元', dataIndex: 'productConverted', width: 120, align: 'right', render: (value: number | null) => money(value) },
  { title: '汇率', dataIndex: 'rate', width: 100, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{value}</span>) },
  {
    title: '汇率来源',
    key: 'source',
    width: 150,
    render: (_value, row) => (row.source ? `${row.source === 'MANUAL' ? '手工覆盖' : '系统获取'}${row.fallbackRows > 0 ? `（${row.fallbackRows} 行沿用前值）` : ''}` : <Muted>尚无记录</Muted>),
  },
  {
    title: '头程成本（原币）',
    key: 'firstMileOriginal',
    width: 150,
    align: 'right',
    render: (_value, row) => (row.firstMileOriginal === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(row.firstMileOriginal, row.currency ?? 'USD', { digits: 2 })}</span>),
  },
  { title: '头程折算美元', dataIndex: 'firstMileConverted', width: 130, align: 'right', render: (value: number | null) => money(value) },
]

/** 展开：单位经济、官方对照（尚未接入）、成本折算明细（原币、折算美元、汇率与来源）。 */
export function GroupExpanded({ row }: { row: ProfitGroupRow }) {
  const unit = row.perUnit
  return (
    <div data-testid="profit-expanded">
      <Descriptions size="small" column={{ xs: 1, md: 4 }} bordered title="单位经济（每件）">
        <Descriptions.Item label="销售额">{unit ? money(unit.revenue) : <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="平台费用">{unit ? money(unit.fees) : <Muted>尚无记录</Muted>}</Descriptions.Item>
        {unit && 'productCost' in unit ? <Descriptions.Item label="商品成本">{money(unit.productCost)}</Descriptions.Item> : null}
        <Descriptions.Item label="净利润">{unit ? signedMoney(unit.profit) : <Muted>尚无记录</Muted>}</Descriptions.Item>
      </Descriptions>
      <p style={{ margin: '8px 0' }}>
        官方单品经济对比：<Muted>{row.official.note}</Muted>
      </p>
      {row.costDetail ? (
        <SimpleGrid<ProfitCostDetail>
          gridId="profit.asin-columns"
          columns={costColumns}
          rows={row.costDetail}
          rowKey={detail => `${detail.currency}|${detail.source}|${detail.rate}`}
          emptyState={{ kind: 'empty', domain: '成本折算明细', prerequisite: '这一行没有已计入的成本。' }}
        />
      ) : null}
    </div>
  )
}
