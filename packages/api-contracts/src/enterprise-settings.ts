// 企业设置（P5-10，09 章 9.12）：基本信息、数据保留、刷新策略、风险规则版本、内部访问模式。
// 只有常量、类型与纯函数（zod 校验在 enterprise-settings-query.ts，前端不得引用），这样前端首屏不会因此带上 zod。
// 每个配置项写成一张卡片：配置名、当前值、影响范围、编辑入口；只读项写明由谁或在哪里控制。

export const SETTINGS_READ = 'settings.read'
export const SETTINGS_WRITE = 'settings.write'

/** 企业设置项（键值表 TenantSetting）里存放数据保留与刷新策略的键。 */
export const RETENTION_SETTING_KEY = 'retention.policy'
export const REFRESH_SETTING_KEY = 'refresh.policy'

// ---------------------------------------------------------------- 数据保留

// 注意键名：审计写入会把名字里带 buyer、phone、email 等字样的字段值遮成“已隐藏”，所以买家信息的天数叫 customerInfoDays，审计里才看得见修改前后。
export const RETENTION_KEYS = ['rawReportDays', 'exportFileDays', 'customerInfoDays'] as const
export type RetentionKey = (typeof RETENTION_KEYS)[number]
export type RetentionPolicy = Record<RetentionKey, number>

export interface RetentionRule {
  key: RetentionKey
  label: string
  description: string
  defaultDays: number
  minDays: number
  maxDays: number
  /** 改了之后哪些地方会变。 */
  impact: string
  /** 修改什么时候起作用，以及对已有数据的影响。 */
  appliesTo: string
}

export const RETENTION_RULES: Readonly<Record<RetentionKey, RetentionRule>> = {
  rawReportDays: {
    key: 'rawReportDays',
    label: '原始报告文件',
    description: '从亚马逊下载的原始报告（解压之前的原文件），留着用于追溯数字来源与重新解析。',
    defaultDays: 400,
    minDays: 30,
    maxDays: 1095,
    impact: '报告中心里“原文件”的可下载期限；到期后文件被清理，已入库的数据不受影响。',
    appliesTo: '只对修改之后新保存的报告文件生效；已保存文件的到期时间不变。',
  },
  exportFileDays: {
    key: 'exportFileDays',
    label: '导出文件',
    description: '导出中心生成的文件，到期后文件被删除，只保留任务记录。',
    defaultDays: 7,
    minDays: 1,
    maxDays: 30,
    impact: '导出中心里文件的“有效期至”与可下载时间；到期后需要重新导出。',
    appliesTo: '只对修改之后新创建的导出任务生效；已有任务的到期时间不变。',
  },
  customerInfoDays: {
    key: 'customerInfoDays',
    label: '买家信息',
    description: '订单里的买家与收货人信息，加密保存，到期后清除。亚马逊要求发货后最长 30 天内删除，所以只能缩短，不能延长。',
    defaultDays: 30,
    minDays: 1,
    maxDays: 30,
    impact: '订单详情里能查看买家信息的天数；到期后无法再查看，“个人信息明文查看”记录不受影响。',
    appliesTo: '修改之后同步写入或更新的订单按“发货后 N 天”计算；之后没有再被同步到的订单，到期时间不变；未发货订单仍按下单后 90 天上限。',
  },
}

export const RETENTION_DEFAULTS: Readonly<RetentionPolicy> = { rawReportDays: 400, exportFileDays: 7, customerInfoDays: 30 }

/** 审计日志的保留是系统固定的，不能改：这里只做说明（只读卡片）。 */
export const AUDIT_LOG_RETENTION_NOTE = {
  label: '审计日志',
  value: '不自动清理，只增不删',
  description: '审计记录只能新增，应用没有修改或删除的权限，所以没有可设置的保留期限。',
  impact: '审计中心里能查到的最早记录；企业注销后审计记录再保留 730 天，之后由平台清理。',
  controlledBy: '由系统固定，不能在页面修改；调整须由平台运营评估合规要求后改动程序。',
} as const

export const retentionInRange = (key: RetentionKey, value: unknown): value is number => {
  const rule = RETENTION_RULES[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= rule.minDays && value <= rule.maxDays
}

/** 从存储的值还原保留策略：缺失或不合格式的项用默认值，不让坏数据影响清理任务。 */
export function retentionPolicyOf(value: unknown): RetentionPolicy {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const pick = (key: RetentionKey) => {
    const found = record[key]
    return retentionInRange(key, found) ? found : RETENTION_DEFAULTS[key]
  }
  return { rawReportDays: pick('rawReportDays'), exportFileDays: pick('exportFileDays'), customerInfoDays: pick('customerInfoDays') }
}

// ---------------------------------------------------------------- 刷新策略

export interface RefreshDomain {
  /** 同步任务类型，同时作为策略的键。 */
  key: string
  label: string
  /** 系统内置的刷新间隔（分钟）。 */
  builtInMinutes: number
  impact: string
}

/** 可以调整的数据域。调整只能放慢或暂停，不能比系统内置的更快（保护亚马逊接口配额）。 */
export const REFRESH_DOMAINS: readonly RefreshDomain[] = [
  { key: 'FBA_ORDERS', label: '订单', builtInMinutes: 360, impact: '订单列表、销量与利润的新鲜度' },
  { key: 'FBA_INVENTORY', label: '库存', builtInMinutes: 30, impact: '库存健康、补货建议与断货预警的新鲜度' },
  { key: 'FBA_FINANCE', label: '财务交易', builtInMinutes: 360, impact: '费用、利润与结算核对的新鲜度' },
  { key: 'FBA_INBOUND_SYNC', label: '入仓与货件', builtInMinutes: 360, impact: '入仓计划与货件状态的新鲜度' },
  { key: 'FBA_REPLENISHMENT', label: '补货数据', builtInMinutes: 360, impact: '补货计划里的亚马逊侧数据' },
  { key: 'FBA_ADS', label: '广告', builtInMinutes: 360, impact: '广告花费、投放状态与超预算预警的新鲜度' },
  { key: 'ADS_ENTITY_SYNC', label: '广告实体', builtInMinutes: 120, impact: '广告活动、广告组、投放对象与投放状态（含超预算预警）的新鲜度' },
  { key: 'ADS_REPORT_V1', label: '广告报表', builtInMinutes: 1440, impact: '广告花费、搜索词、广告位与分时指标（含利润里的广告分摊）的新鲜度' },
  { key: 'AWD_SYNC', label: '上游仓储', builtInMinutes: 120, impact: '上游仓储库存与入库订单的新鲜度' },
  { key: 'SUPPORT_SYNC', label: '支持案件', builtInMinutes: 120, impact: '支持案件与沟通记录的新鲜度' },
  { key: 'PRICING_SYNC', label: '定价', builtInMinutes: 120, impact: '我方报价、推荐价格与竞争摘要的新鲜度' },
  { key: 'COMPETITOR_SYNC', label: '竞品监控', builtInMinutes: 360, impact: '竞品商品与竞争摘要的新鲜度' },
  { key: 'CATALOG_SYNC', label: '商品目录', builtInMinutes: 1440, impact: '商品名称、图片与类目的新鲜度' },
  { key: 'SETTLEMENT_SYNC', label: '结算报告', builtInMinutes: 1440, impact: '结算单列表与三方核对的新鲜度' },
  { key: 'TAX_SYNC', label: '销售税', builtInMinutes: 1440, impact: '销售税页面的数据新鲜度' },
  { key: 'PROMOTIONS_SYNC', label: '促销与优惠券', builtInMinutes: 1440, impact: '促销页面的数据新鲜度' },
  { key: 'LISTING_SYNC', label: '刊登质量', builtInMinutes: 1440, impact: '刊登问题与状态的新鲜度' },
  { key: 'FEEDBACK_SYNC', label: '客户反馈', builtInMinutes: 1440, impact: '评价与反馈页面的新鲜度' },
  { key: 'APLUS_SYNC', label: 'A+ 内容', builtInMinutes: 1440, impact: 'A+ 内容与发布记录的新鲜度' },
]

/** 不能在页面调整、由系统固定频率运行的定时任务（只读说明）。 */
export const FIXED_SCHEDULES: ReadonlyArray<{ label: string; frequency: string }> = [
  { label: '汇率获取', frequency: '每 6 小时' },
  { label: '利润日表重算', frequency: '每 6 小时' },
  { label: '风险预警评估', frequency: '每 15 分钟' },
  { label: '赔付扫描', frequency: '每 3 小时' },
  { label: '官方经济数据、销售与流量', frequency: '每天' },
  { label: '连接健康检查', frequency: '每天' },
]

export const REFRESH_MINUTE_OPTIONS = [60, 120, 360, 720, 1440, 2880, 10080] as const

export type RefreshOverride = { mode: 'PAUSED' } | { mode: 'EVERY'; minutes: number }
export type RefreshPolicy = Readonly<Record<string, RefreshOverride>>

export const refreshDomainOf = (key: string): RefreshDomain | undefined => REFRESH_DOMAINS.find(domain => domain.key === key)

/** 某个数据域可选的间隔（分钟）：必须比系统内置的更长。 */
export const refreshChoicesOf = (domain: RefreshDomain): number[] => REFRESH_MINUTE_OPTIONS.filter(minutes => minutes > domain.builtInMinutes)

export const minutesText = (minutes: number): string => {
  if (minutes % 1440 === 0) return minutes === 1440 ? '每天' : `每 ${minutes / 1440} 天`
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

export const isRefreshOverride = (domain: RefreshDomain, value: unknown): value is RefreshOverride => {
  if (value === null || typeof value !== 'object') return false
  const record = value as { mode?: unknown; minutes?: unknown }
  if (record.mode === 'PAUSED') return true
  return record.mode === 'EVERY' && typeof record.minutes === 'number' && refreshChoicesOf(domain).includes(record.minutes)
}

/** 从存储的值还原刷新策略：不认识的数据域与不合格式的项一律丢弃（按系统内置频率处理）。 */
export function refreshPolicyOf(value: unknown): RefreshPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, RefreshOverride> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const domain = refreshDomainOf(key)
    if (domain && isRefreshOverride(domain, item)) out[key] = item.mode === 'PAUSED' ? { mode: 'PAUSED' } : { mode: 'EVERY', minutes: item.minutes }
  }
  return out
}

export type RefreshVerdict = { due: true } | { due: false; reason: 'PAUSED' | 'TOO_SOON' }

/**
 * 定时器到点时，这个数据域要不要给该企业排同步。
 * 间隔放慢后只在定时器的节拍上判断：距上一次定时同步不足“设定间隔减去半个内置间隔”就跳过，
 * 这样 6 小时节拍上设 12 小时，会在第二个节拍排任务，不会因为几秒的抖动再多等一轮。
 */
export function refreshVerdict(override: RefreshOverride | undefined, builtInMinutes: number, lastScheduledAt: Date | null, now: Date): RefreshVerdict {
  if (!override) return { due: true }
  if (override.mode === 'PAUSED') return { due: false, reason: 'PAUSED' }
  if (!lastScheduledAt) return { due: true }
  const elapsedMinutes = (now.getTime() - lastScheduledAt.getTime()) / 60_000
  return elapsedMinutes >= override.minutes - builtInMinutes / 2 ? { due: true } : { due: false, reason: 'TOO_SOON' }
}

export const refreshValueText = (domain: RefreshDomain, override: RefreshOverride | undefined): string => {
  if (!override) return `${minutesText(domain.builtInMinutes)}（系统内置）`
  return override.mode === 'PAUSED' ? '已暂停定时同步' : `${minutesText(override.minutes)}（已放慢）`
}

// ---------------------------------------------------------------- 响应

export interface SettingsEditor {
  /** 最近修改的时间与人；从未修改过为 null。 */
  updatedAt: string | null
  updatedByName: string | null
}

export interface SettingsBasicView {
  name: string
  slug: string
  mode: string
  /** 数据口径时区：固定，不能改（改了会让已汇总的日数据口径错位）。 */
  dataTimezone: string
  localTimezone: string
  /** 显示币种：目前固定为美元（汇率以美元为基准）。 */
  defaultCurrency: string
  /** 乐观锁版本号：企业记录最近更新时间的毫秒数。 */
  version: number
  updatedAt: string
}

export interface RetentionItemView {
  key: RetentionKey
  label: string
  description: string
  days: number
  defaultDays: number
  isDefault: boolean
  minDays: number
  maxDays: number
  impact: string
  appliesTo: string
}

export interface RefreshItemView {
  key: string
  label: string
  builtInMinutes: number
  override: RefreshOverride | null
  /** 当前取值的文字，例如“每 6 小时（系统内置）”。 */
  valueText: string
  /** 可选的放慢间隔（分钟）。 */
  choices: number[]
  impact: string
}

export interface RiskRulesSummary {
  total: number
  enabled: number
  /** 最近一次规则修改；还没有人修改过为 null。 */
  lastChange: { ruleName: string; versionNo: number; changedAt: string } | null
}

export type InternalAccessState = 'OFF' | 'ON_THIS_TENANT' | 'ON_OTHER_TENANT' | 'MISCONFIGURED'

export interface InternalAccessView {
  state: InternalAccessState
  /** 对本企业开启时绑定的角色；其余状态为 null。 */
  roleId: string | null
  allowedRangeCount: number | null
  gatewayHeaderRequired: boolean | null
  /** 平台支持访问：当前有效的授权数与正被使用的数量。 */
  supportGrantsActive: number
  supportGrantsInUse: number
}

export interface EnterpriseSettingsResponse {
  canWrite: boolean
  basic: SettingsBasicView
  retention: SettingsEditor & { version: number; items: RetentionItemView[]; auditLog: typeof AUDIT_LOG_RETENTION_NOTE }
  refresh: SettingsEditor & { version: number; items: RefreshItemView[]; fixed: typeof FIXED_SCHEDULES; pausedCount: number }
  risk: RiskRulesSummary
  internal: InternalAccessView
}

export interface SettingsUpdateResult {
  section: 'basic' | 'retention' | 'refresh'
  version: number
}
