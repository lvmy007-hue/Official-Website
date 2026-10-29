import type { ReactNode } from 'react'
import type { ColDef, ICellRendererParams } from 'ag-grid-community'
import { EMPTY_VALUE, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, NUMERIC_CLASS, toNumber, toneClassName, toneOf } from '../../format'
import { MiniTrend } from '../metric/MiniTrend'
import type { ErpColDef } from './grid-types'

// 表格列的统一写法：数字右对齐、等宽数字、金额带币种且负数红色、时间带时区、正负色语义一致。
// 页面只描述“哪一列、什么口径”，不再各自拼格式。商品、涨跌、双行、状态、进度、人员、估算值、操作列在 cell-types.tsx。
// 列定义比 AG Grid 的 ColDef 多三个键：pin（固定列）、group（两层表头）、async（异步列），由 grid-columns 转换。

type Getter<T> = (row: T) => unknown

// AG Grid 的字段类型是带路径推导的复杂类型；页面传入的是行类型的键，这里集中做一次转换。
const fieldRef = <T,>(field: string) => field as unknown as ColDef<T>['field']

function valueOf<T>(params: { data?: T }, get: Getter<T>) {
  return params.data === undefined ? undefined : get(params.data)
}

export function textColumn<T>(headerName: string, field: keyof T & string, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return { headerName, field: fieldRef<T>(field), colId: field, minWidth: 120, tooltipField: fieldRef<T>(field), ...extra }
}

export function numberColumn<T>(headerName: string, field: keyof T & string, options: { digits?: number; compact?: boolean } & ErpColDef<T> = {}): ErpColDef<T> {
  const { digits, compact, ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    type: 'rightAligned',
    cellClass: NUMERIC_CLASS,
    headerClass: 'ag-right-aligned-header',
    valueFormatter: p => formatNumber(p.value as number | string | null | undefined, { digits, compact }),
    minWidth: 100,
    ...extra,
  }
}

// 金额：带币种，负数默认红色；signed 表示“带正负号并按好坏着色”（成本类传 goodWhen: 'down'）。
// 币种随行变化时（currency 传函数），汇总行取汇总接口给的币种，没有就显示“—”。
export function moneyColumn<T>(
  headerName: string,
  field: keyof T & string,
  options: { currency?: string | ((row: T) => string); digits?: number; goodWhen?: 'up' | 'down'; signed?: boolean } & ErpColDef<T> = {},
): ErpColDef<T> {
  const { currency = 'USD', digits, goodWhen, signed, ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    type: 'rightAligned',
    headerClass: 'ag-right-aligned-header',
    cellClass: params => {
      const n = toNumber(params.value as number | string | null)
      const tone = signed ? toneClassName(toneOf(n, goodWhen)) : n !== null && n < 0 ? toneClassName('negative') : ''
      return [NUMERIC_CLASS, tone].filter(Boolean).join(' ')
    },
    valueFormatter: p => {
      if (typeof currency !== 'function') return formatMoney(p.value as number | string | null | undefined, currency, { digits, sign: signed })
      if (p.node?.rowPinned) {
        const summaryCurrency = (p.context as { summaryCurrency?: string | null } | undefined)?.summaryCurrency
        return summaryCurrency ? formatMoney(p.value as number | string | null | undefined, summaryCurrency, { digits, sign: signed }) : EMPTY_VALUE
      }
      return formatMoney(p.value as number | string | null | undefined, p.data ? currency(p.data) : 'USD', { digits, sign: signed })
    },
    minWidth: 120,
    ...extra,
  }
}

export function percentColumn<T>(headerName: string, field: keyof T & string, options: { digits?: number; goodWhen?: 'up' | 'down'; signed?: boolean } & ErpColDef<T> = {}): ErpColDef<T> {
  const { digits, goodWhen, signed, ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    type: 'rightAligned',
    headerClass: 'ag-right-aligned-header',
    cellClass: params => [NUMERIC_CLASS, signed ? toneClassName(toneOf(params.value as number, goodWhen)) : ''].filter(Boolean).join(' '),
    valueFormatter: p => formatPercent(p.value as number | string | null | undefined, { digits, sign: signed }),
    minWidth: 90,
    ...extra,
  }
}

export function dateTimeColumn<T>(headerName: string, field: keyof T & string, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return { headerName, colId: field, field: fieldRef<T>(field), cellClass: NUMERIC_CLASS, valueFormatter: p => formatDateTime(p.value as string | null | undefined), minWidth: 170, ...extra }
}

export function dateColumn<T>(headerName: string, field: keyof T & string, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return { headerName, colId: field, field: fieldRef<T>(field), cellClass: NUMERIC_CLASS, valueFormatter: p => formatDate(p.value as string | null | undefined), minWidth: 110, ...extra }
}

/** 自定义单元格：页面给一个“行 → 内容”的函数（链接、标签、带“尚无记录”的数字等）；加载中的占位行不渲染。右对齐用 extra 传 right。 */
export function renderColumn<T extends object>(headerName: string, colId: string, render: (row: T) => ReactNode, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return { headerName, colId, minWidth: 80, cellRenderer: (params: ICellRendererParams<T>) => (params.data ? render(params.data) : null), ...extra }
}

/** 列头的纯文字说明（页面不直接写 headerTooltip，统一从这里出）。 */
export const headerNote = (note?: string) => (note ? { headerTooltip: note } : {})

/** 右对齐数字列的公共属性（与 numberColumn 一致：等宽数字、表头也右对齐）。 */
export const RIGHT_ALIGNED = { type: 'rightAligned', headerClass: 'ag-right-aligned-header', cellClass: NUMERIC_CLASS } as const

/** 行内迷你趋势：从行里取一组数字（按时间顺序），画成折线，不依赖企业版图表。 */
export function miniTrendColumn<T>(headerName: string, get: Getter<T>, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName,
    colId: `trend:${headerName}`,
    sortable: false,
    minWidth: 120,
    maxWidth: 150,
    valueGetter: p => valueOf(p, get),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const raw = params.value as unknown
      const points = Array.isArray(raw) ? raw.map(item => toNumber(item as number | string | null)).filter((n): n is number => n !== null) : []
      return <MiniTrend points={points} label={`${headerName}趋势`} />
    },
    ...extra,
  }
}
