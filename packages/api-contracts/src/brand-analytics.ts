// 品牌分析（P4-04，04 章 4.7，freeze/api.md /analytics/brand/*）：亚马逊品牌分析的五份报告落库后的五个页面。
// 只放常量、标签与响应类型（没有 zod，请求校验在 brand-analytics-query.ts）；纯计算在 brand-analytics-math.ts。
// 口径约定：
//   - 品牌分析数据按“报告周期”存：周（周日至周六）、月（自然月）、季（自然季度）；页面选一个周期种类与起始日，对比上一个同种周期；
//   - 份额 = 我方次数 ÷ 市场总次数（按次数重算，不对份额做简单平均）；官方没给的值是 null（页面写“尚无记录”），不是 0；
//   - 需要店铺有品牌备案并获批“品牌分析”角色；没有这个角色的店铺没有数据，页面写前提，不显示示例数字。

export const BRAND_ANALYTICS_READ = 'analytics.brand.read'

/** 专属失败码：亚马逊以 403 拒绝品牌分析报告（店铺没有品牌备案或没有授权品牌分析角色）。新鲜度记“不适用”，页面写前提。 */
export const BA_NO_BRAND = 'BA_NO_BRAND'
/** 专属失败码：报告的时间范围不是完整的一周、一个自然月或一个自然季度（亚马逊只接受对齐的周期）。 */
export const BA_PERIOD_INVALID = 'BA_PERIOD_INVALID'

export const BA_PERIODS = ['WEEK', 'MONTH', 'QUARTER'] as const
export type BaPeriod = (typeof BA_PERIODS)[number]
export const BA_PERIOD_LABEL: Readonly<Record<BaPeriod, string>> = { WEEK: '周', MONTH: '月', QUARTER: '季' }

export const BA_PAGES = ['search-query', 'catalog', 'search-terms', 'market-basket', 'repeat-purchase'] as const
export type BaPage = (typeof BA_PAGES)[number]

export interface BaReportDef {
  page: BaPage
  /** importers.md 编号。 */
  code: string
  reportType: string
  freshnessKey: string
  label: string
}
export const BA_REPORT_DEFS: readonly BaReportDef[] = [
  { page: 'search-query', code: 'R-35', reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', freshnessKey: 'rpt.ba.search-query', label: '品牌分析·搜索查询表现' },
  { page: 'catalog', code: 'R-36', reportType: 'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT', freshnessKey: 'rpt.ba.search-catalog', label: '品牌分析·目录表现' },
  { page: 'search-terms', code: 'R-37', reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', freshnessKey: 'rpt.ba.search-terms', label: '品牌分析·热门搜索词' },
  { page: 'market-basket', code: 'R-38', reportType: 'GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT', freshnessKey: 'rpt.ba.market-basket', label: '品牌分析·购物篮分析' },
  { page: 'repeat-purchase', code: 'R-39', reportType: 'GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT', freshnessKey: 'rpt.ba.repeat-purchase', label: '品牌分析·重复购买' },
]
export const BA_REPORT_TYPES: readonly string[] = BA_REPORT_DEFS.map(def => def.reportType)
export const isBrandReportType = (reportType: string | null | undefined): boolean => !!reportType && BA_REPORT_TYPES.includes(reportType)
export const baReportOf = (page: BaPage): BaReportDef => BA_REPORT_DEFS.find(def => def.page === page)!

/** 一次最多读多少行（Prisma 单次读取上限 20000，多读 1 行判断被截断，所以是 19,999）。 */
export const BA_ROW_LIMIT = 19_999
/** 热门搜索词报告只导入搜索频率排名靠前的词（整份报告可达数百万行）；排名超过它的行不导入。 */
export const BA_TERMS_RANK_LIMIT = 20_000
/** 周期选择器最多列出多少个已有数据的周期（最近的在前）。 */
export const BA_PERIOD_OPTIONS_LIMIT = 24
/** 趋势最多回看多少个周期。 */
export const BA_HISTORY_PERIODS = 12
/** 搜索量前 N 的词用来画逐期趋势（同一批词逐期对比）。 */
export const BA_TREND_TERMS = 500
/** 搜索查询表现报告一次最多带多少个 ASIN（亚马逊限制 200 个，空格分隔）。 */
export const BA_SQP_ASIN_LIMIT = 200
/** 中位数分析（象限、断点）至少要有多少个词带完整份额，否则不分析并写原因。 */
export const BA_MIN_SAMPLE = 5
/** 一次返回的象限散点上限（按搜索量从高到低）。 */
export const BA_QUADRANT_POINTS = 300
/** 品牌搜索份额总览列出的词组数。 */
export const BA_OVERVIEW_ROOTS = 20
export const BA_ASIN_OPTIONS = 200

export const BA_BASIS =
  '品牌分析是亚马逊官方的搜索与购买数据（需要品牌备案与“品牌分析”角色），按周、月、季发布；份额按次数重算（我方次数 ÷ 市场总次数），不对份额做简单平均；日期是亚马逊美国站的日历日。'
export const BA_NO_BRAND_NOTE = '品牌分析需要卖家有品牌备案并获批“品牌分析”角色；没有这个角色的店铺没有这里的数据，本页不会用其他数据来冒充'
export const BA_NO_DATA_NOTE = '所选周期内尚无品牌分析数据：店铺具备品牌分析角色后，同步任务会按周与按月自动申请报告，数据会自动出现；本页不显示示例数字'

// ---- 份额漏斗断点与机会象限（M-146、M-148）----

export const BA_BREAKPOINTS = ['CLICK', 'CART', 'PURCHASE'] as const
export type BaBreakpoint = (typeof BA_BREAKPOINTS)[number]
export const BA_BREAKPOINT_LABEL: Readonly<Record<BaBreakpoint, string>> = { CLICK: '展示高、点击低', CART: '点击高、加购低', PURCHASE: '加购高、购买低' }
export const BA_BREAKPOINT_ADVICE: Readonly<Record<BaBreakpoint, string>> = {
  CLICK: '展示份额高于中位数但点击份额低于中位数：检查主图、标题与价格',
  CART: '点击份额高于中位数但加购份额低于中位数：检查详情页与评论',
  PURCHASE: '加购份额高于中位数但购买份额低于中位数：检查价格与配送速度',
}
/** 断点判断的口径：“高/低”以我方各份额在全部词中的中位数为界（≥ 中位数为高），上游优先。 */
export const BA_BREAKPOINT_BASIS = '“高/低”以我方各份额在所选周期全部词中的中位数为界（不低于中位数算高）；同一个词按展示 → 点击 → 加购 → 购买的顺序，报出最靠上游的断点'

export const BA_QUADRANTS = ['STAR', 'OPPORTUNITY', 'NICHE', 'WATCH'] as const
export type BaQuadrant = (typeof BA_QUADRANTS)[number]
export const BA_QUADRANT_LABEL: Readonly<Record<BaQuadrant, string>> = { STAR: '核心优势', OPPORTUNITY: '增长机会', NICHE: '利基词', WATCH: '观察' }
export const BA_QUADRANT_HINT: Readonly<Record<BaQuadrant, string>> = {
  STAR: '搜索量高、购买份额高：守住',
  OPPORTUNITY: '搜索量高、购买份额低：优先投入',
  NICHE: '搜索量低、购买份额高：保持',
  WATCH: '搜索量低、购买份额低：观察',
}
export const BA_QUADRANT_BASIS = '横轴搜索量、纵轴购买份额，以所选周期全部词的中位数划分四象限（不低于中位数算高）'

// ---- 热门搜索词的分组规则（可调常量，自定值）----

export const BA_TERM_RULES = {
  /** 机会词：我方没进前三，且搜索频率排名比上一周期上升至少这个比例（排名数字变小）。 */
  riseRatio: 0.2,
  /** 风险词：我方在前三，但点击份额比上一周期下降至少这么多（0.05 = 5 个百分点）；或上一周期在前三、这一周期掉出前三。 */
  shareDrop: 0.05,
  topN: 3,
} as const
export const BA_TERM_GROUPS = ['OPPORTUNITY', 'RISK'] as const
export type BaTermGroup = (typeof BA_TERM_GROUPS)[number]
export const BA_TERM_GROUP_LABEL: Readonly<Record<BaTermGroup, string>> = { OPPORTUNITY: '机会词', RISK: '风险词' }
export const BA_TERM_GROUP_BASIS = `机会词：我方没进前三，且搜索频率排名比上一周期上升至少 ${BA_TERM_RULES.riseRatio * 100}%；风险词：上一周期在前三、这一周期掉出前三，或仍在前三但点击份额下降至少 ${BA_TERM_RULES.shareDrop * 100} 个百分点`
export const BA_TERM_COMPETITOR_PENDING = '尚未接入：竞品监控随“竞品监控”工作包（P4-12）交付，交付后这里可一键把竞品 ASIN 加入监控'

// ---- 购物篮建议 ----

export const BA_BASKET_RULES = {
  /** 两个都是我方 ASIN、同篮率不低于它：建议做捆绑销售。 */
  bundleMinPct: 0.1,
  /** 同篮商品不是我方 ASIN、同篮率不低于它：建议做商品定向广告。 */
  targetMinPct: 0.05,
} as const
export const BA_BASKET_ADVICES = ['BUNDLE', 'PRODUCT_TARGETING'] as const
export type BaBasketAdvice = (typeof BA_BASKET_ADVICES)[number]
export const BA_BASKET_ADVICE_LABEL: Readonly<Record<BaBasketAdvice, string>> = { BUNDLE: '捆绑销售候选', PRODUCT_TARGETING: '商品定向广告候选' }
export const BA_BASKET_BASIS = `同篮率不低于 ${BA_BASKET_RULES.bundleMinPct * 100}% 且两个都是我方 ASIN → 捆绑销售候选；同篮率不低于 ${BA_BASKET_RULES.targetMinPct * 100}% 且对方不是我方 ASIN → 商品定向广告候选；只是建议，不会自动执行`
