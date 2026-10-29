import type { ReactNode } from 'react'
import { Tag } from 'antd'
import type { CashSourceState } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'

// 回款与现金流页共用（P2b-08）：日期是接口给的日历日文本（YYYY-MM-DD，企业时区），直接显示；金额不可用显示“不可用”，不显示 0。

export const dayText = (value: string | null | undefined): ReactNode => (value ? <span className="erp-num">{value}</span> : <Muted>尚无记录</Muted>)

/** 金额：来源不可用（null）写“不可用”，绝不写 0。 */
export const cash = (value: number | null | undefined, currency: string): ReactNode => (value === null || value === undefined ? <Muted>不可用</Muted> : money(value, currency))

/** 带正负号的净额：负数显示红色，方便一眼看出哪一周资金流出。 */
export const signedCash = (value: number, currency: string): ReactNode => <span style={value < 0 ? { color: '#cf1322' } : undefined}>{money(value, currency)}</span>

const SOURCE_LABEL: Record<CashSourceState, string> = { OK: '已计入', RESTRICTED: '无权限', OUT_OF_SCOPE: '不适用', NOT_CONNECTED: '尚未接入' }
const SOURCE_COLOR: Record<CashSourceState, string> = { OK: 'success', RESTRICTED: 'warning', OUT_OF_SCOPE: 'default', NOT_CONNECTED: 'default' }

export const SourceTag = ({ state }: { state: CashSourceState }) => (
  <Tag color={SOURCE_COLOR[state]} bordered={false} style={{ marginInlineEnd: 0 }}>
    {SOURCE_LABEL[state]}
  </Tag>
)
