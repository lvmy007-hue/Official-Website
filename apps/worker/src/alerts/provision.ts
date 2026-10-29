import { ALERT_RULE_DEFS } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'

// 为企业补齐系统预置的预警规则（P2a-15）。只补不覆盖：规则已存在（哪怕被企业关闭、改过阈值或范围）就原样保留，
// 所以企业调整过的设置不会在下一轮评估时被冲掉；新增的预置规则会在下一轮评估前自动出现。
// 必须在租户上下文（runWithTenant）里调用。

export const SYSTEM_RULE_AUTHOR = 'system'

/** 返回本次新建的规则代码。 */
export async function ensureDefaultRules(db: PrismaClient, tenantId: string): Promise<string[]> {
  const existing = await db.alertRule.findMany({ where: { tenantId, code: { in: ALERT_RULE_DEFS.map(def => def.code) } }, select: { code: true }, take: 500 })
  const have = new Set(existing.map(row => row.code))
  const created: string[] = []
  for (const def of ALERT_RULE_DEFS) {
    if (have.has(def.code)) continue
    const condition = { type: def.type, params: def.params } as unknown as Prisma.InputJsonValue
    try {
      await db.$transaction(async tx => {
        const rule = await tx.alertRule.create({
          data: { tenantId, code: def.code, domain: def.domain, name: def.name, conditionJson: condition, severity: def.severity, cooldownMinutes: def.cooldownMinutes, enabled: true, scopeJson: {} },
        })
        await tx.alertRuleVersion.create({ data: { tenantId, ruleId: rule.id, versionNo: rule.currentVersion, conditionJson: condition, changedBy: SYSTEM_RULE_AUTHOR, changeReason: '系统预置规则' } })
      })
      created.push(def.code)
    } catch (error) {
      // 并发的另一个进程刚建了同一条规则（企业 + 代码唯一）：视为已存在
      if ((error as { code?: string }).code !== 'P2002') throw error
    }
  }
  return created
}
