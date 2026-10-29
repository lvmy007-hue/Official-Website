import type { BatchStatus, ReplenishAction } from '@nova/api-contracts'

// 批次状态由动作推出（纯函数）：每条建议都有动作 → 已结束；否则有草稿 → 已生成草稿；否则有采纳或调整 → 已确认；否则待审。
// 忽略也算“已处理”。已结束的批次再追加动作时仍按同一规则重新推出，不会卡死。

const DRAFTS: readonly ReplenishAction[] = ['PURCHASE_DRAFT', 'INBOUND_DRAFT', 'AWD_DRAFT']
const CONFIRMS: readonly ReplenishAction[] = ['ADOPT', 'ADJUST']

export function batchStatusOf(recommendationIds: readonly string[], actions: ReadonlyArray<{ recommendationId: string; action: string }>): BatchStatus {
  const handled = new Set(actions.map(item => item.recommendationId))
  if (recommendationIds.length > 0 && recommendationIds.every(id => handled.has(id))) return 'CLOSED'
  if (actions.some(item => DRAFTS.includes(item.action as ReplenishAction))) return 'DRAFTED'
  if (actions.some(item => CONFIRMS.includes(item.action as ReplenishAction))) return 'CONFIRMED'
  return 'PENDING_REVIEW'
}

/**
 * 去掉已被取代的“只登记”动作：以前入仓计划草稿只能登记意向（PENDING_TARGET），P6-08 补建出真实草稿后同一条建议会多出一条已完成（DONE）的同类动作；
 * 动作只增不改，所以旧的登记行还在，展示与统计时要把它当成已解决，免得页面一边说“已在草稿里”一边说“只登记了没生成”。
 */
export function effectiveActions<T extends { recommendationId: string; action: string; status: string }>(actions: readonly T[]): T[] {
  const done = new Set(actions.filter(item => item.status === 'DONE').map(item => `${item.action}|${item.recommendationId}`))
  return actions.filter(item => !(item.status === 'PENDING_TARGET' && done.has(`${item.action}|${item.recommendationId}`)))
}
