import { PROMOTION_NO_EFFECT_STATUSES, promotionStatusLabel, type PromotionSectionState } from '@nova/api-contracts'
import type { ResolvedScope } from '../auth'
import type { PromotionRecord } from './promotions-common'

// 促销详情各页签共用的上下文（P4-05）：已读到的促销、商品 ASIN、活动期间与时区。

export type DetailRow = PromotionRecord & { feeJson: unknown; issuesJson: unknown }

export interface DetailContext {
  tenantId: string
  scope: ResolvedScope
  permissions: readonly string[]
  row: DetailRow
  zone: string
  today: string
  now: Date
  /** 商品清单里的 ASIN（去重，最多读到上限）；按目录选品的促销或清单还没同步时为空。 */
  asins: string[]
  /** 商品清单没读全（同步时截断或超过这里的读取上限）。 */
  asinsPartial: boolean
  /** 两份绩效报告是否成功同步过（区分“尚未接入”与“报告里没有这个促销”）。 */
  reportConnected: { promotion: boolean; coupon: boolean }
  /** 活动期间（本地日期，截至今天）；还没开始为 null。 */
  window: { from: string; to: string; days: number } | null
}

/** 活动没有产生数据的几种情况：直接给出该页签的状态与说明，不去算。 */
export function gateOf(ctx: DetailContext): { state: PromotionSectionState; note: string } | null {
  const { row } = ctx
  if (PROMOTION_NO_EFFECT_STATUSES.includes(row.status)) return { state: 'NO_EFFECT', note: `促销状态为“${promotionStatusLabel(row.status)}”，不会产生销售效果` }
  if (!ctx.window) return { state: 'NOT_STARTED', note: '促销还没有开始，开始后才有数据' }
  if (ctx.asins.length === 0) {
    return { state: 'NO_ITEMS', note: row.selectionType === 'CATALOG' ? '这是按目录选品的促销，没有商品清单，无法按商品估算' : '商品清单尚未同步或为空，无法按商品估算' }
  }
  return null
}

export const PARTIAL_NOTE = '商品清单没有读全，这里只含已读到的商品'
