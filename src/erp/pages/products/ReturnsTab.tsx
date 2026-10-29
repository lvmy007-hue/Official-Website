import { useMemo } from 'react'
import { Alert, Card, Descriptions, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Asin360ReimbursementItem, Asin360ReturnDispositionRow, Asin360ReturnRecent, Asin360ReturnsResponse, ReturnReasonRow } from '@nova/api-contracts'
import { ChartPanel, SimpleGrid } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { LiveLink, Muted, StateBlock } from '../inventory/inventory-ui'
import { buildTrendOption } from '../returns/returns-options'
import { DispositionTag, rateText } from '../returns/returns-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'

// 退货页签（05 章 5.2）：退货率趋势 → 原因分布 → 处置分布 → 最近退货 → 关联赔付机会与案件 → 类目退货主题。
// 退货按店铺 × ASIN 统计（同一 ASIN 的多个 SKU 合在一起，与销售汇总口径一致）；退货率 = 退货件数 ÷ 同期销售件数，没有销售汇总时写“尚无记录”，不写 0%。
// 类目退货主题要等评价与反馈上线（P4-13）。

const units = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)
const share = (value: number) => <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>

const reasonColumns: ColumnsType<ReturnReasonRow> = [
  { title: '退货原因', dataIndex: 'label', render: (value: string, row) => <span title={row.reason}>{value}</span> },
  { title: '退货件数', dataIndex: 'units', width: 110, align: 'right', render: (value: number) => units(value) },
  { title: '占比', dataIndex: 'share', width: 90, align: 'right', render: (value: number) => share(value) },
]

const dispositionColumns: ColumnsType<Asin360ReturnDispositionRow> = [
  { title: '处置', dataIndex: 'label' },
  { title: '退货件数', dataIndex: 'units', width: 110, align: 'right', render: (value: number) => units(value) },
  { title: '占比', dataIndex: 'share', width: 90, align: 'right', render: (value: number) => share(value) },
]

const recentColumns: ColumnsType<Asin360ReturnRecent> = [
  { title: '退货日期', dataIndex: 'returnDate', width: 110, render: (value: string) => <span className="erp-num">{value.slice(0, 10)}</span> },
  {
    title: '订单号',
    dataIndex: 'amazonOrderId',
    width: 190,
    render: (value: string, row) => (
      <LiveLink component="ReturnDetailPage" id={row.id}>
        <span className="erp-num">{value}</span>
      </LiveLink>
    ),
  },
  { title: 'SKU', dataIndex: 'sku', width: 150, render: (value: string) => <span className="erp-num">{value}</span> },
  { title: '数量', dataIndex: 'quantity', width: 70, align: 'right', render: (value: number) => units(value) },
  { title: '原因', dataIndex: 'reasonLabel', render: (value: string | null) => value ?? <Muted>未提供原因</Muted> },
  { title: '处置', key: 'disposition', width: 130, render: (_value, row) => <DispositionTag view={row.disposition} /> },
]

const reimbursementColumns: ColumnsType<Asin360ReimbursementItem> = [
  { title: '规则', dataIndex: 'ruleLabel', width: 190 },
  { title: '状态', dataIndex: 'statusLabel', width: 110 },
  {
    title: '预估金额',
    key: 'amount',
    width: 120,
    align: 'right',
    render: (_value, row) => (row.estimatedAmount === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(row.estimatedAmount, row.currency || 'USD', { digits: 2 })}</span>),
  },
  { title: '数量', dataIndex: 'qty', width: 70, align: 'right', render: (value: number | null) => units(value) },
  { title: '申请截止', dataIndex: 'deadlineAt', width: 110, render: (value: string | null) => (value ? <span className="erp-num">{value.slice(0, 10)}</span> : <Muted>尚无记录</Muted>) },
  {
    title: '案件',
    key: 'case',
    render: (_value, row) =>
      row.caseId && row.caseNo ? (
        <span>
          <LiveLink component="ReimbursementDetailPage" id={row.caseId}>
            {row.caseNo}
          </LiveLink>
          {row.caseStatusLabel ? <Muted>（{row.caseStatusLabel}）</Muted> : null}
        </span>
      ) : (
        <Muted>尚未立案</Muted>
      ),
  },
]

function Body({ data }: { data: Asin360ReturnsResponse }) {
  const option = useMemo(() => buildTrendOption(data.trend, data.bucket), [data.trend, data.bucket])
  const empty = data.state === 'NO_DATA'
  const none = { kind: 'empty' as const, domain: '退货', prerequisite: data.note ?? '所选日期范围内这个 ASIN 尚无退货记录。' }
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Descriptions size="small" bordered column={{ xs: 1, md: 4 }} data-testid="asin360-return-totals">
        <Descriptions.Item label="统计范围">
          {data.range.from} 至 {data.range.to}
          {data.range.defaulted ? '（默认最近 90 天）' : ''}
        </Descriptions.Item>
        <Descriptions.Item label="退货件数">{units(data.totals.returnedUnits)}</Descriptions.Item>
        <Descriptions.Item label="销售件数">{units(data.totals.soldUnits)}</Descriptions.Item>
        <Descriptions.Item label="退货率">{rateText(data.totals.rate)}</Descriptions.Item>
      </Descriptions>
      {empty ? <Alert type="info" showIcon message="所选范围内没有这个 ASIN 的退货记录" description={data.note ?? undefined} /> : null}
      {data.truncated ? <Alert type="warning" showIcon message="趋势可能不完整" description="退货明细超过读取上限，趋势只用了最近的部分；原因与处置分布是精确的。请缩小日期范围。" /> : null}
      <ChartPanel title="退货件数与退货率趋势" ariaLabel="商品退货趋势图" option={option} emptyState={empty ? none : undefined} />
      <Card size="small" title="退货原因分布" data-testid="asin360-return-reasons">
        <SimpleGrid<ReturnReasonRow> gridId="products.returns-reasons" columns={reasonColumns} rows={data.reasons} rowKey={row => row.reason} emptyState={none} />
      </Card>
      <Card size="small" title="处置分布" data-testid="asin360-return-dispositions">
        <SimpleGrid<Asin360ReturnDispositionRow> gridId="products.returns-dispositions" columns={dispositionColumns} rows={data.dispositions} rowKey={row => row.group} emptyState={none} />
      </Card>
      <Card size="small" title="最近退货" data-testid="asin360-return-recent">
        <SimpleGrid<Asin360ReturnRecent> gridId="products.returns-recent" columns={recentColumns} rows={data.recent} rowKey={row => row.id} emptyState={none} />
      </Card>
      <Card size="small" title="关联赔付（退款后未收到退货、退货被处置为损坏）" data-testid="asin360-return-reimbursements">
        <StateBlock state={data.reimbursements.state} note={data.reimbursements.note}>
          <SimpleGrid<Asin360ReimbursementItem>
            gridId="products.returns-tab"
            columns={reimbursementColumns}
            rows={data.reimbursements.items}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '关联赔付', prerequisite: data.reimbursements.note ?? '这个 ASIN 目前没有退货类的赔付机会。' }}
          />
        </StateBlock>
      </Card>
      <Alert type="info" showIcon message="类目退货主题：尚未接入" description={data.categoryThemes.note} data-testid="asin360-category-themes" />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function ReturnsTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360ReturnsResponse>(id, 'returns', { scoped: true })
  return <QueryBody query={query}>{data => <Body data={data} />}</QueryBody>
}
