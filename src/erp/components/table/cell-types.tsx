import type { ReactNode } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { Avatar, Progress, Tag } from 'antd'
import { EMPTY_VALUE, MARKETPLACE_TIME_ZONE, NUMERIC_CLASS, formatDateTime, formatMoney, formatNumber, formatPercent, toNumber, toneClassName, toneOf } from '../../format'
import type { ErpColDef } from './grid-types'

// 统一单元格类型（P6-02，15 章第 6 节）：商品、涨跌、双行（本期值 + 上期值 + 涨跌）、状态标签、进度条、人员、时间（悬停显示站点时区）、
// 估算值（带“估”角标）、操作列。金额、百分比、迷你趋势在 columns.tsx。页面只描述“哪一列、什么口径”，不再各自拼样式。
// 空值一律显示“—”（没有记录），不显示成 0；不使用表情符号（站点用两位代码，不用国旗）。

type Getter<T, V> = (row: T) => V
const fieldRef = <T,>(field: string) => field as unknown as ErpColDef<T>['field']
const rowOf = <T,>(params: ICellRendererParams<T>) => params.data as T | undefined

export type ProductCellData = { imageUrl?: string | null; title?: string | null; asin?: string | null; sku?: string | null; storeName?: string | null; site?: string | null }

/** 商品：图、标题、ASIN 与 SKU、店铺与站点代码。默认固定在左。 */
export function productColumn<T>(headerName: string, get: Getter<T, ProductCellData>, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName,
    colId: 'product',
    pin: 'left',
    width: 300,
    minWidth: 220,
    sortable: false,
    valueGetter: params => (params.data ? (get(params.data).title ?? get(params.data).sku ?? null) : undefined),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const row = rowOf(params)
      if (!row) return null
      const item = get(row)
      const codes = [item.asin, item.sku].filter(Boolean).join(' · ')
      const shop = [item.storeName, item.site].filter(Boolean).join(' · ')
      return (
        <div className="erp-cell-product">
          {item.imageUrl ? <img className="erp-cell-product-img" src={item.imageUrl} alt="" loading="lazy" /> : <span className="erp-cell-product-img" aria-hidden="true" />}
          <div className="erp-cell-stack">
            <span className="erp-cell-ellipsis" title={item.title ?? undefined}>
              {item.title ?? '尚无标题'}
            </span>
            {codes ? <span className="erp-cell-sub erp-num erp-cell-ellipsis">{codes}</span> : null}
            {shop ? <span className="erp-cell-sub erp-cell-ellipsis">{shop}</span> : null}
          </div>
        </div>
      )
    },
    ...extra,
  }
}

/** 涨跌的箭头与颜色；ratio 是比率（0.12 表示 12%），没有可比数据显示“—”。 */
export function DeltaText({ ratio, goodWhen }: { ratio: number | string | null | undefined; goodWhen?: 'up' | 'down' }) {
  const n = toNumber(ratio)
  if (n === null) return <span className={`${NUMERIC_CLASS} erp-cell-sub`}>{EMPTY_VALUE}</span>
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : ''
  return (
    <span className={`${NUMERIC_CLASS} ${toneClassName(toneOf(n, goodWhen))}`} aria-label={`涨跌 ${formatPercent(n, { sign: true })}`}>
      {arrow} {formatPercent(Math.abs(n))}
    </span>
  )
}

/** 涨跌列：值是变化比率。 */
export function deltaColumn<T>(headerName: string, field: keyof T & string, options: { goodWhen?: 'up' | 'down' } & ErpColDef<T> = {}): ErpColDef<T> {
  const { goodWhen, ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    type: 'rightAligned',
    headerClass: 'ag-right-aligned-header',
    minWidth: 100,
    valueFormatter: p => formatPercent(p.value as number | string | null | undefined, { sign: true }),
    cellRenderer: (params: ICellRendererParams<T>) => <DeltaText ratio={params.value as number | null} goodWhen={goodWhen} />,
    ...extra,
  }
}

export type DualFormat = { kind: 'money'; currency?: string; digits?: number } | { kind: 'number'; digits?: number } | { kind: 'percent'; digits?: number }
const formatBy = (value: number | string | null | undefined, format: DualFormat) =>
  format.kind === 'money'
    ? formatMoney(value, format.currency ?? 'USD', { digits: format.digits })
    : format.kind === 'percent'
      ? formatPercent(value, { digits: format.digits })
      : formatNumber(value, { digits: format.digits })

/** 双行：第一行本期值，第二行“上期值 + 涨跌”。涨跌优先用服务端给的 change；没有时在上期值非零时按本期、上期算比率。 */
export function dualRowColumn<T>(
  headerName: string,
  options: { current: Getter<T, number | null>; previous: Getter<T, number | null>; change?: Getter<T, number | null>; format: DualFormat; goodWhen?: 'up' | 'down' } & ErpColDef<T> & {
      colId: string
    },
): ErpColDef<T> {
  const { current, previous, change, format, goodWhen, ...extra } = options
  return {
    headerName,
    type: 'rightAligned',
    headerClass: 'ag-right-aligned-header',
    minWidth: 140,
    valueGetter: params => (params.data ? current(params.data) : undefined),
    valueFormatter: p => formatBy(p.value as number | null | undefined, format),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const row = rowOf(params)
      if (!row) return null
      const now = toNumber(current(row))
      const before = toNumber(previous(row))
      const ratio = change ? toNumber(change(row)) : now !== null && before !== null && before !== 0 ? (now - before) / Math.abs(before) : null
      return (
        <div className="erp-cell-stack" style={{ alignItems: 'flex-end' }}>
          <span className={NUMERIC_CLASS}>{formatBy(now, format)}</span>
          <span className="erp-cell-sub">
            <span className={NUMERIC_CLASS}>上期 {formatBy(before, format)}</span> <DeltaText ratio={ratio} goodWhen={goodWhen} />
          </span>
        </div>
      )
    },
    ...extra,
  }
}

export type StatusTone = 'success' | 'warning' | 'error' | 'processing' | 'default'

/** 状态标签：未登记的取值原样显示为灰色标签，不吞掉。 */
export function statusColumn<T>(headerName: string, field: keyof T & string, labels: Readonly<Record<string, { label: string; tone?: StatusTone }>>, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    minWidth: 110,
    valueFormatter: p => (typeof p.value === 'string' ? (labels[p.value]?.label ?? p.value) : EMPTY_VALUE),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const raw = params.value as string | null | undefined
      if (raw === null || raw === undefined || raw === '') return <span>{EMPTY_VALUE}</span>
      const item = labels[raw]
      return (
        <Tag bordered={false} color={item?.tone ?? 'default'} style={{ marginInlineEnd: 0 }}>
          {item?.label ?? raw}
        </Tag>
      )
    },
    ...extra,
  }
}

/** 进度条：值是 0 到 1 的比率，超出范围按边界显示。 */
export function progressColumn<T>(headerName: string, field: keyof T & string, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    minWidth: 140,
    valueFormatter: p => formatPercent(p.value as number | string | null | undefined, { digits: 0 }),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const n = toNumber(params.value as number | string | null)
      if (n === null) return <span>{EMPTY_VALUE}</span>
      const percent = Math.round(Math.min(1, Math.max(0, n)) * 100)
      return <Progress percent={percent} size="small" aria-label={`${headerName} ${percent}%`} />
    },
    ...extra,
  }
}

export type PersonCellData = { name: string | null; avatarUrl?: string | null }

/** 人员：头像（没有头像用姓名首字）加姓名。 */
export function personColumn<T>(headerName: string, get: Getter<T, PersonCellData | null>, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName,
    colId: `person:${headerName}`,
    minWidth: 120,
    valueGetter: params => (params.data ? (get(params.data)?.name ?? null) : undefined),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const row = rowOf(params)
      const person = row ? get(row) : null
      if (!person?.name) return <span>{EMPTY_VALUE}</span>
      return (
        <span className="erp-cell-product">
          <Avatar size={20} src={person.avatarUrl ?? undefined}>
            {person.name.slice(0, 1)}
          </Avatar>
          <span className="erp-cell-ellipsis">{person.name}</span>
        </span>
      )
    },
    ...extra,
  }
}

/** 时间：显示站点时区时间；悬停显示精确到秒的时间和所用时区。 */
export function timeColumn<T>(headerName: string, field: keyof T & string, options: { timeZone?: string } & ErpColDef<T> = {}): ErpColDef<T> {
  const { timeZone = MARKETPLACE_TIME_ZONE, ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    cellClass: NUMERIC_CLASS,
    minWidth: 170,
    valueFormatter: p => formatDateTime(p.value as string | null | undefined, { timeZone }),
    tooltipValueGetter: p => (p.value ? `${formatDateTime(p.value as string, { timeZone, seconds: true })}（站点时区 ${timeZone}）` : undefined),
    ...extra,
  }
}

/** 估算值：数字旁带“估”角标，悬停说明方法；没有值时不带角标。 */
export function estimateColumn<T>(headerName: string, field: keyof T & string, options: { format: DualFormat; method?: string } & ErpColDef<T>): ErpColDef<T> {
  const { format, method = '模型估算，不是已结算的实际值', ...extra } = options
  return {
    headerName,
    colId: field,
    field: fieldRef<T>(field),
    type: 'rightAligned',
    headerClass: 'ag-right-aligned-header',
    minWidth: 120,
    valueFormatter: p => formatBy(p.value as number | string | null | undefined, format),
    cellRenderer: (params: ICellRendererParams<T>) => {
      const n = toNumber(params.value as number | string | null)
      return (
        <span className={NUMERIC_CLASS}>
          {formatBy(n, format)}
          {n !== null ? (
            <span className="erp-cell-estimate" title={method} aria-label={`估算值：${method}`}>
              估
            </span>
          ) : null}
        </span>
      )
    },
    ...extra,
  }
}

/** 操作列：固定在右，不排序。内容由页面经动作守卫生成。 */
export function actionColumn<T>(render: (row: T) => ReactNode, extra: ErpColDef<T> = {}): ErpColDef<T> {
  return {
    headerName: '操作',
    colId: 'actions',
    pin: 'right',
    width: 120,
    sortable: false,
    resizable: false,
    valueGetter: () => null,
    cellRenderer: (params: ICellRendererParams<T>) => {
      const row = rowOf(params)
      return row ? <span className="erp-cell-actions">{render(row)}</span> : null
    },
    ...extra,
  }
}
