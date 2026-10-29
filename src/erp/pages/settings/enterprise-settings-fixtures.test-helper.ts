import {
  AUDIT_LOG_RETENTION_NOTE,
  FIXED_SCHEDULES,
  REFRESH_DOMAINS,
  RETENTION_DEFAULTS,
  RETENTION_KEYS,
  RETENTION_RULES,
  refreshChoicesOf,
  refreshValueText,
  type EnterpriseSettingsResponse,
  type RefreshOverride,
  type RetentionPolicy,
} from '@nova/api-contracts'

// 企业设置页面测试用的接口返回样例（只在测试里使用）：按合约里的规则表生成，和服务端返回的结构一致。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export function settingsData(
  patch: {
    canWrite?: boolean
    retention?: Partial<RetentionPolicy>
    refresh?: Record<string, RefreshOverride>
    risk?: EnterpriseSettingsResponse['risk']
    internal?: Partial<EnterpriseSettingsResponse['internal']>
  } = {},
): EnterpriseSettingsResponse {
  const retention = { ...RETENTION_DEFAULTS, ...patch.retention }
  const overrides = patch.refresh ?? {}
  return {
    canWrite: patch.canWrite ?? true,
    basic: {
      name: '示例企业有限公司',
      slug: 'demo',
      mode: 'LIVE',
      dataTimezone: 'America/Los_Angeles',
      localTimezone: 'Asia/Shanghai',
      defaultCurrency: 'USD',
      version: 1760000000000,
      updatedAt: '2026-10-20T08:00:00.000Z',
    },
    retention: {
      updatedAt: null,
      updatedByName: null,
      version: 0,
      items: RETENTION_KEYS.map(key => ({
        key,
        label: RETENTION_RULES[key].label,
        description: RETENTION_RULES[key].description,
        days: retention[key],
        defaultDays: RETENTION_RULES[key].defaultDays,
        isDefault: retention[key] === RETENTION_RULES[key].defaultDays,
        minDays: RETENTION_RULES[key].minDays,
        maxDays: RETENTION_RULES[key].maxDays,
        impact: RETENTION_RULES[key].impact,
        appliesTo: RETENTION_RULES[key].appliesTo,
      })),
      auditLog: AUDIT_LOG_RETENTION_NOTE,
    },
    refresh: {
      updatedAt: null,
      updatedByName: null,
      version: 0,
      items: REFRESH_DOMAINS.map(domain => ({
        key: domain.key,
        label: domain.label,
        builtInMinutes: domain.builtInMinutes,
        override: overrides[domain.key] ?? null,
        valueText: refreshValueText(domain, overrides[domain.key]),
        choices: refreshChoicesOf(domain),
        impact: domain.impact,
      })),
      fixed: FIXED_SCHEDULES,
      pausedCount: Object.values(overrides).filter(item => item.mode === 'PAUSED').length,
    },
    risk: patch.risk ?? { total: 12, enabled: 9, lastChange: null },
    internal: { state: 'OFF', roleId: null, allowedRangeCount: null, gatewayHeaderRequired: null, supportGrantsActive: 0, supportGrantsInUse: 0, ...patch.internal },
  }
}
