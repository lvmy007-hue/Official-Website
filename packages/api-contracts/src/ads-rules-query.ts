import { z } from 'zod'
import {
  ADS_RULE_ADJUST_MODES,
  ADS_RULE_FILTER_FIELDS,
  ADS_RULE_FILTER_MODES,
  ADS_RULE_FREQUENCIES,
  ADS_RULE_KEYWORD_MATCHES,
  ADS_RULE_LEVELS,
  ADS_RULE_LIMITS,
  ADS_RULE_METRICS,
  ADS_RULE_MODES,
  ADS_RULE_NEGATE_MATCHES,
  ADS_RULE_OPS,
  ADS_RULE_STATUSES,
  ADS_RULE_WINDOWS,
  type AdsRuleSpec,
} from './ads-rules'
import { ruleSpecIssues } from './ads-rules-text'

// 自动规则的请求校验（P3-13）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
// 保存规则只改本系统里的数据（自动执行由 P3-17 的执行器另行提交写入）；广告账户与对象层级创建后不能改（要换就新建一条）。

const idText = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '编号格式不正确')
const nameText = z.string().trim().min(1, '请填写规则名称').max(ADS_RULE_LIMITS.nameMax, `规则名称最多 ${ADS_RULE_LIMITS.nameMax} 个字`)
const money = z.number().finite().min(ADS_RULE_LIMITS.valueFloor).max(ADS_RULE_LIMITS.valueCeiling)
const windowDays = z
  .number()
  .int()
  .refine((value): value is (typeof ADS_RULE_WINDOWS)[number] => (ADS_RULE_WINDOWS as readonly number[]).includes(value), `时间窗口只能是 ${ADS_RULE_WINDOWS.join('、')} 天`)

const condition = z
  .object({
    metric: z.enum(ADS_RULE_METRICS),
    windowDays,
    op: z.enum(ADS_RULE_OPS),
    value: z.number().finite().min(0, '阈值不能是负数').max(1_000_000_000),
  })
  .strict()

const textFilter = z
  .object({
    field: z.enum(ADS_RULE_FILTER_FIELDS),
    mode: z.enum(ADS_RULE_FILTER_MODES),
    text: z.string().trim().min(1, '过滤文字不能为空').max(ADS_RULE_LIMITS.filterTextMax),
  })
  .strict()

const adjust = z.enum(ADS_RULE_ADJUST_MODES)
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ADJUST_BID'), mode: adjust, value: z.number().finite() }).strict(),
  z.object({ type: z.literal('ADJUST_BUDGET'), mode: adjust, value: z.number().finite() }).strict(),
  z.object({ type: z.literal('PAUSE') }).strict(),
  z.object({ type: z.literal('ENABLE') }).strict(),
  z.object({ type: z.literal('NEGATE'), matchType: z.enum(ADS_RULE_NEGATE_MATCHES) }).strict(),
  z.object({ type: z.literal('ADD_KEYWORD'), matchType: z.enum(ADS_RULE_KEYWORD_MATCHES), bid: money }).strict(),
])

const guardrails = z
  .object({
    minValue: money.nullable(),
    maxValue: money.nullable(),
    maxChangePercent: z.number().int().min(1).max(100).nullable(),
    dailyLimit: z.number().int().min(1).max(ADS_RULE_LIMITS.dailyLimitMax),
  })
  .strict()

const conditions = z.array(condition).min(1, '请至少设置一个条件').max(ADS_RULE_LIMITS.conditionsMax, `最多 ${ADS_RULE_LIMITS.conditionsMax} 个条件`)
const textFilters = z.array(textFilter).max(ADS_RULE_LIMITS.filtersMax, `最多 ${ADS_RULE_LIMITS.filtersMax} 个过滤条件`)
const campaignIds = z
  .array(idText)
  .max(ADS_RULE_LIMITS.campaignsMax, `最多限定 ${ADS_RULE_LIMITS.campaignsMax} 个活动`)
  .refine(ids => new Set(ids).size === ids.length, '限定的活动不能重复')

/** 创建：选择广告账户、层级，给条件、过滤、动作与护栏。状态默认“已暂停”（先试运行看清楚再启用）。 */
export const AdsRuleBodySchema = z
  .object({
    adsProfileId: idText,
    name: nameText,
    level: z.enum(ADS_RULE_LEVELS),
    mode: z.enum(ADS_RULE_MODES).default('SUGGEST'),
    status: z.enum(ADS_RULE_STATUSES).default('PAUSED'),
    frequency: z.enum(ADS_RULE_FREQUENCIES).default('DAILY'),
    conditions,
    textFilters: textFilters.default([]),
    campaignIds: campaignIds.default([]),
    action,
    guardrails,
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = ruleSpecIssues(body as unknown as AdsRuleSpec)
    if (issue) ctx.addIssue({ code: 'custom', path: ['action'], message: issue })
  })
export type AdsRuleBody = z.infer<typeof AdsRuleBodySchema>

/** 修改：带版本号（乐观锁）；改动后的整体内容是否合法要结合当前层级，由服务再校验一次。 */
export const AdsRuleUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    name: nameText.optional(),
    mode: z.enum(ADS_RULE_MODES).optional(),
    status: z.enum(ADS_RULE_STATUSES).optional(),
    frequency: z.enum(ADS_RULE_FREQUENCIES).optional(),
    conditions: conditions.optional(),
    textFilters: textFilters.optional(),
    campaignIds: campaignIds.optional(),
    action: action.optional(),
    guardrails: guardrails.optional(),
  })
  .strict()
  .refine(body => Object.keys(body).some(key => key !== 'version'), { message: '请至少修改一项内容' })
export type AdsRuleUpdateBody = z.infer<typeof AdsRuleUpdateBodySchema>

/** 试运行：评估截止日（默认昨天）。 */
export const AdsRuleDryRunBodySchema = z
  .object({
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
      .optional(),
  })
  .strict()
export type AdsRuleDryRunBody = z.infer<typeof AdsRuleDryRunBodySchema>

/** 执行记录的翻页（范围参数由全局范围校验，这里允许共存）。 */
export const AdsRuleRunsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    pageSize: z.coerce.number().int().min(1).max(ADS_RULE_LIMITS.runPageMax).default(20),
  })
  .passthrough()
export type AdsRuleRunsQuery = z.infer<typeof AdsRuleRunsQuerySchema>
