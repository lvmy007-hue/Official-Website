import { z } from 'zod'

// 接口与写入开关目录（freeze/permissions.md 第六节，共 20 项）与接口契约（P1-28，09 章 9.13）。
// 开关键用于后端校验与审计；每个开关对应一类亚马逊写入，默认全部关闭。

export type SwitchGroup = 'SELLER' | 'ADS' | 'AUTOMATION'
export type SwitchProvider = 'AMAZON_SP_API' | 'AMAZON_ADS_API'

export interface SwitchSpec {
  key: string
  label: string
  group: SwitchGroup
  /** 执行该类写入所需的业务权限（用于页面说明与后端校验） */
  permission: string
  provider: SwitchProvider
  /** 开启前要求连接已授予的范围（连接记录里的 grantedScopes 必须包含全部） */
  scopes: readonly string[]
}

const SELLER_SCOPES = ['seller'] as const
const FBA_SCOPES = ['seller', 'fba'] as const
const ADS_SCOPES = ['advertising::campaign_management'] as const

const seller = (key: string, label: string, permission: string, scopes: readonly string[] = SELLER_SCOPES): SwitchSpec => ({
  key,
  label,
  group: 'SELLER',
  permission,
  provider: 'AMAZON_SP_API',
  scopes,
})
const ads = (key: string, label: string, permission: string): SwitchSpec => ({ key, label, group: 'ADS', permission, provider: 'AMAZON_ADS_API', scopes: ADS_SCOPES })

export const SWITCH_CATALOG: readonly SwitchSpec[] = [
  seller('sw.inbound.plan.create', '创建与取消入仓计划', 'inbound.plan.write', FBA_SCOPES),
  seller('sw.inbound.packing.confirm', '确认装箱方案', 'inbound.plan.write', FBA_SCOPES),
  seller('sw.inbound.packinginfo.submit', '提交箱内物品信息', 'inbound.plan.write', FBA_SCOPES),
  seller('sw.inbound.placement.confirm', '确认分仓方案', 'inbound.plan.write', FBA_SCOPES),
  seller('sw.inbound.transport.confirm', '确认承运方式与回填追踪号', 'inbound.plan.write', FBA_SCOPES),
  seller('sw.listing.update', '修改刊登', 'listing.write'),
  seller('sw.pricing.update', '修改价格', 'pricing.price.write'),
  seller('sw.solicitation.send', '请求评价', 'reviews.solicit'),
  seller('sw.aplus.submit', 'A+ 内容提交', 'aplus.write'),
  seller('sw.awd.order.write', '上游仓储入库订单', 'awd.order.write', FBA_SCOPES),
  seller('sw.feeds.batch', '批量刊登任务', 'listing.write'),
  ads('sw.ads.status', '活动状态', 'ads.campaign.write'),
  ads('sw.ads.budget', '预算', 'ads.budget.write'),
  ads('sw.ads.bid', '竞价', 'ads.bid.write'),
  ads('sw.ads.negative', '否定投放', 'ads.negative.write'),
  ads('sw.ads.keyword', '添加关键词', 'ads.keyword.write'),
  ads('sw.ads.placement', '广告位调整', 'ads.placement.write'),
  ads('sw.ads.rule.run', '自动规则执行', 'ads.rule.write'),
  ads('sw.ads.dayparting.run', '分时策略执行', 'ads.rule.write'),
  // 自动改价最终调用卖家接口改价，前置条件与“修改价格”一致
  { key: 'sw.pricing.rule.auto', label: '定价规则自动执行', group: 'AUTOMATION', permission: 'pricing.rule.write', provider: 'AMAZON_SP_API', scopes: SELLER_SCOPES },
]

export const SWITCH_KEYS: readonly string[] = SWITCH_CATALOG.map(spec => spec.key)
export const switchSpecOf = (key: string): SwitchSpec | undefined => SWITCH_CATALOG.find(spec => spec.key === key)
export const SWITCH_GROUP_LABEL: Record<SwitchGroup, string> = { SELLER: '卖家接口写入', ADS: '广告接口写入', AUTOMATION: '自动化' }

/** 连续失败达到此次数，开关自动关闭并告警。 */
export const SWITCH_AUTO_CLOSE_FAILURES = 5
/** 写调用统计只保留最近 N 天。 */
export const SWITCH_STATS_DAYS = 7

export type WriteMode = 'READ_ONLY' | 'PARTIAL' | 'ALL'
/** 总览模式：全部关闭为只读；全部开启为全部写入；其余为部分写入。 */
export function writeModeOf(enabledCount: number, total: number = SWITCH_CATALOG.length): WriteMode {
  if (enabledCount <= 0) return 'READ_ONLY'
  return enabledCount >= total ? 'ALL' : 'PARTIAL'
}

/** POST /settings/integrations/:key/enable：必须填写原因并二次确认（confirm 必须为 true）。 */
export const SwitchEnableBodySchema = z.object({
  reason: z.string().trim().min(2, '请填写开启原因').max(500),
  confirm: z.literal(true, { error: '开启写入开关需要二次确认' }),
})
export type SwitchEnableBody = z.infer<typeof SwitchEnableBodySchema>

/** PATCH /settings/integrations：批量更新（只允许关闭；开启必须逐项走“开启流程”）。 */
export const SwitchBatchBodySchema = z.object({
  keys: z
    .array(z.string())
    .min(1)
    .max(SWITCH_CATALOG.length)
    .refine(keys => keys.every(key => SWITCH_KEYS.includes(key)), '包含不存在的开关'),
  enabled: z.literal(false, { error: '批量操作只能关闭开关，开启需要逐项填写原因并确认' }),
  reason: z.string().trim().min(2, '请填写原因').max(500),
})

/** 写调用统计：按天（UTC 日期）累计调用与失败次数，只保留最近 SWITCH_STATS_DAYS 天。 */
export interface SwitchDayStat {
  d: string
  calls: number
  failures: number
}

export function parseSwitchStats(value: unknown): SwitchDayStat[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (item): item is SwitchDayStat =>
        !!item && typeof item === 'object' && typeof (item as SwitchDayStat).d === 'string' && Number.isFinite((item as SwitchDayStat).calls) && Number.isFinite((item as SwitchDayStat).failures),
    )
    .map(item => ({ d: item.d, calls: Math.max(0, Math.trunc(item.calls)), failures: Math.max(0, Math.trunc(item.failures)) }))
}

/** 记入一次写调用结果并裁掉过期的天；返回新的统计、近 N 天合计，以及更新后的连续失败次数。 */
export function applySwitchOutcome(stats: SwitchDayStat[], consecutiveFailures: number, success: boolean, now: Date = new Date()) {
  const today = now.toISOString().slice(0, 10)
  const oldest = new Date(now.getTime() - (SWITCH_STATS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  const kept = stats.filter(item => item.d >= oldest && item.d <= today)
  const current = kept.find(item => item.d === today)
  const next = current
    ? kept.map(item => (item === current ? { ...item, calls: item.calls + 1, failures: item.failures + (success ? 0 : 1) } : item))
    : [...kept, { d: today, calls: 1, failures: success ? 0 : 1 }]
  const failures = success ? 0 : consecutiveFailures + 1
  return {
    stats: next,
    calls7d: next.reduce((sum, item) => sum + item.calls, 0),
    failures7d: next.reduce((sum, item) => sum + item.failures, 0),
    consecutiveFailures: failures,
    shouldAutoClose: !success && failures >= SWITCH_AUTO_CLOSE_FAILURES,
  }
}

/** 部署环境变量里的紧急强制关闭：`all` 关闭全部，或逗号分隔的开关键。返回关闭原因，未强制关闭返回 null。 */
export function emergencyDisableReason(key: string, env: Record<string, string | undefined>): string | null {
  const raw = (env.NOVA_WRITE_EMERGENCY_DISABLE ?? '').trim()
  if (!raw) return null
  const parts = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (parts.includes('all') || parts.includes(key)) return '平台已通过部署配置紧急强制关闭此类写入，请联系平台运营'
  return null
}
