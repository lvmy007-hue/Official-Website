import type { AdsRuleActionType, AdsRuleHit, AdsRuleLevel, AdsWriteOp } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { submitAutoWrite, type AutoWriteDeps, type AutoWriteResult } from '../ads-write/submit'

// 自动规则的自动执行（P3-17）：命中的活动与投放词提交写入（来源 AUTO_RULE），搜索词层级没有所属广告组，不在这里处理（调用方只生成待办）。
// 规则评估里的对象键：活动是系统编号；投放词是亚马逊的投放编号或关键词编号，这里先换成系统编号再提交。

/** 这个层级的规则能不能自动执行。 */
export const canAutoExecute = (level: AdsRuleLevel): boolean => level === 'CAMPAIGN' || level === 'TARGET'

const STATE_OF: Partial<Record<AdsRuleActionType, 'PAUSED' | 'ENABLED'>> = { PAUSE: 'PAUSED', ENABLE: 'ENABLED' }

/** 命中 → 写入内容；不支持或内容算不出来时返回原因文字。 */
export async function opOfHit(db: PrismaClient, rule: { tenantId: string; adsProfileId: string; level: AdsRuleLevel }, hit: AdsRuleHit): Promise<AdsWriteOp | string> {
  const state = STATE_OF[hit.actionType]
  const amount = hit.after === null ? Number.NaN : Number(hit.after)
  if (rule.level === 'CAMPAIGN') {
    if (state) return { kind: 'CAMPAIGN_STATE', entityId: hit.key, state }
    if (hit.actionType === 'ADJUST_BUDGET') return Number.isFinite(amount) ? { kind: 'CAMPAIGN_BUDGET', entityId: hit.key, amount } : '规则没有算出新的日预算，没有提交'
    return '这个动作不能自动执行'
  }
  if (rule.level === 'TARGET') {
    if (!state && hit.actionType !== 'ADJUST_BID') return '这个动作不能自动执行'
    const where = { tenantId: rule.tenantId, adsProfileId: rule.adsProfileId }
    const keyword = await db.adsKeyword.findFirst({ where: { ...where, keywordId: hit.key }, select: { id: true } })
    const target = keyword ? null : await db.adsTarget.findFirst({ where: { ...where, targetId: hit.key }, select: { id: true } })
    const entityId = keyword?.id ?? target?.id
    if (!entityId) return '投放对象已不存在，没有提交'
    if (state) return { kind: 'TARGET_STATE', entityId, state }
    return Number.isFinite(amount) ? { kind: 'TARGET_BID', entityId, amount } : '规则没有算出新的竞价，没有提交'
  }
  return '搜索词层级的动作需要所属广告组，只生成待办'
}

export async function executeRuleHit(deps: AutoWriteDeps, rule: { tenantId: string; adsProfileId: string; level: AdsRuleLevel; id: string }, hit: AdsRuleHit, now: Date): Promise<AutoWriteResult> {
  const op = await opOfHit(deps.db, rule, hit)
  if (typeof op === 'string') return { status: 'SKIPPED', reason: op }
  return submitAutoWrite(deps, { tenantId: rule.tenantId, source: 'AUTO_RULE', op, requestId: `ads-rule:${rule.id}:${now.toISOString()}` })
}
