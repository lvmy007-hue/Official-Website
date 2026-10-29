// 连接中心的角色对照（P5-04，09 章 9.6；importers.md 0.7 角色名称对照与各来源“所需角色”列）。本文件没有 zod，前端首屏之外的页面与接口服务共用。
// 重要限制：亚马逊没有给出“列出应用已获得的角色”的接口（没有核实到），所以这里不能直接读到“已获得哪些角色”。
// 做法是按各数据来源最近一次同步的结果推断：来源同步成功过，说明它所需角色里至少有一个已具备；同步以“缺少角色”失败，就是缺失；从没同步过，就是“尚未验证”。
// 官方“所需角色”是“至少具备其一即可”，所以只有只依赖单个角色的来源才能反推出那个角色的状态；与其他角色并列的角色显示“无法单独验证”。

export const SP_ROLES = [
  { name: 'Amazon Fulfillment', label: '亚马逊物流', restricted: false },
  { name: 'Inventory and Order Tracking', label: '库存与订单跟踪', restricted: false },
  { name: 'Finance and Accounting', label: '财务与会计', restricted: false },
  { name: 'Product Listing', label: '商品刊登', restricted: false },
  { name: 'Pricing', label: '定价', restricted: false },
  { name: 'Brand Analytics', label: '品牌分析', restricted: false },
  { name: 'Selling Partner Insights', label: '卖家洞察', restricted: false },
  { name: 'Buyer Solicitation', label: '请求评价', restricted: false },
  { name: 'Buyer Communication', label: '买家沟通', restricted: false },
  { name: 'Amazon Warehousing and Distribution', label: '亚马逊仓储分销', restricted: false },
  { name: 'Direct to Consumer Shipping (Restricted)', label: '直接面向消费者配送（受限，涉及买家信息）', restricted: true },
  { name: 'Tax Remittance (Restricted)', label: '税务汇缴（受限）', restricted: true },
  { name: 'Tax Invoicing (Restricted)', label: '税务开票（受限）', restricted: true },
  { name: 'Selling Partner Support (Restricted)', label: '卖家支持（受限）', restricted: true },
  { name: 'Professional Services (Restricted)', label: '专业服务（受限）', restricted: true },
] as const
export type SpRoleName = (typeof SP_ROLES)[number]['name']

export interface RoleModulePage {
  path: string
  title: string
}
export interface RoleModule {
  key: string
  label: string
  /** 所需角色，至少具备其一即可（importers.md）。 */
  roles: readonly SpRoleName[]
  /** 判断这个板块是否打通的数据来源（DataFreshness 来源键）。 */
  sourceKeys: readonly string[]
  /** 缺失时受影响的页面。 */
  pages: readonly RoleModulePage[]
}

const ORDER_ROLES: readonly SpRoleName[] = [
  'Amazon Fulfillment',
  'Buyer Communication',
  'Buyer Solicitation',
  'Direct to Consumer Shipping (Restricted)',
  'Finance and Accounting',
  'Inventory and Order Tracking',
  'Pricing',
  'Product Listing',
  'Professional Services (Restricted)',
  'Selling Partner Insights',
  'Tax Invoicing (Restricted)',
  'Tax Remittance (Restricted)',
]
const page = (path: string, title: string): RoleModulePage => ({ path, title })

export const ROLE_MODULES: readonly RoleModule[] = [
  { key: 'orders', label: '订单', roles: ORDER_ROLES, sourceKeys: ['orders.api'], pages: [page('/app/today', '今日实时'), page('/app/orders', '订单'), page('/app/overview', '经营控制台')] },
  {
    key: 'finance',
    label: '财务交易与结算',
    roles: ['Finance and Accounting'],
    sourceKeys: ['finance.transactions', 'rpt.settlement'],
    pages: [page('/app/finance', '费用事件'), page('/app/settlements', '结算交易'), page('/app/finance/cashflow', '回款与现金流')],
  },
  {
    key: 'inventory',
    label: '库存',
    roles: ['Amazon Fulfillment', 'Product Listing'],
    sourceKeys: ['inventory.api'],
    pages: [page('/app/inventory', '库存健康'), page('/app/replenishment', '补货建议')],
  },
  { key: 'inbound', label: '入仓计划', roles: ['Amazon Fulfillment'], sourceKeys: ['inbound.plan'], pages: [page('/app/overview', '经营控制台')] },
  { key: 'awd', label: '亚马逊仓储分销', roles: ['Amazon Warehousing and Distribution'], sourceKeys: ['awd.api'], pages: [page('/app/awd', '亚马逊仓储分销')] },
  { key: 'catalog', label: '商品目录', roles: ['Product Listing'], sourceKeys: ['catalog.items-v2022'], pages: [page('/app/products', '商品主数据')] },
  {
    key: 'listings',
    label: '刊登',
    roles: ['Inventory and Order Tracking', 'Product Listing'],
    sourceKeys: ['listings.items-v2021'],
    pages: [page('/app/listings', '刊登表现'), page('/app/listings/quality', '刊登质量与合规')],
  },
  { key: 'pricing', label: '定价与购物车', roles: ['Pricing'], sourceKeys: ['pricing.api'], pages: [page('/app/pricing', '定价与购物车')] },
  { key: 'promotions', label: '促销与优惠券', roles: ['Pricing', 'Product Listing'], sourceKeys: ['promotions.api'], pages: [page('/app/promotions', '促销与优惠券')] },
  { key: 'subscribe-save', label: '订阅省', roles: ['Brand Analytics', 'Inventory and Order Tracking'], sourceKeys: ['replenishment.api'], pages: [page('/app/subscribe-save', '订阅省')] },
  { key: 'support', label: '支持案件', roles: ['Selling Partner Support (Restricted)'], sourceKeys: ['support.api'], pages: [page('/app/support-cases', '支持案件')] },
  { key: 'tax', label: '销售税', roles: ['Tax Remittance (Restricted)'], sourceKeys: ['rpt.sales-tax'], pages: [page('/app/finance/sales-tax', '销售税')] },
  {
    key: 'brand',
    label: '品牌分析',
    roles: ['Brand Analytics'],
    sourceKeys: ['rpt.ba.search-query', 'rpt.ba.search-catalog', 'rpt.ba.search-terms', 'rpt.ba.market-basket', 'rpt.ba.repeat-purchase'],
    pages: [page('/app/analytics/brand/search-query', '品牌分析·搜索查询表现'), page('/app/analytics/brand/search-terms', '品牌分析·热门搜索词')],
  },
  {
    key: 'sales-traffic',
    label: '销售与流量',
    roles: ['Brand Analytics'],
    sourceKeys: ['dk.sales-traffic.date', 'dk.sales-traffic.asin', 'dk.sales-traffic.trends'],
    pages: [page('/app/analytics/business-reports', '业务报告'), page('/app/analytics/asins', 'ASIN 与父体分析')],
  },
  { key: 'feedback', label: '评论与退货主题', roles: ['Brand Analytics', 'Selling Partner Insights'], sourceKeys: ['feedback.api'], pages: [page('/app/reviews', '评价与反馈')] },
  { key: 'aplus', label: 'A+ 内容', roles: ['Brand Analytics', 'Product Listing'], sourceKeys: ['aplus.api'], pages: [page('/app/aplus', 'A+ 内容')] },
  { key: 'economics', label: '官方经济数据', roles: ['Selling Partner Insights'], sourceKeys: ['dk.economics', 'dk.economics.preview'], pages: [page('/app/finance/economics', '官方经济数据对账')] },
  { key: 'account-health', label: '账户健康', roles: ['Selling Partner Insights'], sourceKeys: ['rpt.seller-performance'], pages: [page('/app/account-health', '账户健康')] },
]

/** 品牌分析资格这类“连接”要看的来源：品牌分析报告、数据中心销售与流量、评论主题。 */
export const BRAND_EVIDENCE_SOURCES: readonly string[] = ROLE_MODULES.filter(item => ['brand', 'sales-traffic', 'feedback'].includes(item.key)).flatMap(item => [...item.sourceKeys])

// ---- 证据：一个来源在一个店铺的最近同步结果 ----

export type EvidenceState = 'OK' | 'MISSING' | 'NOT_APPLICABLE' | 'AUTH_EXPIRED' | 'FAILED' | 'UNVERIFIED'
export interface EvidenceRow {
  sellerAccountId: string | null
  sourceKey: string
  status: string
  lastSuccessAt: Date | string | null
  lastErrorCode: string | null
}

/** 失败码是“缺少角色或资格”：各来源的 *_ROLE_MISSING、*_ROLE_PENDING，以及品牌分析资格类失败码。 */
export const isRoleFailureCode = (code: string | null | undefined) => Boolean(code) && (/(^|_)ROLE_(MISSING|PENDING)$/.test(code ?? '') || code === 'DK_NO_BRAND' || code === 'FBK_NO_BRAND_ACCESS')
/** 店铺不具备前提（例如没有品牌备案）：不是角色问题，也不是故障。 */
const isNotApplicableCode = (code: string | null | undefined) => code === 'BA_NO_BRAND' || code === 'SCOPE_UNAVAILABLE'

export function evidenceOf(row: EvidenceRow | undefined): EvidenceState {
  if (!row) return 'UNVERIFIED'
  const code = row.lastErrorCode
  if (code === 'AUTH_EXPIRED') return 'AUTH_EXPIRED'
  if (isRoleFailureCode(code) || row.status === 'UNAUTHORIZED') return 'MISSING'
  if (row.status === 'NOT_APPLICABLE' || isNotApplicableCode(code)) return 'NOT_APPLICABLE'
  if (row.status === 'FAILED') return 'FAILED'
  // 成功过且最近没有以失败收场：限流、延迟、等待依赖都不否定“角色已具备”
  if (row.lastSuccessAt) return 'OK'
  return row.status === 'NORMAL' || row.status === 'DELAYED' ? 'UNVERIFIED' : 'FAILED'
}

export interface EvidenceCounts {
  ok: number
  missing: number
  notApplicable: number
  authExpired: number
  failed: number
  unverified: number
}
export const emptyCounts = (): EvidenceCounts => ({ ok: 0, missing: 0, notApplicable: 0, authExpired: 0, failed: 0, unverified: 0 })
const COUNT_KEY: Record<EvidenceState, keyof EvidenceCounts> = {
  OK: 'ok',
  MISSING: 'missing',
  NOT_APPLICABLE: 'notApplicable',
  AUTH_EXPIRED: 'authExpired',
  FAILED: 'failed',
  UNVERIFIED: 'unverified',
}

/** 一个店铺在一组来源上的综合证据：任一来源成功就算成功（它们所需角色相同）；都没成功时按缺失、不适用、授权失效、故障的顺序取。 */
export function combineEvidence(states: readonly EvidenceState[]): EvidenceState {
  if (states.includes('OK')) return 'OK'
  for (const state of ['MISSING', 'NOT_APPLICABLE', 'AUTH_EXPIRED', 'FAILED'] as const) if (states.includes(state)) return state
  return 'UNVERIFIED'
}

export const MODULE_STATES = ['GRANTED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'UNVERIFIED'] as const
export type ModuleState = (typeof MODULE_STATES)[number]
export const MODULE_STATE_LABEL: Readonly<Record<ModuleState, string>> = {
  GRANTED: '已打通',
  PARTIAL: '部分店铺缺失',
  MISSING: '缺少角色',
  NOT_APPLICABLE: '不适用（店铺不具备前提）',
  UNVERIFIED: '尚未验证',
}

export function moduleStateOf(counts: EvidenceCounts): ModuleState {
  if (counts.ok > 0) return counts.missing > 0 ? 'PARTIAL' : 'GRANTED'
  if (counts.missing > 0) return 'MISSING'
  if (counts.notApplicable > 0) return 'NOT_APPLICABLE'
  return 'UNVERIFIED'
}

export interface RoleModuleView {
  key: string
  label: string
  roles: { name: SpRoleName; label: string }[]
  state: ModuleState
  stateLabel: string
  counts: EvidenceCounts
  storeCount: number
  pages: readonly RoleModulePage[]
  /** 缺失或部分缺失时说明会影响哪些页面；其余为 null。 */
  impact: string | null
}

const roleLabelOf = (name: SpRoleName) => SP_ROLES.find(item => item.name === name)?.label ?? name

/** 各板块的角色对照：stores 是范围内有卖家授权的店铺编号，rows 是这些店铺的新鲜度记录。 */
export function evaluateRoleModules(stores: readonly string[], rows: readonly EvidenceRow[]): RoleModuleView[] {
  const byStoreSource = new Map(rows.filter(row => row.sellerAccountId).map(row => [`${row.sellerAccountId}|${row.sourceKey}`, row]))
  return ROLE_MODULES.map(module => {
    const counts = emptyCounts()
    for (const store of stores) {
      const state = combineEvidence(module.sourceKeys.map(key => evidenceOf(byStoreSource.get(`${store}|${key}`))))
      counts[COUNT_KEY[state]] += 1
    }
    const state = moduleStateOf(counts)
    const affected = module.pages.map(item => `“${item.title}”`).join('、')
    const missingRoles = module.roles.map(roleLabelOf).join('、')
    const impact = state === 'MISSING' || state === 'PARTIAL' ? `${state === 'PARTIAL' ? '部分店铺' : ''}缺少所需角色（${missingRoles}，至少具备其一），会影响：${affected}` : null
    return {
      key: module.key,
      label: module.label,
      roles: module.roles.map(name => ({ name, label: roleLabelOf(name) })),
      state,
      stateLabel: MODULE_STATE_LABEL[state],
      counts,
      storeCount: stores.length,
      pages: module.pages,
      impact,
    }
  })
}

export const ROLE_STATES = ['VERIFIED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'UNVERIFIED', 'NOT_DIRECTLY_VERIFIABLE'] as const
export type RoleState = (typeof ROLE_STATES)[number]
export const ROLE_STATE_LABEL: Readonly<Record<RoleState, string>> = {
  VERIFIED: '已验证具备',
  PARTIAL: '部分店铺缺失',
  MISSING: '缺失',
  NOT_APPLICABLE: '不适用',
  UNVERIFIED: '尚未验证',
  NOT_DIRECTLY_VERIFIABLE: '无法单独验证',
}
export interface RoleView {
  name: SpRoleName
  label: string
  restricted: boolean
  state: RoleState
  stateLabel: string
  /** 依赖这个角色的板块（含与其他角色并列的）。 */
  usedBy: string[]
  /** 只依赖这个角色、因而能据以验证它的板块。 */
  soleModules: string[]
}

/** 角色清单：只有“只依赖这一个角色”的板块才能验证它；与别的角色并列时只能说“无法单独验证”。 */
export function evaluateRoles(modules: readonly RoleModuleView[]): RoleView[] {
  return SP_ROLES.map(role => {
    const using = modules.filter(item => item.roles.some(entry => entry.name === role.name))
    const sole = using.filter(item => item.roles.length === 1)
    const states = sole.map(item => item.state)
    const state: RoleState =
      sole.length === 0
        ? 'NOT_DIRECTLY_VERIFIABLE'
        : states.includes('GRANTED')
          ? 'VERIFIED'
          : states.includes('PARTIAL')
            ? 'PARTIAL'
            : states.includes('MISSING')
              ? 'MISSING'
              : states.includes('NOT_APPLICABLE')
                ? 'NOT_APPLICABLE'
                : 'UNVERIFIED'
    return {
      name: role.name,
      label: role.label,
      restricted: role.restricted,
      state,
      stateLabel: ROLE_STATE_LABEL[state],
      usedBy: using.map(item => item.label),
      soleModules: sole.map(item => item.label),
    }
  })
}

export const ROLE_COMPARISON_BASIS =
  '亚马逊没有提供列出应用已获得角色的接口，这里按各数据来源最近一次同步的结果推断：来源同步成功说明它所需角色（至少具备其一）已具备，以“缺少角色”失败就是缺失，从没同步过显示“尚未验证”。只依赖单个角色的板块才能据以验证该角色。'
