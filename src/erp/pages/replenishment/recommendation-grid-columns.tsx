import type { ICellRendererParams } from 'ag-grid-community'
import { Button, Space, Tag, Tooltip, Typography } from 'antd'
import { REPLENISH_ACTION_LABEL, type RecommendationRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { EMPTY_VALUE, formatDate, formatNumber } from '../../format'
import { ConfidenceTag, qty, RiskTag } from './replenishment-ui'

// 建议列表的列（P6-09 起迁到 PagedGrid 骨架）：商品与风险在前，数量（建议补货量、建议采购量、必断货量）、日期（建议发货日及距今天数）、
// 人工预测规则标记、亚马逊建议用于双源对照，最后是已做过的动作与模拟入口。没有记录的数字显示“尚无记录”或“—”，不显示成 0。
// 点任意一行在右侧抽屉看计算链、供给拆分与双源核对（见 RecommendationDrawer）。

type Cell = ICellRendererParams<RecommendationRow>

/** 白名单：列标识 → 服务端排序字段。 */
export const RECOMMENDATION_SORTABLE = { sku: 'sku', risk: 'risk', recommendedQty: 'recommendedQty', orderDate: 'orderDate', shipDate: 'shipDate', arriveDate: 'arriveDate' } as const
export const RECOMMENDATION_DEFAULT_SORT: SortSpec = { field: 'risk', direction: 'asc' }

const dateCell = (value: string | null) => (value ? <span className="erp-num">{formatDate(value)}</span> : <Typography.Text type="secondary">{EMPTY_VALUE}</Typography.Text>)
const dateText = (value: string | null) => (value ? formatDate(value) : EMPTY_VALUE)

/** 距今天数的文案：今天、N 天后、已逾期 N 天。 */
export function shipInText(days: number): string {
  if (days === 0) return '今天'
  return days > 0 ? `${days} 天后` : `已逾期 ${-days} 天`
}

function ShipDate({ row }: { row: RecommendationRow }) {
  return (
    <Space size={6}>
      <span className="erp-num">{formatDate(row.suggestedShipDate)}</span>
      <Tag color={row.shipInDays < 0 ? 'error' : row.shipInDays <= 6 ? 'warning' : 'default'} bordered={false} style={{ marginInlineEnd: 0 }}>
        {shipInText(row.shipInDays)}
      </Tag>
    </Space>
  )
}

/** 必断货量：旧批次（P6-09 之前计算）没有记录，显示“旧批次没有记录”；为 0 显示 0；有数值带“未计入 / 已计入”。 */
export function ShortageCell({ row }: { row: RecommendationRow }) {
  if (row.unavoidableShortage === null) return <Typography.Text type="secondary">旧批次没有记录</Typography.Text>
  if (row.unavoidableShortage === 0) return <span className="erp-num">0</span>
  return (
    <Tooltip title={row.unavoidableIncluded ? '已计入建议补货量（策略开关“计入必断货量”已开启）' : '最快运输方式也补不上的缺口，没有计入建议补货量（策略开关“计入必断货量”默认关闭）'}>
      <Space size={4}>
        <span className="erp-num">{formatNumber(row.unavoidableShortage, { digits: 0 })}</span>
        <Tag color={row.unavoidableIncluded ? 'processing' : 'warning'} bordered={false} style={{ marginInlineEnd: 0 }}>
          {row.unavoidableIncluded ? '已计入' : '未计入'}
        </Tag>
      </Space>
    </Tooltip>
  )
}

function OverrideCell({ row }: { row: RecommendationRow }) {
  const used = row.appliedOverride.filter(item => item.applied)
  if (row.appliedOverride.length === 0) return <Typography.Text type="secondary">模型预测</Typography.Text>
  const skipped = row.appliedOverride.length - used.length
  return (
    <Tooltip
      title={row.appliedOverride
        .map(item => `${item.scopeType === 'SKU' ? 'SKU' : '品类'} ${item.scopeId} ${item.from} 至 ${item.to}：${item.applied ? `取代模型预测 ${item.days} 天` : (item.note ?? '未生效')}`)
        .join('；')}
    >
      <Space size={4}>
        {used.length > 0 ? (
          <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>
            人工规则 {used.length} 条
          </Tag>
        ) : null}
        {skipped > 0 ? (
          <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
            未生效 {skipped} 条
          </Tag>
        ) : null}
      </Space>
    </Tooltip>
  )
}

export function recommendationGridColumns(onSimulate: (row: RecommendationRow) => void): ErpColDef<RecommendationRow>[] {
  return [
    renderColumn<RecommendationRow>(
      'SKU',
      'sku',
      row => (
        <Space direction="vertical" size={0}>
          <strong>{row.sku}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.title ?? row.asin} · {row.storeName}
          </Typography.Text>
        </Space>
      ),
      { group: '商品', pin: 'left', width: 230, valueGetter: ({ data }) => data?.sku ?? '' },
    ),
    renderColumn<RecommendationRow>('风险', 'risk', row => <RiskTag risk={row.risk} />, { group: '商品', width: 130, valueGetter: ({ data }) => data?.risk ?? '' }),
    renderColumn<RecommendationRow>('建议补货量', 'recommendedQty', row => qty(row.recommendedQty), {
      group: '数量（件）',
      width: 120,
      ...RIGHT_ALIGNED,
      valueGetter: ({ data }) => data?.recommendedQty ?? null,
    }),
    renderColumn<RecommendationRow>('建议采购量', 'purchaseQty', row => qty(row.purchaseQty), {
      group: '数量（件）',
      width: 120,
      sortable: false,
      ...RIGHT_ALIGNED,
      valueGetter: ({ data }) => data?.purchaseQty ?? null,
    }),
    renderColumn<RecommendationRow>('必断货量', 'unavoidableShortage', row => <ShortageCell row={row} />, {
      group: '数量（件）',
      width: 190,
      sortable: false,
      valueGetter: ({ data }) => data?.unavoidableShortage ?? null,
      valueFormatter: ({ value }) => (value === null || value === undefined ? EMPTY_VALUE : String(value)),
    }),
    renderColumn<RecommendationRow>('下单日', 'orderDate', row => dateCell(row.orderDate), { group: '时间', width: 110, valueGetter: ({ data }) => dateText(data?.orderDate ?? null) }),
    renderColumn<RecommendationRow>('建议发货日（距今）', 'shipDate', row => <ShipDate row={row} />, {
      group: '时间',
      width: 200,
      valueGetter: ({ data }) => (data ? `${data.suggestedShipDate} ${shipInText(data.shipInDays)}` : ''),
    }),
    renderColumn<RecommendationRow>('到仓日', 'arriveDate', row => dateCell(row.arriveDate), { group: '时间', width: 110, valueGetter: ({ data }) => dateText(data?.arriveDate ?? null) }),
    renderColumn<RecommendationRow>('预计断货日', 'stockoutDate', row => dateCell(row.stockoutDate), {
      group: '时间',
      width: 120,
      sortable: false,
      valueGetter: ({ data }) => dateText(data?.stockoutDate ?? null),
    }),
    renderColumn<RecommendationRow>('预测来源', 'override', row => <OverrideCell row={row} />, {
      group: '依据',
      width: 190,
      sortable: false,
      valueGetter: ({ data }) => data?.appliedOverride.length ?? 0,
    }),
    renderColumn<RecommendationRow>('亚马逊建议', 'amazon', row => (row.amazon.qty === null ? <Typography.Text type="secondary">尚无记录</Typography.Text> : qty(row.amazon.qty)), {
      group: '依据',
      width: 120,
      sortable: false,
      ...RIGHT_ALIGNED,
      valueGetter: ({ data }) => data?.amazon.qty ?? null,
    }),
    renderColumn<RecommendationRow>('置信度', 'confidence', row => <ConfidenceTag value={row.confidence} />, {
      group: '依据',
      width: 90,
      sortable: false,
      valueGetter: ({ data }) => data?.confidence ?? null,
    }),
    renderColumn<RecommendationRow>(
      '已做动作',
      'actions',
      row =>
        row.actions.length === 0 ? (
          <Typography.Text type="secondary">待处理</Typography.Text>
        ) : (
          <Space size={2} wrap>
            {row.actions.map(action => (
              <Tag
                key={`${action.action}-${action.createdAt}`}
                bordered={false}
                color={action.status === 'PENDING_TARGET' ? 'default' : 'blue'}
                title={action.status === 'PENDING_TARGET' ? '以前只登记了意向、没有生成单据；可以在补货建议页的“补建入仓草稿”里补建' : undefined}
              >
                {REPLENISH_ACTION_LABEL[action.action]}
                {action.finalQty === null ? '' : ` ${action.finalQty}`}
                {action.status === 'PENDING_TARGET' ? '（待补建）' : ''}
              </Tag>
            ))}
          </Space>
        ),
      { width: 220, sortable: false, valueGetter: ({ data }) => data?.actions.length ?? 0 },
    ),
    {
      headerName: '模拟',
      colId: 'simulate',
      pin: 'right',
      width: 90,
      sortable: false,
      resizable: false,
      valueGetter: () => null,
      cellRenderer: ({ data }: Cell) =>
        data ? (
          <Button size="small" type="link" data-no-row-open onClick={() => onSimulate(data)}>
            模拟
          </Button>
        ) : null,
    },
  ]
}
