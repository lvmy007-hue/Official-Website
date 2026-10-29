import { z } from 'zod'
import { REFRESH_SETTING_KEY, RETENTION_DEFAULTS, RETENTION_SETTING_KEY } from './enterprise-settings.js'
import { RefreshPolicySchema, RetentionPolicySchema } from './enterprise-settings-query.js'
import { CurrencyCodeSchema } from './fx.js'
import { REIMBURSEMENT_WINDOW_DEFAULTS, ReimbursementWindowsSchema } from './reimbursement-windows.js'
import { WORK_DEFAULT_SLA_HOURS } from './work.js'

// 企业设置项（键值，P1-28）：每个键有固定的取值格式与默认值，写入前按格式校验，读取时缺失的键返回默认值。

const slaHours = z.number().int().min(1, '至少 1 小时').max(720, '最长 720 小时（30 天）')

export const TENANT_SETTING_SCHEMAS = {
  /** 汇率附加币种（采购或费用用到的、不是人民币的币种） */
  'fx.extraCurrencies': z.array(CurrencyCodeSchema).max(12, '附加币种最多 12 个'),
  /** 待办处理时限（小时）：按严重度，超时自动升级给管理员 */
  'work.sla.hours': z
    .object({ CRITICAL: slaHours, WARNING: slaHours, INFO: slaHours })
    .refine(value => value.CRITICAL <= value.WARNING && value.WARNING <= value.INFO, '严重的时限不能长于警告，警告不能长于提示'),
  /** 赔付机会的等待期与申请期限（P2b-03）：按 7 类机会各一组天数 */
  'reimbursement.windows': ReimbursementWindowsSchema,
  /** 数据保留策略（P5-10）：原始报告文件、导出文件、买家信息的保留天数；通过企业设置页修改（带原因与审计） */
  [RETENTION_SETTING_KEY]: RetentionPolicySchema,
  /** 刷新策略（P5-10）：按数据域放慢或暂停定时同步；没有记录表示按系统内置频率 */
  [REFRESH_SETTING_KEY]: RefreshPolicySchema,
} as const

export type TenantSettingKey = keyof typeof TENANT_SETTING_SCHEMAS
export const TENANT_SETTING_KEYS = Object.keys(TENANT_SETTING_SCHEMAS) as [TenantSettingKey, ...TenantSettingKey[]]

export const TENANT_SETTING_DEFAULTS: { [K in TenantSettingKey]: z.infer<(typeof TENANT_SETTING_SCHEMAS)[K]> } = {
  'fx.extraCurrencies': [],
  'work.sla.hours': { ...WORK_DEFAULT_SLA_HOURS },
  'reimbursement.windows': { ...REIMBURSEMENT_WINDOW_DEFAULTS },
  [RETENTION_SETTING_KEY]: { ...RETENTION_DEFAULTS },
  [REFRESH_SETTING_KEY]: {},
}

export const TENANT_SETTING_LABELS: Record<TenantSettingKey, string> = {
  'fx.extraCurrencies': '汇率附加币种',
  'work.sla.hours': '待办处理时限（小时）',
  'reimbursement.windows': '赔付机会时限（天）',
  [RETENTION_SETTING_KEY]: '数据保留',
  [REFRESH_SETTING_KEY]: '刷新策略',
}

/** 通过“企业偏好”接口可直接编辑的键（汇率附加币种在汇率页里编辑，使用汇率权限与再次验证）。 */
export const PREFERENCE_KEYS: readonly TenantSettingKey[] = ['work.sla.hours', 'reimbursement.windows']

export const isTenantSettingKey = (key: string): key is TenantSettingKey => Object.prototype.hasOwnProperty.call(TENANT_SETTING_SCHEMAS, key)

export const PreferenceUpdateBodySchema = z.object({
  // zod 4.4 起 z.unknown() 的键在解析时必填；3.x 允许缺省，缺省值由下面各设置项自己的校验拒绝，这里 .optional() 保持原行为
  value: z.unknown().optional(),
  version: z.number().int().min(0).default(0),
  reason: z.string().trim().min(2, '请填写修改原因').max(500),
})
