import { Tag } from 'antd'
import { FIRST_MILE_STAGE_LABEL, type FirstMileRow, type FirstMileStage } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'

// 头程物流页面共用的小件：阶段标签、延误说明。金额沿用采购页的显示规则（procurement-ui 的 money）。

const STAGE_COLOR: Record<FirstMileStage, string> = { PLANNED: 'default', IN_TRANSIT: 'processing', ARRIVED: 'cyan', DELIVERED: 'success' }

export function StageTag({ stage }: { stage: FirstMileStage }) {
  return (
    <Tag color={STAGE_COLOR[stage]} bordered={false}>
      {FIRST_MILE_STAGE_LABEL[stage]}
    </Tag>
  )
}

/** 已交付：比预计晚或早几天；未交付且已过预计交付日：已逾期几天；没有预计交付日或还没到期：没有可说的。 */
export function delayText(row: Pick<FirstMileRow, 'stage' | 'delayDays'>) {
  const days = row.delayDays
  if (days === null) return <Muted>{row.stage === 'DELIVERED' ? '未填预计交付日' : '—'}</Muted>
  if (row.stage === 'DELIVERED') {
    if (days === 0) return <span>按期</span>
    return days > 0 ? <Tag color="warning">晚 {days} 天</Tag> : <span className="erp-num">早 {-days} 天</span>
  }
  return days > 0 ? <Tag color="error">已逾期 {days} 天</Tag> : <Muted>—</Muted>
}

/** 日期输入留空时不带键；填了原样返回。 */
export const dateOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
