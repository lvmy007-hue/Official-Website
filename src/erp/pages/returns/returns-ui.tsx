import type { ReactNode } from 'react'
import { Tag, Tooltip } from 'antd'
import type { ReturnDispositionGroup, ReturnDispositionView, ReturnReimbursementView } from '@nova/api-contracts'
import { formatPercent } from '../../format'
import { Muted, LiveLink } from '../inventory/inventory-ui'

// 退货页面共用的小件：处置标签、赔付状态、退货率显示。金额与时间显示沿用订单页的写法（没有数据写“尚无记录”，不写 0）。

const DISPOSITION_COLOR: Record<ReturnDispositionGroup, string> = {
  SELLABLE: 'success',
  DAMAGED: 'error',
  CARRIER_DAMAGED: 'error',
  WAREHOUSE_DAMAGED: 'error',
  DEFECTIVE: 'warning',
  EXPIRED: 'warning',
  OTHER: 'default',
  UNKNOWN: 'default',
}

/** 处置：可售绿色，损坏类红色；报告没给处置时写“处置未知”，官方新增的值显示原值。 */
export function DispositionTag({ view }: { view: ReturnDispositionView }) {
  if (view.group === 'UNKNOWN') return <Muted>{view.label}</Muted>
  const text = view.group === 'OTHER' ? (view.raw ?? view.label) : view.label
  const tag = (
    <Tag color={DISPOSITION_COLOR[view.group]} bordered={false}>
      {text}
    </Tag>
  )
  return view.raw && view.group !== 'OTHER' ? <Tooltip title={`报告原值：${view.raw}`}>{tag}</Tooltip> : tag
}

/** 原因大类：没有原因写“尚无记录”；映射表里还没补全的“未分类”用提示色标出来，提醒去补全。 */
export function CategoryText({ category }: { category: string | null | undefined }) {
  if (!category) return <Muted>尚无记录</Muted>
  return category === '未分类' ? (
    <Tag color="warning" bordered={false}>
      未分类
    </Tag>
  ) : (
    <span>{category}</span>
  )
}

/** 退货率（0 到 1 的小数）：没有销售件数时写“尚无记录”，不写 0%。 */
export const rateText = (value: number | null | undefined): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(value, { digits: 2 })}</span>

/** 赔付状态：已建案件且赔付中心页面已上线时才给链接。 */
export function ReimbursementCell({ view }: { view: ReturnReimbursementView }) {
  if (view.state === 'NOT_REVIEWED') return <Muted>{view.label}</Muted>
  const color = view.state === 'AMAZON_REIMBURSED' ? 'success' : view.state === 'CASE_LINKED' ? 'processing' : 'default'
  const tag = (
    <Tag color={color} bordered={false}>
      {view.label}
    </Tag>
  )
  return view.caseId ? (
    <LiveLink component="ReimbursementDetailPage" id={view.caseId}>
      {tag}
    </LiveLink>
  ) : (
    tag
  )
}
