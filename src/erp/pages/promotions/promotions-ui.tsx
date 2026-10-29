import type { ReactNode } from 'react'
import { Alert, Tag } from 'antd'
import {
  PROMOTIONS_ROLE_GUIDE,
  PROMOTION_STATUS_TONE,
  type PromotionPlatformFee,
  type PromotionReported,
  type PromotionRow,
  type PromotionSectionState,
  type PromotionStatus,
  type PromotionSync,
} from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 促销页面共用的小件（P4-05）：状态标签、同步提示、各种“没有数据”的统一写法。
// 原则：任何没有数字的地方都写原因（尚无记录 / 尚未接入 / 无权限 / 不适用……），绝不拿 0 冒充；估算出来的数字旁边标“估算”。

export function PromotionStatusTag({ row }: { row: Pick<PromotionRow, 'status' | 'statusLabel'> }) {
  return (
    <Tag color={PROMOTION_STATUS_TONE[row.status as PromotionStatus] ?? 'default'} bordered={false}>
      {row.statusLabel}
    </Tag>
  )
}

/** 同步状态提示：接口角色没批时给申请方式；同步失败或延迟时给原因；其余不打扰。 */
export function SyncNotice({ sync }: { sync: PromotionSync }) {
  if (sync.rolePending) return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="促销同步未授权" description={PROMOTIONS_ROLE_GUIDE} data-testid="promotions-role-pending" />
  if (sync.status === 'FAILED' || sync.status === 'UNAUTHORIZED' || sync.status === 'DELAYED') {
    return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`促销同步：${sync.statusLabel}`} description={sync.errorMessage ?? undefined} />
  }
  return null
}

/** 各页签状态对应的“没有数字”文字。 */
export const SECTION_EMPTY: Record<PromotionSectionState, string> = {
  OK: '尚无记录',
  NO_DATA: '尚无记录',
  NOT_CONNECTED: '尚未接入',
  RESTRICTED: '无权限',
  NOT_STARTED: '尚未开始',
  NO_EFFECT: '不适用',
  NO_ITEMS: '无商品清单',
  INSUFFICIENT: '数据不足',
}

export const moneyOr = (value: number | null | undefined, state: PromotionSectionState = 'NO_DATA'): ReactNode =>
  value === null || value === undefined ? <Muted>{SECTION_EMPTY[state]}</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>

export const countOr = (value: number | null | undefined, state: PromotionSectionState = 'NO_DATA', digits = 0): ReactNode =>
  value === null || value === undefined ? <Muted>{SECTION_EMPTY[state]}</Muted> : <span className="erp-num">{formatNumber(value, { digits })}</span>

/** 绩效报告里的一列：有行但报告没给这一列写“未提供”，没有行写“尚无记录”，报告没接入写“尚未接入”。 */
export function reportedCell(reported: PromotionReported, pick: (value: PromotionReported) => number | null, money = false): ReactNode {
  if (reported.state === 'NOT_CONNECTED') return <Muted>尚未接入</Muted>
  if (reported.state === 'NO_RECORD') return <Muted>尚无记录</Muted>
  const value = pick(reported)
  if (value === null) return <Muted>报告未提供</Muted>
  return money ? moneyOr(value) : countOr(value)
}

const FEE_EMPTY: Record<Exclude<PromotionPlatformFee['state'], 'OK'>, string> = {
  NO_DATA: '尚无记录',
  RESTRICTED: '无权限',
  NO_ITEMS: '无商品清单',
  NOT_APPLICABLE: '不适用',
  INCOMPLETE: '数据过多未读完',
}

export const platformFeeCell = (fee: PromotionPlatformFee): ReactNode =>
  fee.state === 'OK' && fee.amount !== null ? moneyOr(fee.amount) : <Muted>{FEE_EMPTY[fee.state === 'OK' ? 'NO_DATA' : fee.state]}</Muted>

/** 页签顶部的状态说明：不是“有数据”时说明原因；有数据但带提示（上限、没读全）时给一条提示。 */
export function SectionNote({ state, note }: { state: PromotionSectionState; note: string | null }) {
  if (!note) return null
  const type = state === 'OK' ? 'info' : state === 'RESTRICTED' || state === 'INSUFFICIENT' ? 'warning' : 'info'
  return <Alert type={type} showIcon style={{ marginBottom: 12 }} message={state === 'OK' ? note : `${SECTION_EMPTY[state]}：${note}`} data-testid="section-note" />
}

/** 估算数字旁边的标记：基线法与回报率都是模型估算，不是亚马逊给的数字。 */
export const EstimateTag = () => (
  <Tag bordered={false} color="gold" style={{ marginLeft: 6 }}>
    估算
  </Tag>
)
