import { Tag } from 'antd'
import type { ReactNode } from 'react'
import type { CheckItem, CostDiffRow, DiffAmount, FxDiffRow, PeriodRow, PeriodSnapshotSummary, SkuDiff } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { count, money, timeText } from '../orders/orders-ui'
import { CheckStateTag, PeriodStatusTag, checkText, personText, rangeText } from './periods-ui'

// 期间关账各表的列（P6-28 第 6 批：由旧 antd 表迁到 PagedGrid / LocalGrid）。口径与迁移前一致：没有的一边写“无”，不当 0。

type Cell<T> = (row: T) => ReactNode
const col = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: Cell<T>) => col<T>(title, key, width, render, RIGHT_ALIGNED)
const WRAP = { wrapText: true, autoHeight: true } as const

export const periodColumns: ErpColDef<PeriodRow>[] = [
  col<PeriodRow>(
    '期间',
    'month',
    110,
    row => (
      <LiveLink component="AccountingPeriodDetailPage" id={row.id}>
        {row.month}
      </LiveLink>
    ),
    { pin: 'left' },
  ),
  col<PeriodRow>('店铺', 'storeName', 160, row => row.storeName),
  col<PeriodRow>('日期范围', 'range', 200, row => rangeText(row.periodStart, row.periodEnd)),
  col<PeriodRow>('状态', 'status', 110, row => <PeriodStatusTag status={row.status} />),
  col<PeriodRow>('最近检查', 'check', 110, row => checkText(row.checkPassed)),
  col<PeriodRow>('关账人', 'closedBy', 120, row => personText(row.closedBy)),
  col<PeriodRow>('关账时间', 'closedAt', 170, row => timeText(row.closedAt)),
  num<PeriodRow>('关账次数', 'closeCount', 100, row => <span className="erp-num">{row.closeCount}</span>),
]

/** 完整性检查清单；确认放行列由页面传入渲染函数（弹窗在页面里）。 */
export const checklistColumns = (renderAck: (item: CheckItem) => ReactNode): ErpColDef<CheckItem>[] => [
  col<CheckItem>('检查项', 'label', 200, item => item.label),
  col<CheckItem>('结果', 'state', 120, item => <CheckStateTag state={item.state} />),
  col<CheckItem>(
    '依据',
    'summary',
    460,
    item => (
      <span className="erp-cell-stack">
        <span>{item.summary}</span>
        {item.details.length ? (
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
            {item.details.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </span>
    ),
    WRAP,
  ),
  col<CheckItem>('确认放行', 'ack', 280, renderAck, WRAP),
]

const KIND_TEXT = { CHANGED: '有变化', ADDED: '新增', REMOVED: '移除' } as const
const KIND_COLOR = { CHANGED: 'warning', ADDED: 'success', REMOVED: 'error' } as const
const kindTag = (kind: keyof typeof KIND_TEXT) => (
  <Tag color={KIND_COLOR[kind]} bordered={false} style={{ marginInlineEnd: 0 }}>
    {KIND_TEXT[kind]}
  </Tag>
)
const none = <Muted>无</Muted>
const amount = (value: number | null | undefined): ReactNode => (value === null || value === undefined ? none : money(value))
const pair = (before: number | null, after: number | null): ReactNode => (
  <span>
    {amount(before)} → {amount(after)}
  </span>
)
const sign = (value: number | null): ReactNode => (value === null ? none : value > 0 ? <>+{money(value)}</> : money(value))

export const amountColumns: ErpColDef<DiffAmount>[] = [
  col<DiffAmount>('项目', 'label', 220, row => row.label),
  num<DiffAmount>('之前', 'before', 160, row => amount(row.before)),
  num<DiffAmount>('之后', 'after', 160, row => amount(row.after)),
  num<DiffAmount>('变化', 'delta', 160, row => sign(row.delta)),
]

export const skuColumns: ErpColDef<SkuDiff>[] = [
  col<SkuDiff>('SKU', 'sku', 180, row => row.sku),
  col<SkuDiff>('变化', 'kind', 90, row => kindTag(row.kind)),
  num<SkuDiff>('销量（件）', 'units', 150, row => (
    <span className="erp-num">
      {count(row.units.before)} → {count(row.units.after)}
    </span>
  )),
  num<SkuDiff>('销售额', 'revenue', 220, row => pair(row.revenue.before, row.revenue.after)),
  num<SkuDiff>('净利润', 'profit', 220, row => pair(row.profit.before, row.profit.after)),
]

export const fxColumns: ErpColDef<FxDiffRow>[] = [
  col<FxDiffRow>('币种', 'quote', 90, row => row.quote),
  col<FxDiffRow>('日期', 'date', 120, row => row.date),
  col<FxDiffRow>('来源', 'source', 140, row => row.source),
  num<FxDiffRow>('汇率', 'rate', 220, row => (
    <span className="erp-num">
      {row.before ?? '无'} → {row.after ?? '无'}
    </span>
  )),
]

const costText = (side: CostDiffRow['before']): ReactNode =>
  side ? (
    <span className="erp-num">
      货值 {side.productCost ?? '无'} · 头程 {side.firstMileCost ?? '无'} · 其它 {side.otherCost ?? '无'}
    </span>
  ) : (
    none
  )

export const costColumns: ErpColDef<CostDiffRow>[] = [
  col<CostDiffRow>('SKU', 'sku', 180, row => row.sku),
  col<CostDiffRow>('版本', 'versionNo', 80, row => row.versionNo),
  col<CostDiffRow>('变化', 'kind', 90, row => kindTag(row.kind)),
  col<CostDiffRow>('之前', 'before', 300, row => costText(row.before)),
  col<CostDiffRow>('之后', 'after', 300, row => costText(row.after)),
]

export const snapshotColumns: ErpColDef<PeriodSnapshotSummary>[] = [
  col<PeriodSnapshotSummary>('第几次关账', 'revision', 110, row => <span className="erp-num">第 {row.revision} 次</span>),
  col<PeriodSnapshotSummary>('锁定时间', 'lockedAt', 170, row => timeText(row.lockedAt)),
  col<PeriodSnapshotSummary>('锁定人', 'lockedBy', 120, row => row.lockedBy),
  col<PeriodSnapshotSummary>(
    '利润（销售额 / 净利润）',
    'bases',
    420,
    row =>
      row.bases ? (
        <span className="erp-cell-stack">
          {row.bases.map(basis => (
            <span key={basis.basis}>
              {basis.label}：{money(basis.revenue)} / {basis.netProfit === null ? <Muted>有商品缺成本，不给</Muted> : money(basis.netProfit)}
            </span>
          ))}
        </span>
      ) : (
        <Muted>无权查看</Muted>
      ),
    WRAP,
  ),
  num<PeriodSnapshotSummary>('汇率条数', 'fxRates', 100, row => <span className="erp-num">{row.fxRates}</span>),
  num<PeriodSnapshotSummary>('成本版本', 'costVersions', 100, row => <span className="erp-num">{row.costVersions}</span>),
  col<PeriodSnapshotSummary>('差异报告', 'diff', 100, row => (row.hasDiff ? '有' : <Muted>无</Muted>)),
]

/** 关账报表预览：利润桥逐项，三种口径并排（列数随口径变化）。 */
export type PreviewRow = { key: string; label: string; cells: ReactNode[] }

export const previewColumns = (labels: readonly { basis: string; label: string }[]): ErpColDef<PreviewRow>[] => [
  col<PreviewRow>('利润桥', 'label', 220, row => row.label),
  ...labels.map((basis, index) => num<PreviewRow>(basis.label, basis.basis, 170, row => row.cells[index])),
]
