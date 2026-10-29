import { Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  SUBSCRIPTION_STATE_LABEL,
  SUBSCRIPTION_STATE_NOTE,
  SUBSCRIPTION_STATE_TONE,
  aggregationLabel,
  type SubscriptionFilterView,
  type SubscriptionItem,
  type SubscriptionTone,
} from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { RowActions } from './subscription-actions'

// 消息推送订阅列表的列（P5-05，09 章 9.7）：推送类型、订阅状态、过滤条件、目的地、最近收到时间、近 24 小时事件数、失败数。
// 没有订阅、接收端没接入的行不写 0：写“未订阅”“尚未接入”。

const TONE_COLOR: Record<SubscriptionTone, string> = { success: 'success', warning: 'warning', error: 'error', default: 'default' }
const sub = { color: 'rgba(0,0,0,0.45)', fontSize: 12 } as const

export function StateTag({ row }: { row: SubscriptionItem }) {
  return (
    <Tooltip title={SUBSCRIPTION_STATE_NOTE[row.state]}>
      <Tag color={TONE_COLOR[SUBSCRIPTION_STATE_TONE[row.state]]} bordered={false} style={{ marginInlineEnd: 0 }}>
        {SUBSCRIPTION_STATE_LABEL[row.state]}
      </Tag>
    </Tooltip>
  )
}

export const filterText = (filter: SubscriptionFilterView | null) => {
  if (!filter) return null
  const parts = [filter.marketplaceIds?.length ? '站点：美国站' : null, filter.aggregationTimePeriod ? `聚合周期：${aggregationLabel(filter.aggregationTimePeriod)}` : null]
  return parts.filter(Boolean).join('；') || null
}

function FilterCell({ row }: { row: SubscriptionItem }) {
  const text = filterText(row.filter)
  if (text) return <span>{text}</span>
  return <Muted>{row.filterable ? (row.id ? '不过滤' : '—') : '不支持过滤'}</Muted>
}

/** 数量单元格：没有订阅且没有事件时不写 0；接收端没接入写“尚未接入”。 */
function CountCell({ row, value, danger }: { row: SubscriptionItem; value: number; danger?: boolean }) {
  if (!row.id && value === 0) return <Muted>{row.state === 'DESTINATION_MISSING' ? '尚未接入' : '未订阅'}</Muted>
  return (
    <span className="erp-num" style={danger && value > 0 ? { color: '#cf1322' } : undefined}>
      {value}
    </span>
  )
}

function DestinationCell({ row }: { row: SubscriptionItem }) {
  if (row.destinationHint) return <span className="erp-num">{row.destinationHint}</span>
  return <Muted>{row.state === 'DESTINATION_MISSING' ? '尚未接入' : '—'}</Muted>
}

export function subscriptionColumns(onDone: (poll?: boolean) => void, showStore: boolean): ColumnsType<SubscriptionItem> {
  const columns: ColumnsType<SubscriptionItem> = [
    {
      title: '推送类型',
      key: 'type',
      width: 250,
      render: (_value, row) => (
        <div>
          <div>{row.label}</div>
          <div style={sub} className="erp-num">
            {row.notificationType}
          </div>
          <Space size={[4, 4]} wrap style={{ marginTop: 2 }}>
            {row.pages.map(page => (
              <Tag key={page} bordered={false} style={{ marginInlineEnd: 0 }}>
                {page}
              </Tag>
            ))}
          </Space>
        </div>
      ),
    },
  ]
  if (showStore) columns.push({ title: '店铺', key: 'store', width: 130, render: (_value, row) => row.storeName })
  columns.push(
    { title: '订阅状态', key: 'state', width: 130, render: (_value, row) => <StateTag row={row} /> },
    { title: '过滤条件', key: 'filter', width: 190, render: (_value, row) => <FilterCell row={row} /> },
    { title: '目的地', key: 'destination', width: 120, render: (_value, row) => <DestinationCell row={row} /> },
    {
      title: '最近收到',
      key: 'lastReceived',
      width: 160,
      render: (_value, row) => (row.lastReceivedAt ? formatDateTime(row.lastReceivedAt) : <Muted>{row.id ? '尚未收到' : '—'}</Muted>),
    },
    { title: '近 24 小时事件数', key: 'events', width: 130, align: 'right', render: (_value, row) => <CountCell row={row} value={row.events24h} /> },
    { title: '失败数', key: 'failures', width: 90, align: 'right', render: (_value, row) => <CountCell row={row} value={row.failures24h} danger /> },
    { title: '操作', key: 'actions', width: 300, fixed: 'right', render: (_value, row) => <RowActions row={row} onDone={onDone} /> },
  )
  return columns
}
