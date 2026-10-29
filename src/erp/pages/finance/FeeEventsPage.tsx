import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Input, Select, Space, Tabs } from 'antd'
import {
  FEE_CATEGORIES,
  FEE_CATEGORY_LABEL,
  FEE_CATEGORY_NOTE,
  FEE_DEFAULT_DAYS,
  FEE_TRANSACTION_STATUSES,
  RECONCILIATION_LABEL,
  feeTransactionStatusLabel,
  type FeeCategory,
  type FeeCategorySummary,
  type FeeEventListResponse,
  type FeeEventRow,
  type FeeEventSummaryResponse,
  type ReconciliationStatus,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FreshnessBar, MassiveGrid, PageHeader, type CursorFetcher } from '../../components'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { ExportAction } from './FeeActions'
import { feeColumns } from './fee-columns'
import { FeeEvidenceDrawer } from './FeeEvidenceDrawer'

// 费用事件（P2b-05，07 章 7.5；P6-28 迁到 MassiveGrid）：财务交易拆出的每条费用明细与两份费用报告落成的费用事件，按 9 个类别分页签；
// 每个页签显示笔数、按币种分别合计的金额与标记差异的笔数；可按交易状态、对账状态、关键词筛选；每行可查看证据、标记差异、写对账备注；可发起导出。
// 分类是按名称关键字判断的，不是亚马逊的官方分类（页签说明里写明）；没有数据写“尚无记录”，没有交易状态的报告类明细写“无交易状态”。
// 列表用游标无限滚动（每块 100 行）；接口没有排序参数，所以列头不排序。

const STATUS_OPTIONS = FEE_TRANSACTION_STATUSES.map(value => ({ value, label: feeTransactionStatusLabel(value) ?? value }))
const RECONCILIATION_OPTIONS = (['UNRECONCILED', 'DISCREPANCY', 'RECONCILED'] as ReconciliationStatus[]).map(value => ({ value, label: RECONCILIATION_LABEL[value] }))

type Filters = { status?: string; reconciliation?: string; q?: string }
type ListMeta = Pick<FeeEventListResponse, 'freshness' | 'range' | 'note'>

function Pick({
  label,
  value,
  options,
  onChange,
  width = 150,
}: {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear style={{ width }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}

function SummaryLine({ summary }: { summary: FeeCategorySummary | undefined }) {
  if (!summary) return null
  if (summary.count === 0) return <Muted>所选范围内这一类尚无记录</Muted>
  return (
    <Space size={16} wrap>
      <span>
        共 <span className="erp-num">{summary.count}</span> 笔
      </span>
      <span>
        合计：
        {summary.totals.map((total, index) => (
          <span key={total.currency}>
            {index > 0 ? '；' : ''}
            {money(total.amount, total.currency)}
          </span>
        ))}
      </span>
      <span>
        标记有差异 <span className="erp-num">{summary.discrepancyCount}</span> 笔
      </span>
    </Space>
  )
}

export default function FeeEventsPage() {
  const { canPermission } = useSession()
  const { apiParams } = useScope()
  const [category, setCategory] = useState<FeeCategory>('FULFILLMENT')
  const [filters, setFilters] = useState<Filters>({})
  const [evidence, setEvidence] = useState<FeeEventRow | null>(null)
  const [meta, setMeta] = useState<ListMeta | null>(null)
  // 标记差异、写备注之后要让表格从第一块重新取数：把计数放进 resetKey。
  const [refreshNonce, setRefreshNonce] = useState(0)
  const set = (patch: Filters) => setFilters(current => ({ ...current, ...patch }))
  const summary = useApiQuery<FeeEventSummaryResponse>({ domain: 'list', path: '/finance/events/summary', params: { ...filters } })
  const filtered = Object.values(filters).some(Boolean)
  const byCategory = new Map(summary.data?.categories.map(item => [item.category, item]))

  const refresh = useCallback(() => {
    void summary.refetch()
    setRefreshNonce(value => value + 1)
    // summary.refetch 的引用稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const columns = useMemo(() => feeColumns({ canOrders: canPermission('orders.read'), onEvidence: setEvidence, onChanged: refresh }), [canPermission, refresh])
  const fetchPage = useCallback<CursorFetcher<FeeEventRow>>(
    async ({ cursor, limit, signal }) => {
      const path = buildPath('/finance/events', { ...apiParams, ...filters, category, pageSize: limit, cursor: cursor ?? undefined })
      const data = await apiFetch<FeeEventListResponse>(path, { signal })
      // 范围、新鲜度与说明以第一块为准
      if (cursor === null) setMeta({ freshness: data.freshness, range: data.range, note: data.note })
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, filters, category],
  )

  return (
    <div>
      <PageHeader
        title="费用事件"
        description="亚马逊物流相关的每一笔费用明细：配送费、佣金、仓储费、库龄附加费、入仓配置费、移除与弃置费、退款、赔付与其他调整。可以标记与结算单对不上的费用、写对账备注，并查看每笔费用的来源交易。"
      />
      <Card size="small">
        <FreshnessBar freshness={meta?.freshness} />
        {meta?.range.defaulted ? (
          <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前显示 ${meta.range.from} 至 ${meta.range.to} 的费用（最近 ${FEE_DEFAULT_DAYS} 天）`} />
        ) : null}
        <Tabs
          activeKey={category}
          onChange={key => setCategory(key as FeeCategory)}
          items={FEE_CATEGORIES.map(key => {
            const item = byCategory.get(key)
            return { key, label: item ? `${FEE_CATEGORY_LABEL[key]}（${item.count}）` : FEE_CATEGORY_LABEL[key] }
          })}
        />
        <Alert type="info" style={{ marginBottom: 8 }} message={FEE_CATEGORY_NOTE[category]} description={<SummaryLine summary={byCategory.get(category)} />} />
        <Space wrap style={{ margin: '8px 0' }}>
          <Input.Search
            allowClear
            style={{ width: 280 }}
            placeholder="搜索订单号、结算单号、交易编号、ASIN、SKU（开头匹配）"
            aria-label="搜索费用事件"
            onSearch={value => set({ q: value.trim() || undefined })}
          />
          <Pick label="交易状态" value={filters.status} options={STATUS_OPTIONS} onChange={value => set({ status: value })} />
          <Pick label="对账状态" value={filters.reconciliation} options={RECONCILIATION_OPTIONS} onChange={value => set({ reconciliation: value })} />
          <ExportAction range={meta?.range} filters={{ category, ...filters }} />
        </Space>
        <MassiveGrid<FeeEventRow>
          gridId="finance.fee-events"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([apiParams, category, filters, refreshNonce])}
          appliedFilterCount={Object.values(filters).filter(Boolean).length}
          emptyState={{
            kind: 'empty',
            domain: '费用事件',
            prerequisite: filtered ? '没有符合条件的费用事件；可以放宽筛选条件或扩大日期范围。' : (meta?.note ?? '所选日期范围内尚无费用事件记录；店铺授权并完成财务交易同步后显示。'),
          }}
          height={560}
        />
      </Card>
      <FeeEvidenceDrawer row={evidence} onClose={() => setEvidence(null)} />
    </div>
  )
}
