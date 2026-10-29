import type { ReactNode } from 'react'
import { Alert, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ratiosOf, type AdsEntityMetrics, type DashState } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { STATE_TEXT } from './ads-ui'

// 广告活动列表与详情共用的小件（P3-07）：空值写“尚无记录”，不补 0；活动状态标签；带指标的列。公共小件放在页面自己的目录里。

export const NONE = <Muted>尚无记录</Muted>

export const moneyCell = (value: number | null | undefined, currency = 'USD'): ReactNode =>
  value === null || value === undefined ? NONE : <span className="erp-num">{formatMoney(value, currency, { digits: 2 })}</span>
export const numberCell = (value: number | null | undefined): ReactNode => (value === null || value === undefined ? NONE : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)
export const percentCell = (value: number | null | undefined, digits = 1): ReactNode =>
  value === null || value === undefined ? NONE : <span className="erp-num">{formatPercent(value, { digits })}</span>

const STATE_LABEL: Record<string, { text: string; color: string }> = {
  ENABLED: { text: '启用中', color: 'success' },
  PAUSED: { text: '已暂停', color: 'warning' },
  ARCHIVED: { text: '已归档', color: 'default' },
}

/** 活动、广告组、投放对象的状态标签；认不出的状态原样显示。 */
export function EntityStateTag({ state }: { state: string }) {
  const known = STATE_LABEL[state.toUpperCase()]
  return (
    <Tag color={known?.color ?? 'default'} bordered={false}>
      {known?.text ?? state}
    </Tag>
  )
}

/** 页签与区块的数据状态说明：有行时只显示附加说明，没有行时先说状态再说原因。 */
export function TabNote({ state, note }: { state: DashState; note: string | null }) {
  if (state === 'OK') return note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={note} /> : null
  return <Alert type={state === 'NOT_CONNECTED' ? 'info' : 'warning'} showIcon style={{ marginBottom: 8 }} message={STATE_TEXT[state]} description={note ?? undefined} />
}

const orNone = <T extends { metrics: AdsEntityMetrics | null }>(row: T, pick: (metrics: AdsEntityMetrics) => ReactNode) => (row.metrics ? pick(row.metrics) : NONE)

/** 实体指标列：展示、点击、花费、销售额、订单、广告成本销售比；没有指标行的实体显示“尚无记录”。 */
export function metricColumns<T extends { metrics: AdsEntityMetrics | null }>(currency: string): ColumnsType<T> {
  return [
    { title: '展示', key: 'impressions', width: 90, align: 'right', render: (_value, row) => orNone(row, metrics => numberCell(metrics.impressions)) },
    { title: '点击', key: 'clicks', width: 80, align: 'right', render: (_value, row) => orNone(row, metrics => numberCell(metrics.clicks)) },
    { title: '花费', key: 'spend', width: 100, align: 'right', render: (_value, row) => orNone(row, metrics => moneyCell(metrics.spend, currency)) },
    { title: '广告销售额', key: 'sales', width: 110, align: 'right', render: (_value, row) => orNone(row, metrics => moneyCell(metrics.sales, currency)) },
    { title: '订单', key: 'orders', width: 80, align: 'right', render: (_value, row) => orNone(row, metrics => numberCell(metrics.orders)) },
    { title: '广告成本销售比', key: 'acos', width: 120, align: 'right', render: (_value, row) => orNone(row, metrics => percentCell(ratiosOf(metrics)?.acos)) },
  ]
}
