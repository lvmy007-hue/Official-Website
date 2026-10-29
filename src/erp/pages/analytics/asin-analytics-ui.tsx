import type { ReactNode } from 'react'
import { Alert, Tag } from 'antd'
import { INVENTORY_RISK_LABEL, type AsinMetricKey, type DashState, type InventoryRiskLevel } from '@nova/api-contracts'
import { Muted, STATE_LABEL } from '../inventory/inventory-ui'
import { RISK_COLOR, formatAsin } from './asin-analytics-options'

// ASIN 与父体分析各处共用的小件：数值（没有值写“尚无记录”，绝不写 0）、库存风险标签、非“有数据”状态的整块说明。

export const AsinFigure = ({ metric, value }: { metric: AsinMetricKey; value: number | null | undefined }): ReactNode =>
  value === null || value === undefined ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatAsin(metric, value)}</span>

export const RiskBadge = ({ risk }: { risk: InventoryRiskLevel | null }) =>
  risk ? (
    <Tag color={RISK_COLOR[risk]} bordered={false} style={{ marginInlineEnd: 0 }}>
      {INVENTORY_RISK_LABEL[risk]}
    </Tag>
  ) : (
    <Muted>尚无记录</Muted>
  )

/** 某个数据块不是“有数据”时的一行说明：先说状态，再说原因。 */
export function StateNote({ state, note, testId }: { state: DashState; note: string | null | undefined; testId: string }) {
  if (state === 'OK' && !note) return null
  const label = STATE_LABEL[state]
  return <Alert type={state === 'OK' ? 'info' : 'warning'} showIcon style={{ margin: '8px 0' }} message={label ? `${label}：${note ?? ''}` : note} data-testid={testId} />
}
