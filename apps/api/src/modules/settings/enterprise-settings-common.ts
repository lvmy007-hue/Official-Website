import {
  RETENTION_SETTING_KEY,
  REFRESH_SETTING_KEY,
  REFRESH_DOMAINS,
  RETENTION_KEYS,
  RETENTION_RULES,
  refreshChoicesOf,
  refreshPolicyOf,
  refreshValueText,
  retentionPolicyOf,
  type InternalAccessView,
  type RefreshItemView,
  type RefreshPolicy,
  type RetentionItemView,
  type RetentionPolicy,
  type RiskRulesSummary,
  type SettingsEditor,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { readInternalAccessConfig } from '../auth'

// 企业设置读取用到的小件（P5-10）：从企业设置项还原策略、拼卡片行、风险规则摘要、内部访问模式状态。

export type StoredSetting = { key: string; valueJson: unknown; version: number; updatedAt: Date; updatedBy: string }

export async function loadStoredSettings(prisma: Pick<PrismaService, 'tenantSetting'>, tenantId: string): Promise<Map<string, StoredSetting>> {
  const rows = await prisma.tenantSetting.findMany({
    where: { tenantId, sellerAccountId: null, key: { in: [RETENTION_SETTING_KEY, REFRESH_SETTING_KEY] } },
    select: { key: true, valueJson: true, version: true, updatedAt: true, updatedBy: true },
    take: 10,
  })
  return new Map(rows.map(row => [row.key, row]))
}

export const editorOf = (row: StoredSetting | undefined, names: ReadonlyMap<string, string>, formerLabel: string): SettingsEditor => ({
  updatedAt: row ? row.updatedAt.toISOString() : null,
  updatedByName: row ? (names.get(row.updatedBy) ?? formerLabel) : null,
})

export function retentionItems(policy: RetentionPolicy): RetentionItemView[] {
  return RETENTION_KEYS.map(key => {
    const rule = RETENTION_RULES[key]
    return {
      key,
      label: rule.label,
      description: rule.description,
      days: policy[key],
      defaultDays: rule.defaultDays,
      isDefault: policy[key] === rule.defaultDays,
      minDays: rule.minDays,
      maxDays: rule.maxDays,
      impact: rule.impact,
      appliesTo: rule.appliesTo,
    }
  })
}

export function refreshItems(policy: RefreshPolicy): RefreshItemView[] {
  return REFRESH_DOMAINS.map(domain => ({
    key: domain.key,
    label: domain.label,
    builtInMinutes: domain.builtInMinutes,
    override: policy[domain.key] ?? null,
    valueText: refreshValueText(domain, policy[domain.key]),
    choices: refreshChoicesOf(domain),
    impact: domain.impact,
  }))
}

export const storedRetention = (row: StoredSetting | undefined) => retentionPolicyOf(row?.valueJson)
export const storedRefresh = (row: StoredSetting | undefined) => refreshPolicyOf(row?.valueJson)

export async function riskSummary(prisma: Pick<PrismaService, 'alertRule' | 'alertRuleVersion'>, tenantId: string): Promise<RiskRulesSummary> {
  const [total, enabled, last] = await Promise.all([
    prisma.alertRule.count({ where: { tenantId } }),
    prisma.alertRule.count({ where: { tenantId, enabled: true } }),
    // 版本 1 是预置规则创建时写下的，不算“修改”
    prisma.alertRuleVersion.findFirst({ where: { tenantId, versionNo: { gt: 1 } }, orderBy: { createdAt: 'desc' }, select: { versionNo: true, createdAt: true, rule: { select: { name: true } } } }),
  ])
  return { total, enabled, lastChange: last ? { ruleName: last.rule.name, versionNo: last.versionNo, changedAt: last.createdAt.toISOString() } : null }
}

/** 内部访问模式由部署配置控制；本企业不是被绑定的企业时不透露绑定了谁，也不返回地址段与校验头的具体内容。 */
export async function internalAccessView(prisma: Pick<PrismaService, 'platformSupportAccess'>, tenantId: string, now = new Date()): Promise<InternalAccessView> {
  const [active, inUse] = await Promise.all([
    prisma.platformSupportAccess.count({ where: { tenantId, revokedAt: null, expiresAt: { gt: now } } }),
    prisma.platformSupportAccess.count({ where: { tenantId, revokedAt: null, expiresAt: { gt: now }, claimedAt: { not: null } } }),
  ])
  const support = { supportGrantsActive: active, supportGrantsInUse: inUse }
  try {
    const config = readInternalAccessConfig()
    if (!config.enabled) return { state: 'OFF', roleId: null, allowedRangeCount: null, gatewayHeaderRequired: null, ...support }
    if (config.tenantId !== tenantId) return { state: 'ON_OTHER_TENANT', roleId: null, allowedRangeCount: null, gatewayHeaderRequired: null, ...support }
    return { state: 'ON_THIS_TENANT', roleId: config.roleId, allowedRangeCount: config.allowedCidrs.length, gatewayHeaderRequired: Boolean(config.gatewayHeader), ...support }
  } catch {
    return { state: 'MISCONFIGURED', roleId: null, allowedRangeCount: null, gatewayHeaderRequired: null, ...support }
  }
}
