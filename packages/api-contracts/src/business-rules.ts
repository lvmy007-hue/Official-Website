// 业务口径（P6-31，16 章第 7.1 节）：净销售额公式、可用库存的组成、周起始日、多站点“今日”的取法。纯常量、类型与纯函数。

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

export const NET_SALES_DEDUCTIONS = ['REFUNDS', 'PROMOTION'] as const
export type NetSalesDeduction = (typeof NET_SALES_DEDUCTIONS)[number]
export const NET_SALES_DEDUCTION_LABEL: Readonly<Record<NetSalesDeduction, string>> = { REFUNDS: '退款', PROMOTION: '促销费用' }

export const INVENTORY_COMPONENTS = ['FULFILLABLE', 'RESERVED', 'INBOUND_WORKING', 'INBOUND_SHIPPED', 'INBOUND_RECEIVING'] as const
export type InventoryComponent = (typeof INVENTORY_COMPONENTS)[number]
export const INVENTORY_COMPONENT_LABEL: Readonly<Record<InventoryComponent, string>> = {
  FULFILLABLE: '可售',
  RESERVED: '预留',
  INBOUND_WORKING: '入库中·创建',
  INBOUND_SHIPPED: '入库中·已发货',
  INBOUND_RECEIVING: '入库中·接收中',
}

export const WEEK_START_DAYS = ['MON', 'SUN', 'SAT'] as const
export type WeekStartDay = (typeof WEEK_START_DAYS)[number]
export const WEEK_START_LABEL: Readonly<Record<WeekStartDay, string>> = { MON: '周一', SUN: '周日', SAT: '周六' }
/** 与 Date.getUTCDay() 对应：周日 0、周一 1、周六 6。 */
export const WEEK_START_INDEX: Readonly<Record<WeekStartDay, number>> = { SUN: 0, MON: 1, SAT: 6 }

export const MULTI_SITE_TODAY_MODES = ['LATEST_SITE', 'EACH_SITE'] as const
export type MultiSiteTodayMode = (typeof MULTI_SITE_TODAY_MODES)[number]
export const MULTI_SITE_TODAY_LABEL: Readonly<Record<MultiSiteTodayMode, string>> = { LATEST_SITE: '统一取最晚的站点', EACH_SITE: '各站点各自取' }

export const BUSINESS_RULE_KEYS = ['netSales', 'availableInventory', 'weekStart', 'multiSiteToday'] as const
export type BusinessRuleKey = (typeof BUSINESS_RULE_KEYS)[number]
export const isBusinessRuleKey = (value: string): value is BusinessRuleKey => (BUSINESS_RULE_KEYS as readonly string[]).includes(value)

export interface BusinessRulesConfig {
  netSales: { deduct: NetSalesDeduction[] }
  availableInventory: { components: InventoryComponent[] }
  weekStart: { day: WeekStartDay }
  multiSiteToday: { mode: MultiSiteTodayMode }
}
export type BusinessRuleValue<K extends BusinessRuleKey = BusinessRuleKey> = BusinessRulesConfig[K]

/** 默认口径：净销售额 = 销售额 − 退款；可用库存 = 可售；周一为一周的开始；多站点“今日”统一取最晚站点（全站只有一个业务日）。与改版前一致。 */
export const DEFAULT_BUSINESS_RULES: Readonly<BusinessRulesConfig> = {
  netSales: { deduct: ['REFUNDS'] },
  availableInventory: { components: ['FULFILLABLE'] },
  weekStart: { day: 'MON' },
  multiSiteToday: { mode: 'LATEST_SITE' },
}

const pick = <T extends string>(all: readonly T[], list: unknown): T[] | null => {
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string' && (all as readonly string[]).includes(item))) return null
  return all.filter(item => (list as string[]).includes(item))
}

/** 读取单项口径的值；形状不对返回 null。 */
export function readBusinessRuleValue(key: BusinessRuleKey, raw: unknown): BusinessRuleValue | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (key === 'netSales') {
    const deduct = pick(NET_SALES_DEDUCTIONS, value.deduct)
    return deduct ? { deduct } : null
  }
  if (key === 'availableInventory') {
    const components = pick(INVENTORY_COMPONENTS, value.components)
    return components && components.length > 0 ? { components } : null
  }
  if (key === 'weekStart') return typeof value.day === 'string' && (WEEK_START_DAYS as readonly string[]).includes(value.day) ? { day: value.day as WeekStartDay } : null
  return typeof value.mode === 'string' && (MULTI_SITE_TODAY_MODES as readonly string[]).includes(value.mode) ? { mode: value.mode as MultiSiteTodayMode } : null
}

/** 读取整份业务口径；缺的项回落到默认（旧版本没有的新项）。形状整体不对返回 null。 */
export function readBusinessRules(raw: unknown): BusinessRulesConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const next: BusinessRulesConfig = structuredClone(DEFAULT_BUSINESS_RULES) as BusinessRulesConfig
  for (const key of BUSINESS_RULE_KEYS) {
    if (source[key] === undefined) continue
    const value = readBusinessRuleValue(key, source[key])
    if (!value) return null
    ;(next as unknown as Record<string, unknown>)[key] = value
  }
  return next
}

export const sameRuleValue = (a: BusinessRuleValue, b: BusinessRuleValue): boolean => JSON.stringify(a) === JSON.stringify(b)

export const BUSINESS_RULE_LABEL: Readonly<Record<BusinessRuleKey, string>> = {
  netSales: '净销售额公式',
  availableInventory: '可用库存的组成',
  weekStart: '周起始日',
  multiSiteToday: '多站点“今日”的取法',
}

export function describeBusinessRule(key: BusinessRuleKey, value: BusinessRuleValue): string {
  if (key === 'netSales') {
    const deduct = (value as BusinessRulesConfig['netSales']).deduct
    return deduct.length === 0 ? '净销售额 = 销售额' : `净销售额 = 销售额 − ${deduct.map(item => NET_SALES_DEDUCTION_LABEL[item]).join(' − ')}`
  }
  if (key === 'availableInventory') return `可用库存 = ${(value as BusinessRulesConfig['availableInventory']).components.map(item => INVENTORY_COMPONENT_LABEL[item]).join(' + ')}`
  if (key === 'weekStart') return `每周从${WEEK_START_LABEL[(value as BusinessRulesConfig['weekStart']).day]}开始`
  return MULTI_SITE_TODAY_LABEL[(value as BusinessRulesConfig['multiSiteToday']).mode]
}

/** 每项口径影响的页面（页面上“影响范围”一行原样显示）。 */
export const BUSINESS_RULE_IMPACT: Readonly<Record<BusinessRuleKey, readonly string[]>> = {
  netSales: ['利润分析（净销售额）', '口径版本差异报告'],
  availableInventory: ['库存列表与库存详情（可用库存列）'],
  weekStart: ['经营控制台（按周汇总与周环比）'],
  multiSiteToday: ['今日实时（业务日的取法；站点时区尚未建模，目前各取法结果相同，按企业时区取今天）'],
}

/** 净销售额：销售额减去勾选的扣减项（退款、促销费用都是正数的花费）；销售额没有数据为 null。 */
export function netSalesOf(rule: BusinessRulesConfig['netSales'], amounts: { revenue: number | null; refunds: number | null; promotion: number | null }): number | null {
  if (amounts.revenue === null) return null
  const deducted = rule.deduct.reduce((sum, item) => sum + ((item === 'REFUNDS' ? amounts.refunds : amounts.promotion) ?? 0), 0)
  return round6(amounts.revenue - deducted)
}

/** 可用库存：勾选的组成项相加；任一勾选项没有数据（空）时整体为 null，不拿缺项的数冒充。 */
export function availableInventoryOf(
  rule: BusinessRulesConfig['availableInventory'],
  quantity: { sellable: number | null; reserved: number | null; inboundWorking: number | null; inboundShipped: number | null; inboundReceiving: number | null },
): number | null {
  const pickValue: Record<InventoryComponent, number | null> = {
    FULFILLABLE: quantity.sellable,
    RESERVED: quantity.reserved,
    INBOUND_WORKING: quantity.inboundWorking,
    INBOUND_SHIPPED: quantity.inboundShipped,
    INBOUND_RECEIVING: quantity.inboundReceiving,
  }
  let total = 0
  for (const component of rule.components) {
    const value = pickValue[component]
    if (value === null) return null
    total += value
  }
  return total
}

/** 一周的开始日：返回包含 `date` 的那一周的第一天（YYYY-MM-DD）。 */
export function weekStartOf(date: string, day: WeekStartDay): string {
  const time = Date.parse(`${date}T00:00:00Z`)
  const weekday = new Date(time).getUTCDay()
  const back = (weekday - WEEK_START_INDEX[day] + 7) % 7
  return new Date(time - back * 86_400_000).toISOString().slice(0, 10)
}

/** 多站点“今日”：统一取最晚的站点（各站点日期里最大的那个）或各站点各自取（返回每个站点自己的日期）。站点日期为空时没有结果。 */
export function resolveToday(mode: MultiSiteTodayMode, siteDates: readonly string[]): { shared: string | null; perSite: readonly string[] } {
  if (siteDates.length === 0) return { shared: null, perSite: [] }
  if (mode === 'EACH_SITE') return { shared: null, perSite: siteDates }
  const latest = [...siteDates].sort().pop() ?? null
  return { shared: latest, perSite: siteDates.map(() => latest as string) }
}

/** 两份业务口径的差别，逐项写成人话。 */
export function describeRuleChanges(before: BusinessRulesConfig, after: BusinessRulesConfig): string[] {
  return BUSINESS_RULE_KEYS.flatMap(key =>
    sameRuleValue(before[key], after[key]) ? [] : [`${BUSINESS_RULE_LABEL[key]}：${describeBusinessRule(key, before[key])} → ${describeBusinessRule(key, after[key])}`],
  )
}
