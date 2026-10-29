import { describe, expect, it } from 'vitest'
import {
  AUDIT_LOG_RETENTION_NOTE,
  REFRESH_DOMAINS,
  REFRESH_MINUTE_OPTIONS,
  RETENTION_DEFAULTS,
  RETENTION_KEYS,
  RETENTION_RULES,
  minutesText,
  refreshChoicesOf,
  refreshDomainOf,
  refreshPolicyOf,
  refreshValueText,
  refreshVerdict,
  retentionPolicyOf,
} from './enterprise-settings.js'
import { RefreshPolicySchema, RetentionPolicySchema, SettingsUpdateBodySchema } from './enterprise-settings-query.js'
import { TENANT_SETTING_DEFAULTS, TENANT_SETTING_SCHEMAS, PREFERENCE_KEYS } from './settings.js'

const reason = '与会计确认后调整'
const orders = refreshDomainOf('FBA_ORDERS')!

describe('数据保留', () => {
  it('默认值与规则一致，买家信息最长 30 天（亚马逊要求）', () => {
    for (const key of RETENTION_KEYS) {
      const rule = RETENTION_RULES[key]
      expect(RETENTION_DEFAULTS[key]).toBe(rule.defaultDays)
      expect(rule.defaultDays).toBeGreaterThanOrEqual(rule.minDays)
      expect(rule.defaultDays).toBeLessThanOrEqual(rule.maxDays)
    }
    expect(RETENTION_RULES.customerInfoDays.maxDays).toBe(30)
  })

  it('retentionPolicyOf：缺失、超范围、不是整数的项用默认值，其余保留', () => {
    expect(retentionPolicyOf(undefined)).toEqual(RETENTION_DEFAULTS)
    expect(retentionPolicyOf(null)).toEqual(RETENTION_DEFAULTS)
    expect(retentionPolicyOf({ rawReportDays: 90, exportFileDays: 99, customerInfoDays: 7.5 })).toEqual({ rawReportDays: 90, exportFileDays: 7, customerInfoDays: 30 })
    expect(retentionPolicyOf({ rawReportDays: '90', customerInfoDays: 45 })).toEqual(RETENTION_DEFAULTS)
  })

  it('保存格式：三项都要有且在范围内，错误文案指出是哪一项', () => {
    expect(RetentionPolicySchema.safeParse({ rawReportDays: 90, exportFileDays: 14, customerInfoDays: 7 }).success).toBe(true)
    const bad = RetentionPolicySchema.safeParse({ rawReportDays: 10, exportFileDays: 14, customerInfoDays: 45 })
    expect(bad.success).toBe(false)
    const messages = bad.success ? [] : bad.error.issues.map(issue => issue.message)
    expect(messages).toEqual(expect.arrayContaining(['原始报告文件的保留天数应在 30 至 1095 之间', '买家信息的保留天数应在 1 至 30 之间']))
    expect(RetentionPolicySchema.safeParse({ rawReportDays: 90 }).success).toBe(false)
  })

  it('审计日志的保留是系统固定的，只做说明', () => {
    expect(AUDIT_LOG_RETENTION_NOTE.controlledBy).toContain('不能在页面修改')
  })
})

describe('刷新策略', () => {
  it('目录：键唯一；放慢的选项都比内置间隔长；内置已经是一周的没有可放慢选项（目前没有这种域）', () => {
    expect(new Set(REFRESH_DOMAINS.map(domain => domain.key)).size).toBe(REFRESH_DOMAINS.length)
    for (const domain of REFRESH_DOMAINS) {
      for (const minutes of refreshChoicesOf(domain)) expect(minutes).toBeGreaterThan(domain.builtInMinutes)
      expect(refreshChoicesOf(domain).length, domain.key).toBeGreaterThan(0)
    }
    expect(refreshChoicesOf(orders)).toEqual(REFRESH_MINUTE_OPTIONS.filter(minutes => minutes > 360))
  })

  it('refreshPolicyOf：只认目录里的数据域与合格的取值，其余丢弃', () => {
    expect(refreshPolicyOf(null)).toEqual({})
    expect(refreshPolicyOf([])).toEqual({})
    expect(
      refreshPolicyOf({
        FBA_ORDERS: { mode: 'EVERY', minutes: 720 },
        FBA_FINANCE: { mode: 'PAUSED', minutes: 1 },
        FBA_INVENTORY: { mode: 'EVERY', minutes: 30 },
        NOPE: { mode: 'PAUSED' },
        TAX_SYNC: 'PAUSED',
      }),
    ).toEqual({
      FBA_ORDERS: { mode: 'EVERY', minutes: 720 },
      FBA_FINANCE: { mode: 'PAUSED' },
    })
  })

  it('refreshVerdict：没设置放行；暂停不放行；放慢按距上次的时间判断（容忍半个内置间隔的抖动）', () => {
    const now = new Date('2026-10-25T12:00:00Z')
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
    expect(refreshVerdict(undefined, 360, ago(1), now)).toEqual({ due: true })
    expect(refreshVerdict({ mode: 'PAUSED' }, 360, null, now)).toEqual({ due: false, reason: 'PAUSED' })
    const every = { mode: 'EVERY', minutes: 720 } as const
    expect(refreshVerdict(every, 360, null, now)).toEqual({ due: true })
    expect(refreshVerdict(every, 360, ago(360), now)).toEqual({ due: false, reason: 'TOO_SOON' })
    expect(refreshVerdict(every, 360, ago(540), now)).toEqual({ due: true })
    expect(refreshVerdict(every, 360, ago(539), now)).toEqual({ due: false, reason: 'TOO_SOON' })
  })

  it('文字：每天、每 N 天、每 N 小时、每 N 分钟；当前值写明是系统内置还是已放慢', () => {
    expect([30, 60, 360, 1440, 2880].map(minutesText)).toEqual(['每 30 分钟', '每 1 小时', '每 6 小时', '每天', '每 2 天'])
    expect(refreshValueText(orders, undefined)).toBe('每 6 小时（系统内置）')
    expect(refreshValueText(orders, { mode: 'EVERY', minutes: 720 })).toBe('每 12 小时（已放慢）')
    expect(refreshValueText(orders, { mode: 'PAUSED' })).toBe('已暂停定时同步')
  })

  it('保存格式：键必须在目录里，间隔必须比内置更长', () => {
    expect(RefreshPolicySchema.safeParse({ FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, TAX_SYNC: { mode: 'PAUSED' } }).success).toBe(true)
    expect(RefreshPolicySchema.safeParse({ NOPE: { mode: 'PAUSED' } }).success).toBe(false)
    expect(RefreshPolicySchema.safeParse({ FBA_ORDERS: { mode: 'EVERY', minutes: 60 } }).success).toBe(false)
    expect(RefreshPolicySchema.safeParse({ FBA_ORDERS: { mode: 'EVERY' } }).success).toBe(false)
  })
})

describe('企业设置项登记', () => {
  it('两个新键有格式与默认值，但不在“企业偏好”接口可直接编辑的范围里', () => {
    expect(TENANT_SETTING_DEFAULTS['retention.policy']).toEqual(RETENTION_DEFAULTS)
    expect(TENANT_SETTING_DEFAULTS['refresh.policy']).toEqual({})
    expect(TENANT_SETTING_SCHEMAS['retention.policy'].safeParse(TENANT_SETTING_DEFAULTS['retention.policy']).success).toBe(true)
    expect(PREFERENCE_KEYS).not.toContain('retention.policy')
    expect(PREFERENCE_KEYS).not.toContain('refresh.policy')
  })
})

describe('修改请求体', () => {
  it('基本信息：至少改一项；名称与时区校验；原因必填', () => {
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', name: '新名称有限公司', version: 1, reason }).success).toBe(true)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', localTimezone: 'Asia/Tokyo', version: 1, reason }).success).toBe(true)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', version: 1, reason }).success).toBe(false)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', name: '甲', version: 1, reason }).success).toBe(false)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', localTimezone: 'Mars/Base', version: 1, reason }).success).toBe(false)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'basic', name: '新名称有限公司', version: 1 }).success).toBe(false)
  })

  it('数据保留与刷新策略：整体校验；刷新策略的修改项可以是恢复默认', () => {
    expect(SettingsUpdateBodySchema.safeParse({ section: 'retention', values: { rawReportDays: 90, exportFileDays: 7, customerInfoDays: 30 }, version: 0, reason }).success).toBe(true)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'retention', values: { rawReportDays: 90 }, version: 0, reason }).success).toBe(false)
    const refresh = (changes: unknown) => SettingsUpdateBodySchema.safeParse({ section: 'refresh', changes, version: 0, reason })
    expect(refresh({ FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, TAX_SYNC: { mode: 'DEFAULT' }, CATALOG_SYNC: { mode: 'PAUSED' } }).success).toBe(true)
    expect(refresh({}).success).toBe(false)
    expect(refresh({ NOPE: { mode: 'PAUSED' } }).success).toBe(false)
    expect(refresh({ FBA_ORDERS: { mode: 'EVERY', minutes: 360 } }).success).toBe(false)
    expect(SettingsUpdateBodySchema.safeParse({ section: 'other', version: 0, reason }).success).toBe(false)
  })
})
