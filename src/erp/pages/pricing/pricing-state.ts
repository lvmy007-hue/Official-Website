import { PRICING_PRICE_WRITE, PRICING_RULE_WRITE, type PriceHealth, type PricingWriteStatus } from '@nova/api-contracts'
import type { GuardInput } from '../../components'

// 定价页的公共状态与动作守卫（P4-11）。

export const PAGE_SIZES = [20, 50, 100] as const

export interface PricingFilters {
  q?: string
  health?: PriceHealth
}

export type WritePermission = typeof PRICING_PRICE_WRITE | typeof PRICING_RULE_WRITE

/** 把服务端判断的写入通道状态转成动作守卫的输入：卡在连接或开关时写明原因并给出前往处理的入口。 */
export function guardOf(permission: WritePermission, status: PricingWriteStatus | undefined): GuardInput {
  if (!status || status.allowed || status.step === 'PERMISSION' || !status.step) return { permission }
  const fix = status.remedyPath ? { label: status.step === 'SWITCH' ? '前往开启' : '前往连接中心', href: status.remedyPath } : undefined
  return {
    permission,
    ...(status.step === 'CONNECTION' ? { connection: { ok: false, reason: status.reason ?? undefined, fix } } : {}),
    ...(status.step === 'SWITCH' ? { writeSwitch: { enabled: false, fix } } : {}),
  }
}

export const HEALTH_COLOR: Record<PriceHealth, string> = {
  WINNING: 'success',
  ABOVE_EXPECTED: 'warning',
  NOT_FEATURED: 'orange',
  NOT_ELIGIBLE: 'error',
  LOST_ELIGIBILITY: 'error',
  NO_COMPETITION: 'default',
  UNKNOWN: 'default',
}

export const OUTCOME_COLOR: Record<string, string> = { SUGGESTED: 'processing', QUEUED: 'blue', APPLIED: 'success', FAILED: 'error', BLOCKED: 'warning', SKIPPED: 'default', DISMISSED: 'default' }

/** 详情页的路径：SKU 要编码，店铺放在参数里。 */
export const detailPath = (sku: string) => `/app/pricing/${encodeURIComponent(sku)}`

/** 价格输入的校验提示；通过返回 null。 */
export function priceInputIssue(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return '请填写价格'
  if (value <= 0) return '价格要大于 0'
  if (value > 100_000) return '价格不能超过 100000'
  return null
}
