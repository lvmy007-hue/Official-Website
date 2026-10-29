import type { ICellRendererParams } from 'ag-grid-community'
import { Space, Tag, Tooltip, Typography } from 'antd'
import { INVENTORY_ACTION_LABEL, type InventoryRow } from '@nova/api-contracts'
import { EstimateTag } from '../../components'
import type { ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { EMPTY_VALUE, NUMERIC_CLASS, formatMoney, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted, RiskTag } from './inventory-ui'

// 库存健康表的列（06 章 6.1，P6-03 迁到 PagedGrid 骨架）：按字段分组——商品、数量、销售与覆盖、风险、库龄与费用、建议。
// 空值一律显示“—”（没有记录），不显示成 0；估算类数字带“模型估算”标注。
// 列头问号只写指标字典键（metric），口径内容由字典生成，页面不写口径文案。
// 汇总行的数字只取服务端（inventory-totals-row）：没有合计的列显示“—”。

type Cell = ICellRendererParams<InventoryRow>

const num = (value: number | null | undefined, digits = 0) => <span className="erp-num">{formatNumber(value, { digits })}</span>
const money = (value: number | null | undefined) => <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>
const showNumber = (p: { value?: unknown }) => formatNumber(p.value as number | null | undefined)
const showMoney = (p: { value?: unknown }) => formatMoney(p.value as number | null | undefined, 'USD', { digits: 2 })
const showDash = () => EMPTY_VALUE

const right = { type: 'rightAligned', headerClass: 'ag-right-aligned-header', cellClass: NUMERIC_CLASS } as const

/** 白名单：列标识 → 服务端排序字段（服务端 /inventory 的 sort 参数）。 */
export const INVENTORY_SORTABLE = { sku: 'sellerSku', sellable: 'sellable', units30: 'units30', cover: 'daysOfCover', risk: 'risk', ageSurcharge: 'ageSurcharge', storage: 'storageFee' } as const
/** 默认排序：风险高的在前。 */
export const INVENTORY_DEFAULT_SORT: SortSpec = { field: 'risk', direction: 'asc' }

/**
 * 点 SKU：普通点击在右侧抽屉里看行详情（不离开列表）；带修饰键、中键仍是链接的原生行为（浏览器新标签页打开整页详情）。
 */
function SkuLink({ row, onOpen }: { row: InventoryRow; onOpen?: (id: string) => void }) {
  const href = `/app/inventory/${encodeURIComponent(row.id)}`
  if (!onOpen) return <AppLink to={href}>{row.sku}</AppLink>
  return (
    <a
      href={href}
      onClick={event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onOpen(row.id)
      }}
    >
      {row.sku}
    </a>
  )
}

export function inventoryColumns(onOpen?: (id: string) => void): ErpColDef<InventoryRow>[] {
  return [
    {
      headerName: 'SKU / ASIN',
      colId: 'sku',
      group: '商品',
      pin: 'left',
      width: 190,
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) =>
        data ? (
          <Space direction="vertical" size={0}>
            <SkuLink row={data} onOpen={onOpen} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data.asin}
            </Typography.Text>
          </Space>
        ) : null,
    },
    { headerName: '名称', colId: 'title', group: '商品', width: 220, valueFormatter: showDash, cellRenderer: ({ data }: Cell) => (data ? (data.title ?? <Muted>尚无记录</Muted>) : null) },
    { headerName: '店铺', colId: 'store', group: '商品', width: 120, valueFormatter: showDash, cellRenderer: ({ data }: Cell) => data?.storeName ?? null },

    {
      headerName: '可售',
      colId: 'sellable',
      group: '数量（件）',
      width: 90,
      metric: 'M-200',
      ...right,
      valueFormatter: showNumber,
      cellRenderer: ({ data }: Cell) => (data ? num(data.quantity.sellable) : null),
    },
    {
      headerName: '预留',
      colId: 'reserved',
      group: '数量（件）',
      width: 90,
      metric: 'M-202',
      ...right,
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) => (data ? num(data.quantity.reserved) : null),
    },
    {
      headerName: '在途',
      colId: 'inbound',
      group: '数量（件）',
      width: 90,
      metric: 'M-201',
      ...right,
      valueFormatter: showNumber,
      cellRenderer: ({ data }: Cell) =>
        data ? (
          <Tooltip title={`处理中 ${data.quantity.inboundWorking} · 已发货 ${data.quantity.inboundShipped} · 接收中 ${data.quantity.inboundReceiving}`}>
            <span>{num(data.quantity.inboundTotal)}</span>
          </Tooltip>
        ) : null,
    },
    {
      headerName: '不可售',
      colId: 'unsellable',
      group: '数量（件）',
      width: 100,
      metric: 'M-203',
      ...right,
      valueFormatter: showNumber,
      cellRenderer: ({ data }: Cell) => (data ? num(data.quantity.unsellable) : null),
    },

    { headerName: '近 30 天销量', colId: 'units30', group: '销售与覆盖', width: 120, ...right, valueFormatter: showDash, cellRenderer: ({ data }: Cell) => (data ? num(data.demand.units30) : null) },
    {
      headerName: '预测日销',
      colId: 'demand',
      group: '销售与覆盖',
      width: 130,
      metric: 'M-205',
      ...right,
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) =>
        !data ? null : data.demand.mid === null ? (
          <Muted>尚无记录</Muted>
        ) : (
          <Space size={4}>
            {num(data.demand.mid, 1)}
            <EstimateTag method="近 30 天日均（剔除已知断货日）" range={`低 ${data.demand.low} / 中 ${data.demand.mid} / 高 ${data.demand.high} 件/天`} />
          </Space>
        ),
    },
    {
      headerName: '可售天数',
      colId: 'cover',
      group: '销售与覆盖',
      width: 120,
      metric: 'M-206',
      ...right,
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) => (!data ? null : data.assessment.noDemand ? <Muted>近期无销量</Muted> : num(data.assessment.daysOfCover, 1)),
    },
    {
      headerName: '预计断货日',
      colId: 'stockout',
      group: '销售与覆盖',
      width: 130,
      metric: 'M-211',
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) => (data ? (data.assessment.stockoutDate ?? EMPTY_VALUE) : null),
    },

    { headerName: '风险', colId: 'risk', width: 160, metric: 'M-210', valueFormatter: showDash, cellRenderer: ({ data }: Cell) => (data ? <RiskTag assessment={data.assessment} /> : null) },

    {
      headerName: '库龄风险',
      colId: 'aging',
      group: '库龄与费用',
      width: 110,
      metric: 'M-213',
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) =>
        !data ? null : data.age.atRisk === null ? (
          EMPTY_VALUE
        ) : data.age.atRisk ? (
          <Tag color="warning" bordered={false}>
            有风险
          </Tag>
        ) : (
          '无'
        ),
    },
    {
      headerName: '库龄附加费预估',
      colId: 'ageSurcharge',
      group: '库龄与费用',
      width: 150,
      metric: 'M-214',
      ...right,
      valueFormatter: showMoney,
      cellRenderer: ({ data }: Cell) => (data ? money(data.age.surchargeEstimate) : null),
    },
    {
      headerName: '预计下月仓储费',
      colId: 'storage',
      group: '库龄与费用',
      width: 150,
      metric: 'M-216',
      ...right,
      valueFormatter: showMoney,
      cellRenderer: ({ data }: Cell) => (data ? money(data.fees.nextMonthStorage) : null),
    },

    {
      headerName: '我方',
      colId: 'ourAction',
      group: '建议',
      width: 150,
      valueFormatter: showDash,
      cellRenderer: ({ data }: Cell) => (data ? (data.advice.ourAction ? INVENTORY_ACTION_LABEL[data.advice.ourAction] : EMPTY_VALUE) : null),
    },
    { headerName: '亚马逊', colId: 'amazonAction', group: '建议', width: 150, valueFormatter: showDash, cellRenderer: ({ data }: Cell) => (data ? (data.advice.amazonAction ?? EMPTY_VALUE) : null) },
  ]
}
