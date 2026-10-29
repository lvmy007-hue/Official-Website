import { createContext, useContext } from 'react'
import { Checkbox, Select, Space, Tag, Typography } from 'antd'
import { PACKING_BASIS_LABEL, PACKING_STATUS_LABEL, type PackingPreviewRow } from '@nova/api-contracts'
import { renderColumn, type ErpColDef } from '../../../components'
import { EMPTY_VALUE, formatNumber } from '../../../format'
import { Muted } from '../../inventory/inventory-ui'
import { verdictOf, type DecisionMap, type RowVerdict } from './packing-list-state'

// 装箱单预览表的列（P6-11）：行号、箱号、货号、品名、每箱件数×箱数、箱规、匹配结果、对应 SKU（可改）、记住、忽略、问题。
// 人工决定放在上下文里，列定义保持不变——勾选与选择不会让整张表重建、滚动位置不丢。

export interface PackingDecisionApi {
  decisions: DecisionMap
  /** 装箱后才看得出的问题（随决定与默认箱规实时重算）。 */
  boxIssues: ReadonlyMap<number, string[]>
  choose: (line: number, sku: string | null) => void
  ignore: (line: number, value: boolean) => void
  remember: (line: number, value: boolean) => void
  planItems: ReadonlyArray<{ sku: string; productName: string | null }>
  canRemember: boolean
  rememberBlockedReason: string | null
  /** 没有“写入仓计划”权限或计划状态不允许时只读。 */
  readOnly: boolean
}

export const DecisionContext = createContext<PackingDecisionApi | null>(null)
const useDecisions = () => {
  const value = useContext(DecisionContext)
  if (!value) throw new Error('缺少装箱单决定上下文')
  return value
}

const STATUS_COLOR = { MATCHED: 'success', CANDIDATE: 'warning', UNMATCHED: 'error' } as const
const VERDICT_TEXT: Record<RowVerdict, string> = { IGNORED: '已忽略', PROBLEM: '有问题', NEEDS_SKU: '待选 SKU', READY: '可装箱' }
const VERDICT_COLOR: Record<RowVerdict, string> = { IGNORED: 'default', PROBLEM: 'error', NEEDS_SKU: 'warning', READY: 'success' }

const spec = (row: PackingPreviewRow): string | null => {
  const parts = [
    row.lengthIn !== null && row.widthIn !== null && row.heightIn !== null ? `${row.lengthIn}×${row.widthIn}×${row.heightIn} 英寸` : null,
    row.weightLb !== null ? `${row.weightLb} 磅` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('，') : null
}

function SkuCell({ row }: { row: PackingPreviewRow }) {
  const api = useDecisions()
  const decision = api.decisions[row.line]
  const chosen = decision?.sku ?? null
  const shown = chosen ?? row.sku
  const candidates = row.candidates.map(item => ({ value: item.sku, label: `${item.sku}（相似度 ${Math.round(item.score * 100)}%）` }))
  const rest = api.planItems
    .filter(item => !row.candidates.some(candidate => candidate.sku === item.sku))
    .map(item => ({ value: item.sku, label: item.productName ? `${item.sku} ${item.productName}` : item.sku }))
  return (
    <Select
      size="small"
      allowClear
      showSearch
      optionFilterProp="label"
      aria-label={`第 ${row.line} 行对应的 SKU`}
      placeholder={decision?.ignore ? '已忽略' : '选择 SKU'}
      disabled={api.readOnly || decision?.ignore === true || row.issues.length > 0}
      value={shown ?? undefined}
      style={{ width: '100%' }}
      options={[...(candidates.length > 0 ? [{ label: '相似的候选', options: candidates }] : []), { label: '计划里的 SKU', options: rest }]}
      onChange={value => api.choose(row.line, value ?? null)}
    />
  )
}

function RememberCell({ row }: { row: PackingPreviewRow }) {
  const api = useDecisions()
  const decision = api.decisions[row.line]
  const chosen = decision?.sku ?? null
  const exact = row.status === 'MATCHED' && (chosen === null || chosen === row.sku)
  const key = row.code ?? row.name
  const reason = !api.canRemember ? api.rememberBlockedReason : exact ? '已经按 SKU、FNSKU、ASIN 或映射匹配，不需要再记' : !key ? '这一行没有货号或品名，没法记' : !chosen ? '先选一个 SKU' : null
  return (
    <Checkbox
      aria-label={`第 ${row.line} 行记住对应关系`}
      title={reason ?? '下次这个供应商的装箱单里出现同样的货号，自动对应到这个 SKU'}
      disabled={api.readOnly || reason !== null}
      checked={decision?.remember === true}
      onChange={event => api.remember(row.line, event.target.checked)}
    />
  )
}

function IgnoreCell({ row }: { row: PackingPreviewRow }) {
  const api = useDecisions()
  return <Checkbox aria-label={`第 ${row.line} 行忽略`} disabled={api.readOnly} checked={api.decisions[row.line]?.ignore === true} onChange={event => api.ignore(row.line, event.target.checked)} />
}

function ProblemCell({ row }: { row: PackingPreviewRow }) {
  const api = useDecisions()
  const problems = [...row.issues, ...(api.boxIssues.get(row.line) ?? [])].join('；')
  const hints = [...row.warnings, ...(row.note ? [row.note] : [])].join('；')
  return problems ? <Typography.Text type="danger">{problems}</Typography.Text> : hints ? <Typography.Text type="secondary">{hints}</Typography.Text> : <Muted>无</Muted>
}

function ResultCell({ row }: { row: PackingPreviewRow }) {
  const api = useDecisions()
  const verdict = verdictOf(row, api.decisions[row.line], api.boxIssues.get(row.line))
  return (
    <Space size={4}>
      <Tag bordered={false} color={VERDICT_COLOR[verdict]} style={{ marginInlineEnd: 0 }}>
        {VERDICT_TEXT[verdict]}
      </Tag>
    </Space>
  )
}

const problemText = (row: PackingPreviewRow) => [...row.issues, ...row.boxIssues].join('；')

export function packingColumns(): ErpColDef<PackingPreviewRow>[] {
  return [
    { headerName: '行', colId: 'line', pin: 'left', width: 70, sortable: false, valueGetter: ({ data }) => data?.line ?? '' },
    renderColumn<PackingPreviewRow>(
      '箱号',
      'boxNo',
      row =>
        row.boxNo ? (
          <span>
            {row.boxNo}
            {row.boxNoInherited ? <Muted>（沿用）</Muted> : null}
          </span>
        ) : (
          <Muted>无</Muted>
        ),
      { width: 110, sortable: false },
    ),
    { headerName: '货号', colId: 'code', width: 150, sortable: false, valueGetter: ({ data }) => data?.code ?? EMPTY_VALUE, tooltipValueGetter: ({ data }) => data?.code ?? '' },
    { headerName: '品名', colId: 'name', width: 190, sortable: false, valueGetter: ({ data }) => data?.name ?? EMPTY_VALUE, tooltipValueGetter: ({ data }) => data?.name ?? '' },
    renderColumn<PackingPreviewRow>(
      '每箱 × 箱数',
      'qty',
      row =>
        row.perBox !== null && row.boxCount !== null ? (
          <span className="erp-num">
            {formatNumber(row.perBox, { digits: 0 })} × {formatNumber(row.boxCount, { digits: 0 })}
          </span>
        ) : (
          <Muted>读不出</Muted>
        ),
      { width: 120, sortable: false },
    ),
    renderColumn<PackingPreviewRow>('外箱规格', 'spec', row => spec(row) ?? <Muted>尚无记录</Muted>, { width: 190, sortable: false }),
    renderColumn<PackingPreviewRow>(
      '匹配',
      'status',
      row => (
        <Space size={4}>
          <Tag bordered={false} color={STATUS_COLOR[row.status]} style={{ marginInlineEnd: 0 }}>
            {PACKING_STATUS_LABEL[row.status]}
          </Tag>
          {row.basis ? <Typography.Text type="secondary">{PACKING_BASIS_LABEL[row.basis]}</Typography.Text> : null}
        </Space>
      ),
      { width: 220, sortable: false, tooltipValueGetter: ({ data }) => data?.note ?? '' },
    ),
    renderColumn<PackingPreviewRow>('对应 SKU', 'sku', row => <SkuCell row={row} />, { width: 280, sortable: false }),
    renderColumn<PackingPreviewRow>('记住', 'remember', row => <RememberCell row={row} />, { width: 80, sortable: false }),
    renderColumn<PackingPreviewRow>('忽略', 'ignore', row => <IgnoreCell row={row} />, { width: 80, sortable: false }),
    renderColumn<PackingPreviewRow>('结果', 'verdict', row => <ResultCell row={row} />, { width: 110, sortable: false }),
    {
      headerName: '问题与提醒',
      colId: 'problems',
      width: 360,
      sortable: false,
      valueGetter: ({ data }) => (data ? [problemText(data), ...data.warnings, data.note ?? ''].filter(Boolean).join('；') : ''),
      tooltipValueGetter: ({ data }) => (data ? [problemText(data), ...data.warnings, data.note ?? ''].filter(Boolean).join('；') : ''),
      cellRenderer: ({ data }: { data?: PackingPreviewRow }) => (data ? <ProblemCell row={data} /> : null),
    },
  ]
}
