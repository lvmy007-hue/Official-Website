import { useMemo, useState } from 'react'
import { Segmented, Select, Space, Tag } from 'antd'
import {
  MATRIX_METRICS,
  MATRIX_METRIC_LABEL,
  type MatrixCell,
  type MatrixMetric,
  type MatrixRow,
  type ParentMatrixResponse,
  type ParentTrafficResponse,
  type ParentTrendResponse,
  type TrafficRow,
} from '@nova/api-contracts'
import { ChartPanel, LocalGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { TREND_FIELD_CHOICES, buildParentTrendOption, buildTrafficOption, heatColor, type TrendField } from './asin-analytics-options'
import { AsinFigure, RiskBadge, StateNote } from './asin-analytics-ui'
import { Frame } from './business-reports-ui'

// 父体详情的前三个页签（P4-03）：子体贡献矩阵（含变体属性透视）、子体趋势、流量分布。数据都是名下子体相加，没有记录写“尚无记录”。

export const useParentQuery = <T,>(parentAsin: string, tab: string, params: Record<string, string | undefined> = {}) =>
  useApiQuery<T>({ domain: 'analytics', path: `/analytics/parents/${encodeURIComponent(parentAsin)}/${tab}`, params })

type PivotRow = { row: string }

// 热力着色：没有颜色（没数据或不着色）时不给样式。
const fill = (color: string | undefined) => (color ? { background: color } : null)

const METRIC_FIELD: Record<MatrixMetric, 'sales' | 'conversion' | null> = { sales: 'sales', conversion: 'conversion', risk: null }

function rowColumns(metric: MatrixMetric, data: ParentMatrixResponse): ErpColDef<MatrixRow>[] {
  const heat = (value: number | null) => fill(metric === 'sales' || metric === 'conversion' ? heatColor(value, data.scale) : undefined)
  return [
    renderColumn<MatrixRow>(
      '子体',
      'asin',
      row => (
        <span className="erp-cell-stack">
          {row.productId ? (
            <LiveLink component="Asin360Page" id={row.productId}>
              {row.title ?? row.asin}
            </LiveLink>
          ) : (
            <span>{row.title ?? <Muted>目录里没有这个 ASIN</Muted>}</span>
          )}
          <span className="erp-cell-sub erp-num">{row.asin}</span>
        </span>
      ),
      { width: 260, pin: 'left' },
    ),
    renderColumn<MatrixRow>(
      '变体属性',
      'attributes',
      row =>
        Object.keys(row.attributes).length === 0 ? (
          <Muted>目录未给出</Muted>
        ) : (
          <Space size={[4, 4]}>
            {Object.entries(row.attributes).map(([name, value]) => (
              <Tag key={name} bordered={false} style={{ marginInlineEnd: 0 }}>
                {name}：{value}
              </Tag>
            ))}
          </Space>
        ),
      { width: 220 },
    ),
    renderColumn<MatrixRow>('销售额', 'sales', row => <AsinFigure metric="sales" value={row.sales} />, {
      width: 110,
      ...RIGHT_ALIGNED,
      cellStyle: params => heat((params.data as MatrixRow | undefined)?.sales ?? null),
    }),
    renderColumn<MatrixRow>('占父体', 'share', row => (row.share === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(row.share, { digits: 1 })}</span>), {
      width: 90,
      ...RIGHT_ALIGNED,
    }),
    renderColumn<MatrixRow>('会话数', 'sessions', row => <AsinFigure metric="sessions" value={row.sessions} />, { width: 90, ...RIGHT_ALIGNED }),
    renderColumn<MatrixRow>('转化率', 'conversion', row => <AsinFigure metric="conversion" value={row.conversion} />, {
      width: 90,
      ...RIGHT_ALIGNED,
      cellStyle: params => heat((params.data as MatrixRow | undefined)?.conversion ?? null),
    }),
    renderColumn<MatrixRow>(
      '库存风险',
      'risk',
      row => (data.riskState.state === 'OK' || row.risk ? <RiskBadge risk={row.risk} /> : <Muted>{data.riskState.state === 'RESTRICTED' ? '无权查看' : '尚无记录'}</Muted>),
      {
        width: 150,
      },
    ),
  ]
}
function PivotGrid({ data, metric, scale }: { data: ParentMatrixResponse; metric: MatrixMetric; scale: { min: number; max: number } | null }) {
  const { pivot } = data
  const field = METRIC_FIELD[metric]
  const columns = useMemo<ErpColDef<PivotRow>[]>(() => {
    const cellOf = (row: string, col: string): MatrixCell | undefined => pivot.cells.find(cell => cell.row === row && cell.col === col)
    return [
      renderColumn<PivotRow>(pivot.rowDim ?? '', 'row', item => item.row, { width: 130, pin: 'left' }),
      ...pivot.colValues.map(col =>
        renderColumn<PivotRow>(
          col,
          `col:${col}`,
          item => {
            const cell = cellOf(item.row, col)
            if (!cell) return <Muted>—</Muted>
            return metric === 'risk' ? <RiskBadge risk={cell.risk} /> : <AsinFigure metric={metric} value={cell[metric]} />
          },
          {
            width: 110,
            ...RIGHT_ALIGNED,
            cellStyle: params => fill(field && params.data ? heatColor(cellOf((params.data as PivotRow).row, col)?.[field] ?? null, scale) : undefined),
          },
        ),
      ),
    ]
  }, [pivot, metric, field, scale])
  const rows = useMemo<PivotRow[]>(() => pivot.rowValues.map(row => ({ row })), [pivot.rowValues])
  return (
    <LocalGrid<PivotRow>
      gridId="analytics.parent.pivot"
      columns={columns}
      rows={rows}
      getRowId={item => item.row}
      resetKey={JSON.stringify([metric, pivot.rowDim, pivot.colDim])}
      emptyState={{ kind: 'empty', domain: '变体属性透视', prerequisite: '没有可透视的变体属性。' }}
      initialPageSize={50}
      height={320}
    />
  )
}

function MatrixGrid({ data, metric }: { data: ParentMatrixResponse; metric: MatrixMetric }) {
  const columns = useMemo(() => rowColumns(metric, data), [metric, data])
  return (
    <LocalGrid<MatrixRow>
      gridId="analytics.parent.matrix"
      columns={columns}
      rows={data.rows}
      getRowId={row => row.asin}
      resetKey={metric}
      emptyState={{ kind: 'empty', domain: '子体', prerequisite: data.note ?? '这个父体名下还没有子体。' }}
      initialPageSize={50}
      height={420}
    />
  )
}
function Pivot({ data, metric, onPivot }: { data: ParentMatrixResponse; metric: MatrixMetric; onPivot: (rowDim: string, colDim: string) => void }) {
  const { pivot } = data
  const field = METRIC_FIELD[metric]
  const scale = useMemo(() => {
    const values = pivot.cells.map(cell => (field ? cell[field] : null)).filter((value): value is number => value !== null)
    return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) }
  }, [pivot.cells, field])
  if (pivot.state !== 'OK') return <StateNote state={pivot.state} note={pivot.note} testId="parent-pivot-note" />
  const dims = pivot.dimensions.map(value => ({ value, label: value }))
  return (
    <div data-testid="parent-pivot">
      <Space wrap style={{ marginBottom: 8 }}>
        <span>变体属性透视：</span>
        <Select
          size="small"
          style={{ width: 130 }}
          aria-label="透视行维度"
          value={pivot.rowDim ?? undefined}
          options={dims}
          onChange={value => onPivot(value, pivot.colDim && pivot.colDim !== value ? pivot.colDim : (dims.find(item => item.value !== value)?.value ?? value))}
        />
        <span>×</span>
        <Select
          size="small"
          style={{ width: 130 }}
          aria-label="透视列维度"
          disabled={dims.length < 2}
          value={pivot.colDim ?? undefined}
          options={dims}
          onChange={value => onPivot(pivot.rowDim && pivot.rowDim !== value ? pivot.rowDim : (dims.find(item => item.value !== value)?.value ?? value), value)}
        />
        {pivot.note ? <Muted>{pivot.note}</Muted> : null}
      </Space>
      <PivotGrid data={data} metric={metric} scale={scale} />
    </div>
  )
}

export function MatrixTab({ parentAsin }: { parentAsin: string }) {
  const [metric, setMetric] = useState<MatrixMetric>('sales')
  const [pivot, setPivot] = useState<string | undefined>()
  const query = useParentQuery<ParentMatrixResponse>(parentAsin, 'matrix', { metric, pivot })
  return (
    <div data-testid="parent-matrix">
      <Segmented
        aria-label="着色指标"
        value={metric}
        options={MATRIX_METRICS.map(value => ({ value, label: MATRIX_METRIC_LABEL[value] }))}
        onChange={value => setMetric(value as MatrixMetric)}
        style={{ marginBottom: 8 }}
      />
      <Frame query={query} testId="parent-matrix-frame">
        {data => (
          <>
            {metric === 'risk' ? <StateNote state={data.riskState.state} note={data.riskState.note} testId="parent-risk-note" /> : null}
            <MatrixGrid data={data} metric={metric} />
            <div style={{ marginTop: 12 }}>
              <Pivot data={data} metric={metric} onPivot={(rowDim, colDim) => setPivot(`${rowDim},${colDim}`)} />
            </div>
          </>
        )}
      </Frame>
    </div>
  )
}

function TrendBody({ data }: { data: ParentTrendResponse }) {
  const [field, setField] = useState<TrendField>('sales')
  const option = useMemo(() => buildParentTrendOption(data, field), [data, field])
  const empty = data.series.every(series => series[field].every(value => value === null)) && (!data.others || data.others[field].every(value => value === null))
  return (
    <ChartPanel
      title="子体趋势"
      ariaLabel="父体名下子体逐日堆叠趋势图"
      option={option}
      height={320}
      extra={<Select size="small" style={{ width: 120 }} aria-label="趋势指标" value={field} options={TREND_FIELD_CHOICES} onChange={setField} />}
      emptyState={empty ? { kind: 'empty', domain: '子体趋势', prerequisite: data.note ?? '所选范围内这些子体没有逐日记录。' } : undefined}
    />
  )
}

export function TrendTab({ parentAsin }: { parentAsin: string }) {
  const query = useParentQuery<ParentTrendResponse>(parentAsin, 'trend')
  return (
    <Frame query={query} testId="parent-trend">
      {data => <TrendBody data={data} />}
    </Frame>
  )
}

const pointsText = (value: number | null) => (value === null ? null : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} 个百分点`)

function trafficColumns(compare: boolean): ErpColDef<TrafficRow>[] {
  const share = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)
  return [
    renderColumn<TrafficRow>('子体', 'asin', row => <span>{row.title ? `${row.title}（${row.asin}）` : row.asin}</span>, { width: 260, pin: 'left' }),
    renderColumn<TrafficRow>('会话数', 'sessions', row => <AsinFigure metric="sessions" value={row.sessions} />, { width: 100, ...RIGHT_ALIGNED }),
    renderColumn<TrafficRow>('占比', 'share', row => share(row.share), { width: 90, ...RIGHT_ALIGNED }),
    ...(compare
      ? [
          renderColumn<TrafficRow>('对比期会话', 'cs', row => <AsinFigure metric="sessions" value={row.compareSessions} />, { width: 110, ...RIGHT_ALIGNED }),
          renderColumn<TrafficRow>('对比期占比', 'cshare', row => share(row.compareShare), { width: 110, ...RIGHT_ALIGNED }),
          renderColumn<TrafficRow>('占比变化', 'change', row => pointsText(row.shareChange) ?? <Muted>尚无记录</Muted>, { width: 140, ...RIGHT_ALIGNED }),
        ]
      : []),
  ]
}

function TrafficGrid({ data }: { data: ParentTrafficResponse }) {
  const compare = data.compareRange !== null
  const columns = useMemo(() => trafficColumns(compare), [compare])
  return (
    <LocalGrid<TrafficRow>
      gridId="analytics.parent.traffic"
      columns={columns}
      rows={data.rows}
      getRowId={row => row.asin}
      resetKey={String(compare)}
      emptyState={{ kind: 'empty', domain: '子体', prerequisite: '这个父体名下还没有子体。' }}
      initialPageSize={50}
      height={360}
    />
  )
}
export function TrafficTab({ parentAsin }: { parentAsin: string }) {
  const query = useParentQuery<ParentTrafficResponse>(parentAsin, 'traffic')
  return (
    <Frame query={query} testId="parent-traffic">
      {data => (
        <>
          <p style={{ margin: '0 0 8px' }} data-testid="parent-traffic-total">
            父体会话合计：
            <AsinFigure metric="sessions" value={data.totalSessions} />
            {data.compareRange ? (
              <>
                {' '}
                · 对比期（{data.compareRange.from} 至 {data.compareRange.to}）：
                <AsinFigure metric="sessions" value={data.compareTotalSessions} />
              </>
            ) : null}
          </p>
          <ChartPanel
            title="会话占比"
            ariaLabel="各子体会话占比图"
            option={buildTrafficOption(data.rows)}
            height={Math.max(160, Math.min(15, data.rows.length) * 26 + 40)}
            emptyState={data.rows.every(row => row.share === null) ? { kind: 'empty', domain: '流量分布', prerequisite: data.note ?? '所选范围内这些子体没有会话记录。' } : undefined}
          />
          <TrafficGrid data={data} />
        </>
      )}
    </Frame>
  )
}
