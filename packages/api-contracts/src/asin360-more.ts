import type { BaBreakpoint, BaPeriod } from './brand-analytics.js'
import type { BaFunnelStage, BaShareSet } from './brand-analytics-types.js'
import type { DashState } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'

// ASIN 360 剩余页签与建议动作区的契约（P4-08，05 章 5.2 第 2、7 至 11 个页签与“建议动作区”）。
// 只放常量、纯函数与类型（没有 zod）：请求校验在 asin360-more-query.ts，前端首屏引用本文件不会带上校验代码。
// 原则：有真实数据的区块给真实数据，没有数据来源的区块写明“尚未接入”与负责的工作包，永远不用 0 或示例数字代替。

/** 核心搜索词表最多列出多少个（按搜索量从高到低）。 */
export const ASIN360_TRAFFIC_TERM_LIMIT = 20
/** 竞品页签里对照热门搜索词的核心词个数。 */
export const ASIN360_COMPETITOR_TERM_LIMIT = 5
/** 逐日流量一次最多读取的行数（范围最长 1100 天、两个来源各一行）。 */
export const ASIN360_TRAFFIC_ROW_LIMIT = 2_400

export const ASIN360_TRAFFIC_BASIS =
  '逐日流量来自数据中心“按 ASIN”的销售与流量（子体粒度，同一店铺同一 ASIN 的多个 SKU 共用，数据中心与报告两个来源同一天都有时取数据中心）；转化率 = 订购件数 ÷ 会话，购物车（推荐报价）获得率按会话加权；' +
  '核心搜索词来自品牌分析“搜索查询表现”，份额 = 我方次数 ÷ 市场总次数，断点以这个 ASIN 自己全部搜索词的份额中位数为界；没有数据的指标是空，不是 0'

export const ASIN360_PANEL_TABS = ['listing', 'reviews', 'pricing', 'competitors', 'content'] as const
export type Asin360PanelTab = (typeof ASIN360_PANEL_TABS)[number]

export interface Asin360Range {
  from: string
  to: string
  defaulted: boolean
}

/** 还没有数据来源的区块：说明原因与负责的工作包（永远不存在的来源 workPackage 为 null）。 */
export interface Asin360Section {
  key: string
  title: string
  state: 'NOT_CONNECTED'
  note: string
  workPackage: string | null
}

const pending = (key: string, title: string, note: string, workPackage: string | null): Asin360Section => ({ key, title, state: 'NOT_CONNECTED', note, workPackage })

/** 各页签里没有数据来源的区块（前后端共用同一份文字）。 */
export const ASIN360_PENDING_SECTIONS: Readonly<Record<'traffic' | Asin360PanelTab, readonly Asin360Section[]>> = {
  traffic: [
    pending('device', '移动端与桌面端会话', '官方“按 ASIN”的销售与流量只给会话总数，没有按设备拆分的字段，所以没有这一项；不用估算值代替', null),
    pending('cartRate', '购物车获得率（加购 ÷ 会话）', '官方 ASIN 销售与流量里没有加购列；搜索流量的加购情况见上面的目录表现与核心搜索词漏斗', null),
    pending('hourly', '近 14 天小时级流量', '小时级流量依赖亚马逊通知推送的接收端，部署专项暂缓（14 章 14.10），接入前不显示', null),
  ],
  listing: [
    pending('issues', '刊登问题清单（严重度、涉及属性、修复建议）', '刊登问题项由刊登接口同步，还没有同步器', 'P4-09、P4-10'),
    pending('quality', '刊登质量分（我方计算）', '质量分需要属性完整度、图片数、五点描述条数与 A+ 状态，这些数据还没有来源，不拿部分数据估一个分数', 'P4-10'),
    pending('restrictions', '刊登限制与搜索抑制状态', '刊登限制与搜索抑制来自刊登接口与推送，还没有同步器', 'P4-10'),
    pending('attributes', '属性完整度与商品类型定义对照', '需要商品类型定义接口的数据，还没有同步器', 'P4-10'),
  ],
  // 评分、评论主题与类目对比已由评价与反馈（P4-13）的数据接入（P6-21）；请求评价覆盖率的统计口径还没有定义，仍是尚未接入
  reviews: [pending('coverage', '请求评价覆盖率', '需要“请求评价”动作的历史记录与每期可请求的订单数，这两项的统计口径还没有定义，不拿部分数据估一个比率', 'P4-13')],
  pricing: [
    pending('winPrice', '推荐报价价格与获得推荐报价的预期价格', '需要定价接口的推荐报价数据，还没有同步器', 'P4-11'),
    pending('offers', '竞争报价列表（卖家、配送方式、价格、会员资格）', '需要定价接口的竞争报价数据，还没有同步器', 'P4-11'),
    pending('history', '价格历史（我方价格、推荐报价价格、最低价）', '价格历史需要定价接口按时间留存快照，还没有开始留存；标价只有最近一次同步值', 'P4-11'),
    pending('events', '失去推荐报价事件与价格健康事件', '依赖亚马逊通知推送，推送接收端暂缓（14 章 14.10）', 'P4-11'),
  ],
  // 关注竞品的价格、销售排名与趋势对比已由竞品监控（P4-12）的数据接入（P6-21，见竞品对比区块），这里没有剩余的未接入项
  competitors: [],
  content: [
    pending('listingContent', '五点描述、描述与全部图片', '商品目录同步目前只取标题、品牌、类目、主图与变体；五点描述、描述与全部图片还没有同步器（A+ 内容已在上方列出）', 'P4-14'),
    pending('compare', '任选两个日期的字段级内容对比', '需要按日留存内容快照，还没有开始留存', 'P4-14'),
    pending('othersChanged', '他人修改详情页告警', '依赖品牌商品内容变更的推送，推送接收端暂缓（14 章 14.10）', 'P4-14'),
  ],
}

// ---- 流量转化 ----

export interface Asin360TrafficPoint {
  date: string
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  buyBoxPct: number | null
  unitSessionPct: number | null
}

export interface Asin360TrafficSummary {
  sessions: number | null
  pageViews: number | null
  units: number | null
  sales: number | null
  /** 订购件数 ÷ 会话（两者都有记录的日子合计）。 */
  unitSessionPct: number | null
  /** 购物车（推荐报价）获得率，按会话加权。 */
  buyBoxPct: number | null
  pageViewsPerSession: number | null
  /** 有记录的天数。 */
  days: number
}

export interface Asin360TrafficDaily {
  state: DashState
  note: string | null
  points: Asin360TrafficPoint[]
  summary: Asin360TrafficSummary | null
  truncated: boolean
}

export interface Asin360CoreTerm {
  searchQuery: string
  searchVolume: number | null
  shares: BaShareSet
  ownPurchases: number | null
  breakpoint: BaBreakpoint | null
}

export interface Asin360FunnelPeriod {
  kind: BaPeriod
  start: string
  end: string | null
  previousStart: string | null
  /** 已有数据的周期起始日，最近的在前。 */
  available: string[]
}

export interface Asin360BreakpointSummary {
  state: 'OK' | 'INSUFFICIENT'
  note: string
  counts: Record<BaBreakpoint, number>
  medians: BaShareSet | null
}

export interface Asin360SearchFunnel {
  state: DashState
  note: string | null
  period: Asin360FunnelPeriod | null
  stages: BaFunnelStage[]
  terms: Asin360CoreTerm[]
  termCount: number
  breakpoints: Asin360BreakpointSummary
  truncated: boolean
}

export interface Asin360CatalogMetrics {
  impressions: number | null
  clicks: number | null
  cartAdds: number | null
  purchases: number | null
  clickRate: number | null
  conversionRate: number | null
  searchTrafficSales: number | null
  currency: string | null
}

export interface Asin360CatalogFunnel {
  state: DashState
  note: string | null
  period: Pick<Asin360FunnelPeriod, 'kind' | 'start' | 'end' | 'previousStart'> | null
  current: Asin360CatalogMetrics | null
  previous: Asin360CatalogMetrics | null
}

export interface Asin360TrafficResponse {
  range: Asin360Range
  daily: Asin360TrafficDaily
  searchFunnel: Asin360SearchFunnel
  catalogFunnel: Asin360CatalogFunnel
  pending: Asin360Section[]
  freshness: InventoryFreshness
  basis: string
}

// ---- 其余五个页签 ----

export interface Asin360Fact {
  label: string
  /** 为空表示没有记录（页面写“尚无记录”，不写 0 或空串）。 */
  value: string | null
  /** time 表示 value 是 ISO 时间，页面按本地时间显示。 */
  kind?: 'time'
}

export const ASIN360_LISTING_BASIS = '这里只列本系统已经同步到的刊登资料（商品目录同步写入）；刊登问题、质量分、限制与搜索抑制没有数据来源，在下面逐项写明“尚未接入”，不拿目录状态冒充'
export const ASIN360_REVIEWS_BASIS =
  '评分与评分数只来自评分文件导入（亚马逊没有这两项的官方接口），按采集日期留存；评论主题（前 10 正面与前 10 负面）来自客户反馈接口，提及量与评论数档位是接口给的区间原文；类目对比取最近两个月的主题占比，类目全部商品与前 25% 商品各一列；没有数据的项是空，不是 0'
export const ASIN360_PRICING_BASIS =
  '成交均价 = 订单口径销售额 ÷ 件数（不是标价，也不是推荐报价价格）；推荐报价（购物车）获得率来自数据中心的销售与流量，按会话加权；标价是商品目录与库存同步写入的最近一次值，没有历史'
export const ASIN360_COMPETITORS_BASIS =
  '这里对照的是品牌分析“热门搜索词”里这个 ASIN 的核心搜索词（取搜索查询表现里搜索量最高的几个）点击份额前三的商品；只含搜索频率排名靠前的词，没有的词不列。关注竞品的价格、排名与评分的并列趋势见上方“竞品对比”'
export const ASIN360_CONTENT_BASIS =
  '商品目录同步取到的内容字段（标题、品牌、类目、类型、主图与变体属性），加上 A+ 内容管理（P4-14）里关联到这个 ASIN 的 A+ 内容与审核状态；五点描述、描述、全部图片与内容对比没有数据来源，逐项写明“尚未接入”'

export interface Asin360PanelBase {
  /** 还没有数据来源的区块。 */
  pending: Asin360Section[]
  basis: string
}

export interface Asin360ListingResponse extends Asin360PanelBase {
  facts: Asin360Fact[]
}

/** 类目对比最多列出多少个主题（本商品前 10 正面与前 10 负面）。 */
export const ASIN360_CATEGORY_TOPIC_LIMIT = 20

export interface Asin360RatingPoint {
  date: string
  avgRating: number | null
  ratingCount: number | null
}

export interface Asin360ReviewTopic {
  rank: number
  topicKey: string
  /** 接口给的提及量与评论数区间原文；没给为空，不估算。 */
  mentionRange: string | null
  reviewCountBucket: string | null
}

export interface Asin360CategoryTopicRow {
  topicKey: string
  sentiment: 'POSITIVE' | 'NEGATIVE'
  /** 这个主题在本商品里的名次；不在本商品前 10 为空（类目的主题不一定在本商品里）。 */
  productRank: number | null
  /** 类目全部商品、类目前 25% 商品的占比（0 到 1）与上一个月的占比；该月没有数据为空。 */
  allRate: number | null
  allPrevious: number | null
  top25Rate: number | null
  top25Previous: number | null
}

export interface Asin360ReviewsResponse extends Asin360PanelBase {
  rating: {
    state: 'OK' | 'NO_DATA'
    note: string | null
    sourceLabel: string
    latest: { date: string; avgRating: number | null; ratingCount: number | null; distribution: Record<string, number> | null; sourceFileName: string } | null
    /** 最近 12 个采集点，从早到晚。 */
    points: Asin360RatingPoint[]
  }
  topics: { state: 'OK' | 'NO_DATA'; note: string | null; snapshotDate: string | null; positive: Asin360ReviewTopic[]; negative: Asin360ReviewTopic[] }
  category: { state: 'OK' | 'NO_DATA'; note: string | null; browseNodeName: string | null; month: string | null; previousMonth: string | null; rows: Asin360CategoryTopicRow[] }
}

export interface Asin360AplusItem {
  contentId: string
  name: string
  status: string
  locale: string
  /** 这个 ASIN 在这条 A+ 上的上线时间；没有发布记录为空。 */
  publishedAt: string | null
  amazonUpdatedAt: string | null
  /** 被拒绝时亚马逊给的原因原文。 */
  rejectionReason: string | null
}

export interface Asin360PricingDay {
  date: string
  units: number | null
  sales: number | null
  /** 成交均价 = 销售额 ÷ 件数（没有件数为空）。 */
  avgPrice: number | null
  /** 推荐报价（购物车）获得率。 */
  buyBoxPct: number | null
}

export interface Asin360PricingResponse extends Asin360PanelBase {
  range: Asin360Range
  currency: string
  listPrice: { value: number | null; currency: string; updatedAt: string | null }
  daily: { state: DashState; note: string | null; points: Asin360PricingDay[]; avgPrice: number | null; buyBoxPct: number | null }
}

export interface Asin360CompetitorSlot {
  rank: 1 | 2 | 3
  asin: string | null
  title: string | null
  clickShare: number | null
  conversionShare: number | null
  /** 就是这个 ASIN。 */
  isSelf: boolean
  /** 企业范围内的其他商品（我方）。 */
  isOwn: boolean
}

export interface Asin360CompetitorTerm {
  searchTerm: string
  frequencyRank: number | null
  slots: Asin360CompetitorSlot[]
  /** 这个 ASIN 在该词点击前三里的名次；不在前三为 null。 */
  selfRank: 1 | 2 | 3 | null
}

export interface Asin360CompetitorsResponse extends Asin360PanelBase {
  terms: { state: DashState; note: string | null; period: Asin360FunnelPeriod | null; rows: Asin360CompetitorTerm[] }
}

export interface Asin360ContentResponse extends Asin360PanelBase {
  facts: Asin360Fact[]
  imageUrl: string | null
  /** 关联到这个 ASIN 的 A+ 内容（P4-14，需要 aplus.read；本页签本来就要求它）。 */
  aplus: { state: 'OK' | 'NO_DATA'; note: string | null; items: Asin360AplusItem[]; truncated: boolean }
}

// ---- 建议动作区的规则（05 章 5.2 的 6 条） ----

export type Asin360ActionRuleKey = 'PRICE_ABOVE_WIN' | 'LOW_COVER' | 'LISTING_ERROR' | 'NEGATIVE_REVIEW' | 'AGING_FEE' | 'CONTENT_CHANGED'

export interface Asin360ActionRuleDef {
  key: Asin360ActionRuleKey
  trigger: string
  advice: string
  /** 数据来源：库存类规则由库存详情的建议承担（suggestionIds 是对应的建议编号），其余随各工作包上线。 */
  source: 'inventory' | 'pending'
  suggestionIds: readonly string[]
  workPackage: string | null
  pendingNote: string
}

export const ASIN360_ACTION_RULES: readonly Asin360ActionRuleDef[] = [
  {
    key: 'PRICE_ABOVE_WIN',
    trigger: '我方价格高于预期获胜价',
    advice: '调整至预期获胜价',
    source: 'pending',
    suggestionIds: [],
    workPackage: 'P4-11',
    pendingNote: '预期获胜价来自定价接口，还没有同步器',
  },
  { key: 'LOW_COVER', trigger: '可售天数低于目标', advice: '生成补货建议', source: 'inventory', suggestionIds: ['replenish'], workPackage: null, pendingNote: '' },
  { key: 'LISTING_ERROR', trigger: '新增刊登错误', advice: '修复刊登', source: 'pending', suggestionIds: [], workPackage: 'P4-09、P4-10', pendingNote: '刊登问题项还没有同步器' },
  {
    key: 'NEGATIVE_REVIEW',
    trigger: '负面评论主题占比上升',
    advice: '查看主题与关联退货原因',
    source: 'pending',
    suggestionIds: [],
    workPackage: 'P4-13',
    pendingNote: '评论主题来自客户反馈接口，还没有同步器',
  },
  { key: 'AGING_FEE', trigger: '库龄附加费即将收取', advice: '移除或促销', source: 'inventory', suggestionIds: ['aging'], workPackage: null, pendingNote: '' },
  {
    key: 'CONTENT_CHANGED',
    trigger: '详情页内容被他人修改',
    advice: '核对差异',
    source: 'pending',
    suggestionIds: [],
    workPackage: 'P4-14',
    pendingNote: '内容变更依赖品牌商品内容变更的推送，推送接收端暂缓（14 章 14.10）',
  },
]

/** TRIGGERED 已触发；CLEAR 数据齐全、没有触发；NO_DATA 没有库存记录；RESTRICTED 没有权限；NOT_CONNECTED 数据来源还没有接入。 */
export type Asin360ActionRuleState = 'TRIGGERED' | 'CLEAR' | 'NO_DATA' | 'RESTRICTED' | 'NOT_CONNECTED'

export const ASIN360_ACTION_RULE_STATE_LABEL: Readonly<Record<Asin360ActionRuleState, string>> = {
  TRIGGERED: '已触发',
  CLEAR: '未触发',
  NO_DATA: '尚无记录',
  RESTRICTED: '无权查看',
  NOT_CONNECTED: '尚未接入',
}

export interface Asin360ActionRuleView {
  key: Asin360ActionRuleKey
  trigger: string
  advice: string
  state: Asin360ActionRuleState
  note: string | null
  workPackage: string | null
}

/** 6 条规则各自的状态：库存类按库存详情的建议判断，其余没有数据来源的一律“尚未接入”（不当作“没触发”）。 */
export function asin360ActionRuleViews(input: { inventory: 'OK' | 'NO_DATA' | 'RESTRICTED'; suggestionIds: readonly string[] }): Asin360ActionRuleView[] {
  return ASIN360_ACTION_RULES.map(def => {
    const view = { key: def.key, trigger: def.trigger, advice: def.advice, workPackage: def.workPackage }
    if (def.source === 'pending') return { ...view, state: 'NOT_CONNECTED' as const, note: def.pendingNote }
    if (input.inventory === 'RESTRICTED') return { ...view, state: 'RESTRICTED' as const, note: '需要“库存”读取权限才能判断' }
    if (input.inventory === 'NO_DATA') return { ...view, state: 'NO_DATA' as const, note: '这个商品还没有库存记录' }
    const hit = def.suggestionIds.some(id => input.suggestionIds.includes(id))
    return { ...view, state: hit ? ('TRIGGERED' as const) : ('CLEAR' as const), note: null }
  })
}
