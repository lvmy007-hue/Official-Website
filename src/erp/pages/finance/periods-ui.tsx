import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { CHECK_STATE_LABEL, PERIOD_STATUS_LABEL, type CheckState, type PeriodStatus } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'

// 期间关账页共用的小件：期间状态与检查结果标签、日期与人员的写法（没有就写“尚无记录”，不写空白或 0）。

const STATUS_COLOR: Record<PeriodStatus, string> = { OPEN: 'default', CLOSING: 'processing', CLOSED: 'success', REOPENED: 'warning' }
const CHECK_COLOR: Record<CheckState, string> = { PASS: 'success', FAIL: 'error', NOT_CONNECTED: 'default', ACKNOWLEDGED: 'warning' }

export function PeriodStatusTag({ status }: { status: PeriodStatus }) {
  return (
    <Tag color={STATUS_COLOR[status]} bordered={false} style={{ marginInlineEnd: 0 }}>
      {PERIOD_STATUS_LABEL[status]}
    </Tag>
  )
}

export function CheckStateTag({ state }: { state: CheckState }) {
  return (
    <Tag color={CHECK_COLOR[state]} bordered={false} style={{ marginInlineEnd: 0 }}>
      {CHECK_STATE_LABEL[state]}
    </Tag>
  )
}

/** 期间的日期范围，例如 2026-09-01 ~ 2026-09-30（企业数据口径时区的日历日）。 */
export const rangeText = (start: string, end: string): ReactNode => (
  <span className="erp-num">
    {start} ~ {end}
  </span>
)

export const personText = (name: string | null | undefined): ReactNode => (name ? name : <Muted>尚无记录</Muted>)

/** 最近一次检查的结论：没检查过是“尚未检查”。 */
export const checkText = (passed: boolean | null): ReactNode => (passed === null ? <Muted>尚未检查</Muted> : passed ? '已通过' : '未通过')
