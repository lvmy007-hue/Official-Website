import { Tag } from 'antd'
import type { ReactNode } from 'react'
import { SALES_TAX_RECON_HINT, type SalesTaxJurisdictionRow, type SalesTaxReconRow, type SalesTaxReconState, type SalesTaxSourceView, type SalesTaxStateRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'

// 销售税页各表的列（P6-28 第 6 批：由旧 antd 表迁到 LocalGrid）。没有数据写“尚无记录”，不写 0；尚未接入的来源写“尚未接入”。

type Cell<T> = (row: T) => ReactNode
const col = <T extends object>(title: string, key: string, width: number, render: Cell<T>, extra: ErpColDef<T> = {}) => renderColumn<T>(title, key, render, { width, sortable: false, ...extra })
const num = <T extends object>(title: string, key: string, width: number, render: Cell<T>) => col<T>(title, key, width, render, RIGHT_ALIGNED)
const lines = (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

const SOURCE_TAG: Record<SalesTaxSourceView['state'], { color: string; label: string }> = {
  OK: { color: 'success', label: '已计入' },
  NO_DATA: { color: 'default', label: '范围内无数据' },
  NOT_CONNECTED: { color: 'default', label: '尚未接入' },
}

export const sourceColumns: ErpColDef<SalesTaxSourceView>[] = [
  col<SalesTaxSourceView>('来源', 'label', 140, row => row.label),
  col<SalesTaxSourceView>('状态', 'state', 140, row => (
    <Tag color={SOURCE_TAG[row.state].color} bordered={false}>
      {SOURCE_TAG[row.state].label}
    </Tag>
  )),
  num<SalesTaxSourceView>('税额合计', 'total', 140, row => money(row.total)),
  col<SalesTaxSourceView>('说明', 'note', 520, row => row.note),
]

/** 州与辖区摊成同一种行：州是父行，辖区是子行（展开才显示）。 */
export type TaxGridRow = {
  id: string
  level: 'state' | 'jurisdiction'
  label: ReactNode
  taxKindLabel: string | null
  taxCollected: number
  share: number | null | undefined
  taxableSales: number | null
  lineCount: number
  children: TaxGridRow[]
}

const jurisdictionRow = (state: string, row: SalesTaxJurisdictionRow): TaxGridRow => ({
  id: `${state}|${row.jurisdictionKey}|${row.taxKind}`,
  level: 'jurisdiction',
  label: row.jurisdictionKey === '' ? <Muted>州一级（报告没写辖区）</Muted> : row.jurisdictionKey,
  taxKindLabel: row.taxKindLabel,
  taxCollected: row.taxCollected,
  share: undefined,
  taxableSales: row.taxableSales,
  lineCount: row.lineCount,
  children: [],
})

export const taxGridRows = (states: readonly SalesTaxStateRow[]): TaxGridRow[] =>
  states.map(row => ({
    id: row.state,
    level: 'state',
    label: row.state,
    taxKindLabel: null,
    taxCollected: row.taxCollected,
    share: row.share,
    taxableSales: row.taxableSales,
    lineCount: row.lineCount,
    children: row.jurisdictions.map(item => jurisdictionRow(row.state, item)),
  }))

export const stateColumns: ErpColDef<TaxGridRow>[] = [
  col<TaxGridRow>('州 / 辖区', 'label', 260, row => row.label),
  col<TaxGridRow>('税种', 'taxKind', 120, row => row.taxKindLabel ?? <Muted>—</Muted>),
  num<TaxGridRow>('代收代缴税额', 'taxCollected', 150, row => money(row.taxCollected)),
  num<TaxGridRow>('占比', 'share', 90, row =>
    row.share === undefined ? <Muted>—</Muted> : row.share === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(row.share, { digits: 1 })}</span>,
  ),
  num<TaxGridRow>('应税销售额', 'taxableSales', 150, row => money(row.taxableSales)),
  num<TaxGridRow>('明细行数', 'lineCount', 100, row => lines(row.lineCount)),
]

const RECON_COLOR: Record<SalesTaxReconState, string> = { MATCHED: 'success', DIFFERENT: 'error', NO_REPORT: 'warning', NO_ORDERS: 'warning' }

export const reconColumns: ErpColDef<SalesTaxReconRow>[] = [
  col<SalesTaxReconRow>('月份', 'month', 90, row => <span title={`${row.from} ~ ${row.to}`}>{row.month}</span>),
  col<SalesTaxReconRow>('店铺', 'storeName', 140, row => row.storeName),
  num<SalesTaxReconRow>('报告合计', 'reportTax', 130, row => money(row.reportTax)),
  num<SalesTaxReconRow>('订单合计', 'ordersTax', 130, row => money(row.ordersTax)),
  num<SalesTaxReconRow>('差额（报告 − 订单）', 'diff', 170, row =>
    row.diff === null ? <Muted>无法比较</Muted> : <span className="erp-num">{`${row.diff > 0 ? '+' : ''}${formatNumber(row.diff, { digits: 2 })}`}</span>,
  ),
  col<SalesTaxReconRow>('结果', 'state', 460, row => (
    <span>
      <Tag color={RECON_COLOR[row.state]} bordered={false}>
        {row.stateLabel}
      </Tag>
      <Muted>{SALES_TAX_RECON_HINT[row.state]}</Muted>
    </span>
  )),
]
