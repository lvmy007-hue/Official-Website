import type { ReactNode } from 'react'
import { Button, Select, Space, Tag } from 'antd'
import { CASE_STATUS_LABEL, type CaseStatus } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'

// 赔付中心页面共用的小件：案件状态标签、金额写法、游标翻页条、下拉筛选。
// 没有数据的写法：应收没填写“尚未填写”、估算没有商品成本写“无商品成本，无法估算”、实收为 0 写“尚无到账”，任何时候都不拿 0 冒充。

const STATUS_COLOR: Record<CaseStatus, string> = {
  OPPORTUNITY: 'default',
  SUBMITTED: 'processing',
  IN_PROGRESS: 'processing',
  APPROVED: 'cyan',
  PARTIAL: 'warning',
  REJECTED: 'error',
  PAID: 'success',
}

export function CaseStatusTag({ status }: { status: CaseStatus }) {
  return (
    <Tag color={STATUS_COLOR[status]} bordered={false}>
      {CASE_STATUS_LABEL[status]}
    </Tag>
  )
}

export const amountOr = (value: number | null | undefined, currency: string | null | undefined, empty: string): ReactNode =>
  value === null || value === undefined ? <Muted>{empty}</Muted> : money(value, currency ?? 'USD')

export const receivedText = (value: number, currency: string | null): ReactNode => (value > 0 ? money(value, currency ?? 'USD') : <Muted>尚无到账</Muted>)

export const dayText = (value: string | null | undefined): ReactNode => (value ? <span className="erp-num">{value.slice(0, 10)}</span> : <Muted>尚无记录</Muted>)

export const PAGE_SIZES = [20, 50, 100]

/** 游标翻页：栈顶是当前页的游标，undefined 表示第一页。 */
export function Pager({ stack, next, busy, onStack }: { stack: Array<string | undefined>; next: string | null; busy: boolean; onStack: (stack: Array<string | undefined>) => void }) {
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={stack.length <= 1 || busy} onClick={() => onStack(stack.slice(0, -1))}>
        上一页
      </Button>
      <Button disabled={!next || busy} onClick={() => next && onStack([...stack, next])}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>第 {stack.length} 页</span>
    </Space>
  )
}

export function Pick({
  label,
  value,
  options,
  onChange,
  width = 140,
}: {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear optionFilterProp="label" style={{ width }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}
