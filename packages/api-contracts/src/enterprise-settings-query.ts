import { z } from 'zod'
import { TimezoneSchema } from './lifecycle.js'
import { RETENTION_RULES, isRefreshOverride, refreshChoicesOf, refreshDomainOf, retentionInRange, type RetentionKey } from './enterprise-settings.js'

// 企业设置的请求与存储校验（P5-10）。zod 单独成文件，不进前端首屏。

const reasonText = z.string().trim().min(2, '请填写修改原因（至少 2 个字）').max(500, '修改原因最多 500 字')
const versionNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const retentionDays = (key: RetentionKey) =>
  z
    .number({ error: `${RETENTION_RULES[key].label}的保留天数应为整数` })
    .int(`${RETENTION_RULES[key].label}的保留天数应为整数`)
    .refine(value => retentionInRange(key, value), `${RETENTION_RULES[key].label}的保留天数应在 ${RETENTION_RULES[key].minDays} 至 ${RETENTION_RULES[key].maxDays} 之间`)

/** 数据保留策略（也是企业设置项 retention.policy 的存储格式）：三项都必须有。 */
export const RetentionPolicySchema = z.object({
  rawReportDays: retentionDays('rawReportDays'),
  exportFileDays: retentionDays('exportFileDays'),
  customerInfoDays: retentionDays('customerInfoDays'),
})

const refreshOverrideShape = z.object({ mode: z.enum(['PAUSED', 'EVERY']), minutes: z.number().int().optional() })

/** 刷新策略（也是企业设置项 refresh.policy 的存储格式）：键是数据域；没有记录表示按系统内置频率。 */
export const RefreshPolicySchema = z.record(z.string(), refreshOverrideShape).superRefine((value, ctx) => {
  for (const [key, item] of Object.entries(value)) {
    const domain = refreshDomainOf(key)
    if (!domain) ctx.addIssue({ code: 'custom', message: `不认识的数据域：${key}`, path: [key] })
    else if (!isRefreshOverride(domain, item)) ctx.addIssue({ code: 'custom', message: `${domain.label}的刷新间隔只能是暂停，或比系统内置更长的选项`, path: [key] })
  }
})

/** 刷新策略的修改项：DEFAULT 表示恢复系统内置频率。 */
const refreshChange = z.object({ mode: z.enum(['DEFAULT', 'PAUSED', 'EVERY']), minutes: z.number().int().optional() })

const basicBody = z
  .object({
    section: z.literal('basic'),
    name: z.string().trim().min(2, '企业名称至少 2 个字').max(160, '企业名称最多 160 个字').optional(),
    localTimezone: TimezoneSchema.optional(),
    version: versionNumber,
    reason: reasonText,
  })
  .refine(value => value.name !== undefined || value.localTimezone !== undefined, { message: '没有要修改的内容', path: ['name'] })

const retentionBody = z.object({ section: z.literal('retention'), values: RetentionPolicySchema, version: versionNumber, reason: reasonText })

const refreshBody = z.object({ section: z.literal('refresh'), changes: z.record(z.string(), refreshChange), version: versionNumber, reason: reasonText }).superRefine((value, ctx) => {
  const entries = Object.entries(value.changes)
  if (entries.length === 0) ctx.addIssue({ code: 'custom', message: '没有要修改的内容', path: ['changes'] })
  for (const [key, change] of entries) {
    const domain = refreshDomainOf(key)
    if (!domain) {
      ctx.addIssue({ code: 'custom', message: `不认识的数据域：${key}`, path: ['changes', key] })
      continue
    }
    if (change.mode === 'EVERY' && !refreshChoicesOf(domain).includes(change.minutes ?? 0))
      ctx.addIssue({ code: 'custom', message: `${domain.label}的刷新间隔必须比系统内置的更长`, path: ['changes', key] })
  }
})

/** PATCH /settings：按页签（section）修改；version 是读取时拿到的该部分的版本号，不一致返回 409。 */
export const SettingsUpdateBodySchema = z.discriminatedUnion('section', [basicBody, retentionBody, refreshBody])
export type SettingsUpdateBody = z.infer<typeof SettingsUpdateBodySchema>
