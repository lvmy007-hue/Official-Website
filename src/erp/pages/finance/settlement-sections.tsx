import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Select, Space, Tag } from 'antd'
import {
  EXCEPTION_CATEGORIES,
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_KINDS,
  EXCEPTION_KIND_LABEL,
  EXCEPTION_STATUSES,
  EXCEPTION_STATUS_LABEL,
  SETTLEMENT_CATEGORIES,
  SETTLEMENT_CATEGORY_LABEL,
  type SettlementBreakdownRow,
  type SettlementDisbursementRow,
  type SettlementDisbursementsResponse,
  type SettlementExceptionRow,
  type SettlementLineRow,
  type SettlementReconciliationResponse,
  type SettlementSummaryResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { LocalGrid, MassiveGrid, type CursorFetcher } from '../../components'
import { buildPath, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { money, timeText } from '../orders/orders-ui'
import { breakdownColumns, disbursementColumns, exceptionColumns, lineColumns, reconExceptionColumns } from './settlements-columns'

// 结算单详情的四个页签（07 章 7.7）：汇总、交易明细、三方核对、打款记录。每个页签切到时才请求自己的接口。

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map(value => ({ value, label: labels[value] }))
const CHECK_COLOR = { PASS: 'success', FAIL: 'error', SKIPPED: 'default' } as const
const CHECK_LABEL = { PASS: '通过', FAIL: '不通过', SKIPPED: '未检查' } as const

export function SummaryTab({ summary }: { summary: SettlementSummaryResponse }) {
  const { settlement } = summary
  const columns = useMemo(() => breakdownColumns(settlement.currency), [settlement.currency])
  if (!summary.hasReport) return <Alert type="info" showIcon message={summary.note ?? '结算报告尚未到达'} data-testid="summary-no-report" />
  return (
    <div>
      <Space size={24} wrap style={{ marginBottom: 12 }} data-testid="summary-categories">
        {summary.categories.map(item => (
          <div key={item.category}>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{item.label}</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{money(item.amount, settlement.currency)}</div>
          </div>
        ))}
      </Space>
      <LocalGrid<SettlementBreakdownRow>
        gridId="finance.settlement.breakdown"
        columns={columns}
        rows={summary.breakdown}
        getRowId={row => `${row.category}|${row.amountType}|${row.amountDescription}`}
        emptyState={{ kind: 'empty', domain: '汇总科目', prerequisite: '这张结算单的结算报告里没有金额明细。' }}
        height={420}
      />
      {summary.breakdownTruncated ? <Muted>科目较多，只显示前 300 行。</Muted> : null}
    </div>
  )
}

/** 游标取数 + 订单读取权限（随响应到达，列用取值函数读，列定义保持稳定）。 */
type DetailPage<R> = { canViewOrders: boolean; items: R[]; pageInfo: { hasMore: boolean; nextCursor: string | null; approxTotal?: number | null }; note?: string | null }
function useDetailFetch<R>(path: string, extra: Record<string, string | undefined>) {
  const canView = useRef(false)
  const [note, setNote] = useState<string | null>(null)
  const key = JSON.stringify(extra)
  const fetchPage = useCallback<CursorFetcher<R>>(
    async ({ cursor, limit, signal }) => {
      const data = await apiFetch<DetailPage<R>>(buildPath(path, { ...extra, pageSize: limit, cursor: cursor ?? undefined }), { signal })
      canView.current = data.canViewOrders
      setNote(data.note ?? null)
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, key],
  )
  return { canView, note, fetchPage, key }
}

export function LinesTab({ id }: { id: string }) {
  const [category, setCategory] = useState<string | undefined>()
  const { canView, note, fetchPage, key } = useDetailFetch<SettlementLineRow>(`/settlements/${encodeURIComponent(id)}/transactions`, { category })
  const columns = useMemo(() => lineColumns(() => canView.current), [canView])
  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="类别"
          aria-label="类别"
          value={category}
          options={options(SETTLEMENT_CATEGORIES, SETTLEMENT_CATEGORY_LABEL)}
          onChange={value => setCategory(value)}
        />
        <Muted>明细来自结算报告，按报告里的行序排列。</Muted>
      </Space>
      <MassiveGrid<SettlementLineRow>
        gridId="finance.settlement.lines"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={key}
        appliedFilterCount={category ? 1 : 0}
        emptyState={{ kind: 'empty', domain: '交易明细', prerequisite: note ?? '尚无交易明细。' }}
        height={520}
      />
    </div>
  )
}
function Amounts({ data }: { data: SettlementReconciliationResponse }) {
  return (
    <Space size={32} wrap data-testid="recon-amounts">
      <div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>官方金额（结算报告，不含保留金）</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{money(data.officialAmount, data.currency)}</div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>系统金额（财务接口交易）</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{money(data.systemAmount, data.currency)}</div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>差额（官方 − 系统）</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{money(data.diffAmount, data.currency)}</div>
      </div>
    </Space>
  )
}

function ExceptionsTable({ id }: { id: string }) {
  const [filters, setFilters] = useState<{ kind?: string; category?: string; status?: string }>({})
  const { canView, note, fetchPage, key } = useDetailFetch<SettlementExceptionRow>(`/settlements/${encodeURIComponent(id)}/exceptions`, filters)
  const columns = useMemo(() => exceptionColumns(() => canView.current), [canView])
  const set = (patch: typeof filters) => setFilters(current => ({ ...current, ...patch }))
  return (
    <div>
      <Space wrap style={{ margin: '8px 0' }}>
        <Select
          allowClear
          style={{ width: 170 }}
          placeholder="异常类型"
          aria-label="异常类型"
          value={filters.kind}
          options={options(EXCEPTION_KINDS, EXCEPTION_KIND_LABEL)}
          onChange={value => set({ kind: value })}
        />
        <Select
          allowClear
          style={{ width: 130 }}
          placeholder="差异分类"
          aria-label="差异分类"
          value={filters.category}
          options={options(EXCEPTION_CATEGORIES, EXCEPTION_CATEGORY_LABEL)}
          onChange={value => set({ category: value })}
        />
        <Select
          allowClear
          style={{ width: 120 }}
          placeholder="状态"
          aria-label="异常状态"
          value={filters.status}
          options={options(EXCEPTION_STATUSES, EXCEPTION_STATUS_LABEL)}
          onChange={value => set({ status: value })}
        />
      </Space>
      <MassiveGrid<SettlementExceptionRow>
        gridId="finance.settlement.exceptions"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={key}
        appliedFilterCount={Object.values(filters).filter(Boolean).length}
        emptyState={{ kind: 'empty', domain: '核对异常', prerequisite: note ?? '没有核对异常。' }}
        height={420}
      />
    </div>
  )
}
function ReconExceptions({ data }: { data: SettlementReconciliationResponse }) {
  const columns = useMemo(() => reconExceptionColumns(data.currency), [data.currency])
  return (
    <LocalGrid<SettlementReconciliationResponse['exceptions'][number]>
      gridId="finance.settlement.recon-exceptions"
      columns={columns}
      rows={data.exceptions}
      getRowId={row => row.category}
      emptyState={{ kind: 'empty', domain: '差异分类', prerequisite: '没有待处理的差异。' }}
      height={260}
    />
  )
}

export function ReconciliationTab({ id }: { id: string }) {
  const query = useApiQuery<SettlementReconciliationResponse>({ domain: 'list', path: `/settlements/${encodeURIComponent(id)}/reconciliation`, scoped: false })
  const data = query.data
  if (query.error)
    return (
      <Alert
        type="error"
        showIcon
        message="三方核对结果加载失败"
        action={
          <Button size="small" type="link" onClick={() => void query.refetch()}>
            重试
          </Button>
        }
      />
    )
  if (!data) return <Muted>加载中…</Muted>
  return (
    <div>
      {data.pendingNote ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message={data.pendingNote} data-testid="recon-pending" /> : null}
      {data.computedAt === null && !data.pendingNote ? (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="还没有核对结果：核对每 6 小时运行一次，这张结算单没有结算周期时无法核对" />
      ) : null}
      <Amounts data={data} />
      <Card size="small" title="核对项" style={{ marginTop: 12 }}>
        {data.checks.length === 0 ? (
          <Muted>尚无核对项</Muted>
        ) : (
          <div data-testid="recon-checks">
            {data.checks.map(check => (
              <div key={check.key} style={{ margin: '4px 0' }}>
                <Tag color={CHECK_COLOR[check.state]} bordered={false}>
                  {CHECK_LABEL[check.state]}
                </Tag>
                <strong>{check.label}</strong>：{check.detail}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <Muted>容差 {data.tolerance}（结算币种），差额不超过它算对平；这是我们设定的数，不是亚马逊公布的。</Muted>
        </div>
        <div>核对时间：{timeText(data.computedAt)}</div>
      </Card>
      <Card size="small" title={`差异分类（待处理 ${data.openExceptions} 条）`} style={{ marginTop: 12 }}>
        {data.exceptions.length === 0 ? <Muted>没有待处理的差异</Muted> : <ReconExceptions data={data} />}
        {data.exceptionsTruncated ? <Muted>异常太多，只保存并显示金额最大的前 2000 条。</Muted> : null}
      </Card>
      <Card size="small" title="异常清单" style={{ marginTop: 12 }}>
        <ExceptionsTable id={id} />
      </Card>
    </div>
  )
}

export function DisbursementsTab({ id }: { id: string }) {
  const query = useApiQuery<SettlementDisbursementsResponse>({ domain: 'list', path: `/settlements/${encodeURIComponent(id)}/disbursements`, scoped: false })
  const rows = useMemo(() => query.data?.items ?? [], [query.data])
  return (
    <div>
      <LocalGrid<SettlementDisbursementRow>
        gridId="finance.settlement.disbursements"
        columns={disbursementColumns}
        rows={rows}
        getRowId={row => row.source}
        emptyState={{ kind: 'empty', domain: '打款记录', prerequisite: query.isFetching ? '加载中…' : query.error ? '打款记录加载失败，请刷新重试。' : '尚无打款记录。' }}
        height={260}
      />
      {query.data ? <Alert type="info" showIcon style={{ marginTop: 12 }} message={query.data.manual.note} data-testid="manual-note" /> : null}
    </div>
  )
}
