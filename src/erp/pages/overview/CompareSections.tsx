import { useMemo, useState, type ReactNode } from 'react'
import { Segmented, Tooltip, Typography } from 'antd'
import {
  RANK_BY,
  RANK_BY_LABEL,
  type AsinRankResponse,
  type AsinRankRow,
  type DashState,
  type RankBy,
  type StoreCompareResponse,
  type StoreCompareRow,
  type VolatilityResponse,
  type VolatilityRow,
} from '@nova/api-contracts'
import { Delta, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { DetailGrid } from '../orders/DetailGrid'
import { COMPARE_LABEL, STATE_TEXT, Section, StateNote } from './dash-parts'

// 店铺经营对比与 ASIN 排名（04 章 4.1 第 5、6 项）。P6-28 第 8 批起改用 LocalGrid 骨架（接口一次返回整份数据）。
// 未接入的列（利润、广告、库存风险、账户健康）整列如实写“尚未接入”，不显示 0；销售额条按本表最大值缩放。

const GREY = 'var(--ant-color-text-quaternary)'
const money = (value: number | null) => (value === null ? '—' : formatMoney(value, 'USD', { digits: 2 }))

const col = <T extends object>(title: string, key: string, width: number, render: (row: T) => ReactNode, extra: ErpColDef<T> = {}) =>
  renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: (row: T) => ReactNode) => col<T>(title, key, width, render, RIGHT_ALIGNED)

/** 某一列未接入时的单元格：写状态，悬停看原因。 */
function Absent({ state, note }: { state: DashState; note?: string | null }) {
  return (
    <Tooltip title={note ?? undefined}>
      <span style={{ color: GREY }}>{STATE_TEXT[state]}</span>
    </Tooltip>
  )
}

function storeColumns(data: StoreCompareResponse, max: number): ErpColDef<StoreCompareRow>[] {
  const label = data.compare ? COMPARE_LABEL[data.compare.mode] : null
  const cell = (state: DashState, note: string | null, render: (row: StoreCompareRow) => ReactNode) => (row: StoreCompareRow) => (state === 'OK' ? render(row) : <Absent state={state} note={note} />)
  return [
    col<StoreCompareRow>('店铺', 'storeName', 160, row => row.storeName),
    col<StoreCompareRow>(
      '销售额',
      'sales',
      190,
      row => (
        <div style={{ minWidth: 150 }}>
          <span className="erp-num">{money(row.sales)}</span>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--ant-color-primary)', width: `${max > 0 ? Math.max(2, (row.sales / max) * 100) : 0}%` }} />
        </div>
      ),
      { autoHeight: true },
    ),
    ...(label ? [col<StoreCompareRow>(label, 'change', 120, row => <Delta label="" ratio={row.salesChange} />)] : []),
    num<StoreCompareRow>(
      '净利润',
      'profit',
      110,
      cell(data.columns.profit, data.notes.profit, row => <span className="erp-num">{money(row.profit)}</span>),
    ),
    num<StoreCompareRow>(
      '利润率',
      'margin',
      90,
      cell(data.columns.profit, data.notes.profit, row => formatPercent(row.margin, { digits: 1 })),
    ),
    num<StoreCompareRow>(
      '广告占比',
      'ads',
      100,
      cell(data.columns.ads, data.notes.ads, row => formatPercent(row.adsShare, { digits: 1 })),
    ),
    col<StoreCompareRow>('库存风险', 'inventory', 100, () => <Absent state={data.columns.inventoryRisk} note={data.notes.inventoryRisk} />),
    col<StoreCompareRow>('账户健康', 'health', 100, () => <Absent state={data.columns.accountHealth} note={data.notes.accountHealth} />),
  ]
}

export function StoreCompareSection() {
  const query = useApiQuery<StoreCompareResponse>({ domain: 'analytics', path: '/overview/store-compare' })
  const data = query.data
  const max = Math.max(0, ...(data?.rows.map(row => row.sales) ?? []))
  const columns = useMemo(() => (data ? storeColumns(data, max) : []), [data, max])
  return (
    <Section title="店铺经营对比" testId="store-compare-section">
      <DetailGrid<StoreCompareRow>
        gridId="overview.store-compare"
        height={Math.min(420, 110 + 48 * (data?.rows.length ?? 2))}
        columns={columns}
        rows={data?.rows}
        getRowId={row => row.storeId}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '店铺', prerequisite: '授权亚马逊账号并完成首次同步后，这里会按店铺对比经营数据。' }}
      />
    </Section>
  )
}

const rankColumns = (data: AsinRankResponse): ErpColDef<AsinRankRow>[] => {
  const profit = data.state === 'OK'
  return [
    col<AsinRankRow>('ASIN', 'asin', 130, row => row.asin),
    col<AsinRankRow>('SKU', 'sku', 140, row => row.sku ?? '—'),
    num<AsinRankRow>('件数', 'units', 90, row => formatNumber(row.units)),
    num<AsinRankRow>('销售额', 'sales', 110, row => <span className="erp-num">{money(row.sales)}</span>),
    num<AsinRankRow>('净利润', 'profit', 110, row => (profit ? <span className="erp-num">{money(row.profit)}</span> : <Absent state={data.state} note={data.note} />)),
    num<AsinRankRow>('利润率', 'margin', 90, row => (profit ? formatPercent(row.margin, { digits: 1 }) : '—')),
    num<AsinRankRow>('利润变化', 'profitChange', 110, row => (profit && row.profitChange !== null ? <span className="erp-num">{money(row.profitChange)}</span> : '—')),
  ]
}

// 波动异常（P6-28）：本期、上期、上上期三个等长首尾相接的期间，列出销售额连续两期下降的 ASIN；与对比期选择无关。
const volatilityColumns = (data: VolatilityResponse): ErpColDef<VolatilityRow>[] => [
  col<VolatilityRow>('ASIN', 'asin', 130, row => row.asin),
  col<VolatilityRow>('SKU', 'sku', 140, row => row.sku ?? '—'),
  num<VolatilityRow>(`上上期销售额（${data.earlier.from} 至 ${data.earlier.to}）`, 'earlierSales', 190, row => <span className="erp-num">{money(row.earlierSales)}</span>),
  num<VolatilityRow>(`上期销售额（${data.previous.from} 至 ${data.previous.to}）`, 'previousSales', 190, row => <span className="erp-num">{money(row.previousSales)}</span>),
  num<VolatilityRow>('本期销售额', 'sales', 120, row => <span className="erp-num">{money(row.sales)}</span>),
  num<VolatilityRow>('上期较上上期', 'previousChange', 120, row => <Delta label="" ratio={row.previousChange} />),
  num<VolatilityRow>('本期较上期', 'salesChange', 120, row => <Delta label="" ratio={row.salesChange} />),
  num<VolatilityRow>('累计下降', 'totalDrop', 110, row => <span className="erp-num">{money(row.totalDrop)}</span>),
]

export function VolatilitySection() {
  const query = useApiQuery<VolatilityResponse>({ domain: 'analytics', path: '/overview/volatility' })
  const data = query.data
  const columns = useMemo(() => (data ? volatilityColumns(data) : []), [data])
  return (
    <Section title="波动异常" testId="volatility-section">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        三个等长期间首尾相接（本期、上期、上上期），列出销售额连续两期下降的 ASIN，按累计下降金额排序。
        {data?.candidateLimit ? `只在上上期销售额靠前的 ${data.candidateLimit} 个 ASIN 内检查。` : ''}
      </Typography.Paragraph>
      {data && data.state !== 'OK' ? <StateNote state={data.state} note={data.note} /> : null}
      <DetailGrid<VolatilityRow>
        gridId="overview.volatility"
        height={Math.min(480, 110 + 48 * (data?.rows.length ?? 2))}
        columns={columns}
        rows={data?.rows}
        getRowId={row => row.asin}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '波动异常', prerequisite: '这三个期间里没有销售额连续两期下降的 ASIN。' }}
      />
    </Section>
  )
}

export function AsinRankSection() {
  const [rankBy, setRankBy] = useState<RankBy>('sales')
  const query = useApiQuery<AsinRankResponse>({ domain: 'analytics', path: '/overview/asin-rank', params: { rankBy } })
  const data = query.data
  const columns = useMemo(() => (data ? rankColumns(data) : []), [data])
  const empty = { kind: 'empty' as const, domain: 'ASIN', prerequisite: '订单同步后，这里会按所选指标列出前 10 与后 10。' }
  return (
    <Section
      title="ASIN 排名"
      testId="asin-rank-section"
      extra={<Segmented size="small" value={rankBy} onChange={value => setRankBy(value as RankBy)} options={RANK_BY.map(value => ({ value, label: RANK_BY_LABEL[value] }))} aria-label="排名依据" />}
    >
      {data && data.state !== 'OK' && rankBy !== 'sales' ? <StateNote state={data.state} note={data.note} /> : null}
      {data && data.state === 'OK' && data.top.length > 0 && data.top.every(row => row.profit === null) ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          净利润、利润率、利润变化：尚未接入（或没有“利润”字段权限），表中以“—”表示。
        </Typography.Paragraph>
      ) : null}
      {data && data.candidateLimit ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {RANK_BY_LABEL[rankBy]}只在销售额靠前的 {data.candidateLimit} 个 ASIN 内排名。
        </Typography.Paragraph>
      ) : null}
      {data && data.state !== 'OK' && rankBy !== 'sales' ? null : (
        <>
          <Typography.Text strong>前 10</Typography.Text>
          <DetailGrid<AsinRankRow>
            gridId="overview.asin-rank.top"
            height={460}
            columns={columns}
            rows={data?.top}
            getRowId={row => row.asin}
            loading={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
            emptyState={empty}
          />
          {data && data.bottom.length > 0 ? (
            <>
              <Typography.Text strong>后 10</Typography.Text>
              <DetailGrid<AsinRankRow> gridId="overview.asin-rank.bottom" height={460} columns={columns} rows={data.bottom} getRowId={row => row.asin} emptyState={empty} />
            </>
          ) : null}
        </>
      )}
    </Section>
  )
}
