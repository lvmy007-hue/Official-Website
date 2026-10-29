import { useState, type ReactNode } from 'react'
import { Button, Space, Tag } from 'antd'
import type { SettlementStatus } from '@nova/api-contracts'
import { formatDate } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 结算交易页共用：核对状态标签、结算日期（报告里的日期都是 UTC，按 UTC 显示才与报告一致）、游标翻页。

const STATUS_COLOR: Record<SettlementStatus, string> = { MATCHED: 'success', DISCREPANCY: 'error', PENDING: 'default' }
const PENDING_SHORT = { NO_REPORT: '等结算报告', NO_TRANSACTIONS: '等财务交易' } as const

export function StatusTag({ status, label, pendingReason }: { status: SettlementStatus; label: string; pendingReason?: keyof typeof PENDING_SHORT | null }) {
  return (
    <Space size={4} wrap>
      <Tag color={STATUS_COLOR[status]} bordered={false} style={{ marginInlineEnd: 0 }}>
        {label}
      </Tag>
      {status === 'PENDING' && pendingReason ? <Muted>{PENDING_SHORT[pendingReason]}</Muted> : null}
    </Space>
  )
}

export const dayText = (value: string | null | undefined): ReactNode => (value ? <span className="erp-num">{formatDate(value, { timeZone: 'UTC' })}</span> : <Muted>尚无记录</Muted>)

export function periodText(start: string | null, end: string | null): ReactNode {
  if (!start && !end) return <Muted>尚无记录</Muted>
  return (
    <span className="erp-num">
      {start ? formatDate(start, { timeZone: 'UTC' }) : '—'} ~ {end ? formatDate(end, { timeZone: 'UTC' }) : '—'}
    </span>
  )
}

/** 游标翻页：栈顶是当前页的游标，undefined 表示第一页。 */
export function useCursorStack() {
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  return {
    cursor: stack[stack.length - 1],
    page: stack.length,
    reset: () => setStack([undefined]),
    push: (cursor: string) => setStack(current => [...current, cursor]),
    pop: () => setStack(current => current.slice(0, -1)),
  }
}

export function CursorPager({ pager, next, busy }: { pager: ReturnType<typeof useCursorStack>; next: string | null | undefined; busy: boolean }) {
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={pager.page <= 1 || busy} onClick={pager.pop}>
        上一页
      </Button>
      <Button disabled={!next || busy} onClick={() => next && pager.push(next)}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>第 {pager.page} 页</span>
    </Space>
  )
}
