import { z } from 'zod'
import { INBOUND_CLAIM_WAIT_DAYS, INBOUND_CLAIM_WINDOW_DAYS, OPPORTUNITY_RULES, type OpportunityRule } from './receiving.js'

// 赔付机会的时限（P2b-03，07 章 7.3“时限按亚马逊当期政策在设置中配置”）：每类机会两个数字，都从该类机会的起算日算起——
// 等待期（waitDays）内先等亚马逊自己调查与自动赔付，过了才算“可以申请”；申请期限（windowDays）一过就算过期。
// 起算日：入仓差异＝货件关闭日；仓内丢失与损坏＝台账调整日；退款未退货＝第一笔退款入账日；退货处置异常＝退货日；移除丢失＝移除订单最近更新日；费用多收＝费用发生日。
// 这些默认值没有对照亚马逊当期政策逐条核实（只有入仓差异沿用 P2a-13 的 45 天与 540 天），页面上写明“默认值”，企业可以在设置里改。

export interface RuleWindow {
  waitDays: number
  windowDays: number
}
export type ReimbursementWindows = Record<OpportunityRule, RuleWindow>

export const REIMBURSEMENT_WINDOW_DEFAULTS: Readonly<ReimbursementWindows> = {
  INBOUND_DISCREPANCY: { waitDays: INBOUND_CLAIM_WAIT_DAYS, windowDays: INBOUND_CLAIM_WINDOW_DAYS },
  LEDGER_LOST: { waitDays: 45, windowDays: 540 },
  LEDGER_DAMAGED: { waitDays: 45, windowDays: 540 },
  REFUND_NO_RETURN: { waitDays: 30, windowDays: 105 },
  RETURN_DISPOSITION: { waitDays: 0, windowDays: 540 },
  FEE_OVERCHARGE: { waitDays: 0, windowDays: 540 },
  REMOVAL_LOST: { waitDays: 45, windowDays: 540 },
}

export const RuleWindowSchema = z
  .object({
    waitDays: z.number().int('必须是整数').min(0, '不能小于 0').max(365, '等待期最长 365 天'),
    windowDays: z.number().int('必须是整数').min(1, '至少 1 天').max(1095, '申请期限最长 1095 天'),
  })
  .refine(value => value.waitDays <= value.windowDays, '等待期不能长于申请期限')

export const ReimbursementWindowsSchema = z.object({
  INBOUND_DISCREPANCY: RuleWindowSchema,
  LEDGER_LOST: RuleWindowSchema,
  LEDGER_DAMAGED: RuleWindowSchema,
  REFUND_NO_RETURN: RuleWindowSchema,
  RETURN_DISPOSITION: RuleWindowSchema,
  FEE_OVERCHARGE: RuleWindowSchema,
  REMOVAL_LOST: RuleWindowSchema,
})

/** 企业设置项里存的值（可能缺某类或被人改坏）→ 完整的时限：每类单独校验，不合格的那一类回到默认值。 */
export function resolveWindows(stored: unknown): ReimbursementWindows {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  const out = { ...REIMBURSEMENT_WINDOW_DEFAULTS } as ReimbursementWindows
  for (const rule of OPPORTUNITY_RULES) {
    const parsed = RuleWindowSchema.safeParse(source[rule])
    if (parsed.success) out[rule] = parsed.data
  }
  return out
}
