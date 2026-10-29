import { z } from 'zod'
import type { AlertUnconnectedType, AlertRuleDomain, AlertRuleSeverity } from './alert-rules.js'
import { ALERT_SEVERITIES } from './alerts.js'
import { ALERT_NOTIFY_FREQUENCIES, checkEscalation, type AlertEscalationLevel, type AlertNotifyFrequency } from './alert-rule-notify.js'
import type { ConditionGroups } from './rule-conditions.js'

// 预警规则配置（P5-01，09 章 9.1）：阈值、作用范围（主体、店铺、品类、SKU）、通知对象、静默时段、规则版本、质量统计。
// 规则行（AlertRule）里：conditionJson = { type, params }；scopeJson = 下面的 AlertRuleScope。每次改动生成一个新版本，版本快照留存当时的全部设置。

const idText = z.string().min(1).max(64)

/** 规则质量统计的回看天数：命中次数、误报率、平均处理时长都按首次触发时间落在最近这么多天的预警算。 */
export const ALERT_STATS_WINDOW_DAYS = 90
export const ALERT_RULE_CUSTOM_MAX = 50
export const ALERT_RULE_CUSTOM_PREFIX = 'CUSTOM_'
export const ALERT_QUIET_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

const clock = z.string().regex(ALERT_QUIET_PATTERN, '时间格式为 HH:MM，例如 22:00')
export const AlertQuietSchema = z.object({ start: clock, end: clock }).refine(value => value.start !== value.end, { message: '静默开始与结束不能是同一时刻', path: ['end'] })

/**
 * 作用范围。各项都是“不填表示不限制”：
 * - 主体与店铺：都填时取并集（所选主体下的全部店铺 + 另外勾选的店铺）；评估时按主体当时的店铺展开，主体下新增的店铺自动包含在内；
 * - 品类与 SKU：同理取并集，品类按商品资料里的品类路径（前缀匹配）展开成 SKU；
 * - ownerId：这条规则生成的待办默认负责人（须是在职成员，否则回落到有“预警管理”权限的成员）；
 * - notifyUserIds：站内通知的接收人（不填只通知待办负责人）；
 * - quiet：静默时段（企业时区），时段内不发站内通知，预警与待办照常生成；严重级别的预警不受静默限制。
 */
export const AlertRuleScopeSchema = z
  .object({
    legalEntityIds: z.array(idText).max(50).optional(),
    sellerAccountIds: z.array(idText).max(200).optional(),
    categories: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    skus: z.array(z.string().trim().min(1).max(120)).max(500).optional(),
    ownerId: idText.nullable().optional(),
    notifyUserIds: z.array(idText).max(50).optional(),
    quiet: AlertQuietSchema.nullable().optional(),
  })
  .strict()
export type AlertRuleScope = z.infer<typeof AlertRuleScopeSchema>

const cooldown = z.number({ error: '冷却分钟数必须是数字' }).int().min(0).max(10_080)
const reason = z.string().trim().min(2, '请填写变更原因').max(500)

/** 自定义指标规则的条件（P6-16）：形状在这里粗检，指标是否存在、窗口与阈值是否合法由服务端用 `validateConditions` 逐条校验。 */
export const AlertConditionGroupsSchema = z.object({ groups: z.array(z.object({ conditions: z.array(z.unknown()).max(50) }).strict()).max(20) }).strict()
export const AlertNotifyFrequencySchema = z.enum(ALERT_NOTIFY_FREQUENCIES)
/** 多级升级（P6-16）：最多 3 级，时限分钟数越来越长；空数组表示不升级。 */
export const AlertEscalationSchema = z
  .array(z.object({ afterMinutes: z.number({ error: '时限必须是数字' }) }).strict())
  .max(3, '升级最多 3 级')
  .superRefine((value, ctx) => {
    const checked = checkEscalation(value)
    if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.message })
  })

export const AlertRuleUpdateBodySchema = z
  .object({
    /** 规则行的乐观锁版本（GET /alerts/rules 返回的 version），别人先改过会返回冲突 */
    version: z.number().int().min(1),
    changeReason: reason,
    enabled: z.boolean().optional(),
    severity: z.enum(ALERT_SEVERITIES).optional(),
    cooldownMinutes: cooldown.optional(),
    /** 阈值：只传要改的键，没传的沿用当前值；键与取值范围见 alert-rule-params.ts */
    params: z.record(z.string(), z.unknown()).optional(),
    scope: AlertRuleScopeSchema.optional(),
    /** 只有自定义指标规则有条件（P6-16）；改它就是整体替换 */
    conditionGroups: AlertConditionGroupsSchema.optional(),
    notifyFrequency: AlertNotifyFrequencySchema.optional(),
    escalation: AlertEscalationSchema.optional(),
  })
  .refine(
    value =>
      value.enabled !== undefined ||
      value.severity !== undefined ||
      value.cooldownMinutes !== undefined ||
      value.params !== undefined ||
      value.scope !== undefined ||
      value.conditionGroups !== undefined ||
      value.notifyFrequency !== undefined ||
      value.escalation !== undefined,
    { message: '没有任何改动' },
  )

export const AlertRuleCreateBodySchema = z.object({
  /** 评估器类型（取自预置规则）：新规则用同一个评估器，只是阈值、范围或通知对象不同 */
  type: z.string().min(1).max(80),
  name: z.string().trim().min(2, '请填写规则名称').max(60),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  cooldownMinutes: cooldown.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  scope: AlertRuleScopeSchema.optional(),
  changeReason: reason.optional(),
  /** type 为 CUSTOM_METRIC 时必填，其余类型不能带（P6-16） */
  conditionGroups: AlertConditionGroupsSchema.optional(),
  notifyFrequency: AlertNotifyFrequencySchema.optional(),
  escalation: AlertEscalationSchema.optional(),
})

/** 试算：用最近几天的数据看这份条件会触发多少个对象（P6-16）；范围只取店铺，其余按“不限制”。 */
export const AlertRulePreviewBodySchema = z.object({
  conditionGroups: AlertConditionGroupsSchema,
  scope: AlertRuleScopeSchema.optional(),
})

export interface AlertRulePreviewResponse {
  /** 回看天数（每天按当天的“今天”判断一遍） */
  days: number
  /** 实际判断的店铺数；店铺太多时只判断前一部分（truncated 为 true） */
  evaluatedStores: number
  truncated: boolean
  /** 回看期间至少触发过一次的店铺数 */
  triggeredStores: number
  /** 每天各触发几个店铺（日期是企业时区） */
  perDay: Array<{ date: string; triggered: number }>
  /** 触发过的店铺（最多 10 个）与触发的天数 */
  samples: Array<{ storeId: string; storeName: string; days: number }>
  /** 条件里还没接入取数层的指标，这些条件一律取不到数（不会触发） */
  unsupportedMetrics: string[]
  /** 回看期间取不到数的店铺数（所有条件都缺数据） */
  noDataStores: number
}

export interface AlertRuleStats {
  windowDays: number
  /** 窗口内首次触发的预警条数 */
  hits: number
  /** 现在还没处理的条数 */
  open: number
  /** 窗口内被人处理（已处理、无需处理、误报、忽略）的条数 */
  handled: number
  falsePositive: number
  /** 误报 ÷ 被人处理的条数；没有被人处理的预警是 null（不是 0） */
  falsePositiveRate: number | null
  /** 被人处理的预警，从首次触发到处理完成的平均小时数；没有是 null */
  avgHandleHours: number | null
  /** 统计读取到上限被截断（规则命中太多）；截断后各项只覆盖最近的一部分 */
  truncated: boolean
}

export interface AlertRuleVersionView {
  versionNo: number
  changedByName: string
  changeReason: string
  createdAt: string
  /** 该版本的阈值（旧版本只有阈值，新版本还带严重度、冷却、范围，缺的项为 null） */
  params: Record<string, unknown>
  severity: AlertRuleSeverity | null
  cooldownMinutes: number | null
  enabled: boolean | null
  scope: AlertRuleScope | null
}

export interface AlertRuleView {
  id: string
  code: string
  domain: AlertRuleDomain
  domainLabel: string
  name: string
  description: string
  type: string
  /** 用户新建的规则（可以有多条用同一个评估器） */
  custom: boolean
  enabled: boolean
  severity: AlertRuleSeverity
  cooldownMinutes: number
  params: Record<string, unknown>
  /** 预置默认阈值，规则页“恢复默认”用 */
  defaultParams: Record<string, unknown>
  scope: AlertRuleScope
  /** 范围里的店铺与 SKU 对这条规则是否生效（有的预警对象是活动、数据来源，没有 SKU 维度） */
  scopeSupport: { stores: boolean; skus: boolean }
  /** 自定义指标规则的条件（P6-16）；其余规则为 null */
  conditionGroups: ConditionGroups | null
  /** 条件的中文描述；没有条件为 null */
  conditionText: string | null
  notifyFrequency: AlertNotifyFrequency
  /** 多级升级；空数组表示不升级 */
  escalation: AlertEscalationLevel[]
  currentVersion: number
  /** 乐观锁版本 */
  version: number
  updatedAt: string
  stats: AlertRuleStats
  versions: AlertRuleVersionView[]
}

export interface AlertRulesResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: AlertRuleView[]
  /** 企业时区（静默时段按它计时） */
  timezone: string
  /** 09 章 9.1 里列出但依赖项没交付的预警类型 */
  unconnected: readonly AlertUnconnectedType[]
  members: Array<{ id: string; name: string }>
  /** 商品资料里出现过的品类路径（去重，最多 200 个），范围的品类选项用 */
  categories: string[]
  can: { manage: boolean }
}

export interface AlertRuleMutationResponse {
  id: string
  code: string
  currentVersion: number
  version: number
}
