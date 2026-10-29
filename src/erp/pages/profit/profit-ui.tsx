import type { ReactNode } from 'react'
import { Alert, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ProfitBridgeItem, ProfitBridgeView, ProfitItemState, ProfitOverviewResponse } from '@nova/api-contracts'
import { DataState, FreshnessBar, SimpleGrid, stateFromError } from '../../components'
import { formatMoney, formatPercent } from '../../format'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'

// 利润分析各页签共用：外框（新鲜度、错误、口径说明）、金额与利润率的显示、利润桥明细表。
// 没有数据写“尚无记录”，没有数据来源写“尚未接入”，没有权限写“无权限”，绝不写 0。

export type ProfitCommonView = Pick<ProfitOverviewResponse, 'state' | 'note' | 'basisLabel' | 'basisNote' | 'currency' | 'range' | 'freshness'>

export const margin = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>

/** 带正负号的金额：负数红色。 */
export const signedMoney = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? (
    <Muted>尚无记录</Muted>
  ) : (
    <span className="erp-num" style={value < 0 ? { color: '#cf1322' } : undefined}>
      {formatMoney(value, 'USD', { digits: 2, sign: true })}
    </span>
  )

type QueryLike<T> = { data?: T; error: unknown; refetch: () => unknown }

export function ProfitFrame<T extends ProfitCommonView>({ query, testId, children }: { query: QueryLike<T>; testId: string; children: (data: T) => ReactNode }) {
  const data = query.data
  return (
    <div data-testid={testId}>
      <FreshnessBar freshness={data?.freshness} />
      {query.error ? (
        <DataState {...stateFromError(describeError(query.error), { permission: 'profit.read', onRetry: () => void query.refetch() })} />
      ) : !data ? (
        <DataState kind="skeleton" rows={5} />
      ) : (
        <>
          {data.range.defaulted ? (
            <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前显示 ${data.range.from} 至 ${data.range.to} 的利润（最近 ${data.range.days} 天）`} />
          ) : null}
          {data.note ? <Alert type={data.state === 'NO_DATA' ? 'info' : 'warning'} showIcon style={{ margin: '8px 0' }} message={data.note} data-testid="profit-note" /> : null}
          <p style={{ margin: '4px 0 8px', color: 'rgba(0,0,0,0.65)' }}>
            口径：{data.basisLabel}。{data.basisNote} 金额单位 {data.currency}。
          </p>
          {children(data)}
        </>
      )}
    </div>
  )
}

const STATE_TEXT: Record<Exclude<ProfitItemState, 'OK'>, string> = { NO_DATA: '尚无记录', NOT_CONNECTED: '尚未接入', RESTRICTED: '无权限' }
const STATE_COLOR: Record<ProfitItemState, string> = { OK: 'success', NO_DATA: 'default', NOT_CONNECTED: 'default', RESTRICTED: 'warning' }

export const StateTag = ({ state }: { state: ProfitItemState }) => (
  <Tag color={STATE_COLOR[state]} bordered={false} style={{ marginInlineEnd: 0 }}>
    {state === 'OK' ? '有数据' : STATE_TEXT[state]}
  </Tag>
)

/** 利润桥项目的金额：没有数的项目写明为什么没有。 */
export const itemAmount = (item: ProfitBridgeItem): ReactNode => (item.value === null ? <Muted>{item.state === 'OK' ? '尚无记录' : STATE_TEXT[item.state]}</Muted> : money(item.value))

const bridgeColumns: ColumnsType<ProfitBridgeItem> = [
  { title: '项目', dataIndex: 'label', width: 150, render: (value: string, row) => (row.key === 'NET_PROFIT' ? <strong>{value}</strong> : value) },
  { title: '金额', key: 'value', width: 130, align: 'right', render: (_value, row) => itemAmount(row) },
  { title: '对净利润的影响', key: 'contribution', width: 150, align: 'right', render: (_value, row) => (row.contribution === null ? <Muted>—</Muted> : signedMoney(row.contribution)) },
  { title: '状态', key: 'state', width: 100, render: (_value, row) => <StateTag state={row.state} /> },
  { title: '说明', dataIndex: 'note', render: (value: string | null) => value ?? '' },
]

/** 利润桥逐项明细：收入为正、花费为负，最后是净利润；没有数据来源的项目写明“尚未接入”。 */
export function BridgeTable({ view, testId }: { view: ProfitBridgeView; testId?: string }) {
  return (
    <div data-testid={testId}>
      <SimpleGrid<ProfitBridgeItem>
        gridId="profit.bridge"
        columns={bridgeColumns}
        rows={view.items}
        rowKey={row => row.key}
        emptyState={{ kind: 'empty', domain: '利润桥', prerequisite: '所选范围内尚无利润数据。' }}
      />
    </div>
  )
}
