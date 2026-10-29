// 系统预置的预警规则（09 章 9.1；P2a-15）。纯数据：后台任务在评估前把缺少的规则补进每个企业（只补不覆盖，企业改过的阈值、启停、范围不会被动），
// 规则配置页（P5-01）与待办页也从这里取规则名称与说明。财务与售后预警（结算差异、费用多收、赔付机会即将到期、异常退货率）由 P2b-16 加入；
// 广告预警（高花费低产出、断货商品仍在投放、超预算、单次点击成本突增）由 P3-18 加入；商品预警（刊登问题新增、被搜索抑制、详情页被他人修改、
// 失去推荐报价资格、价格健康异常）与口碑预警（负面评论主题上升）由 P4-15 加入；账户状态变化、账户健康指标未达标由 P5-02 加入；
// 大量查看买家信息明文由 P5-09 加入。
//
// 规则行里的 conditionJson 形如 { type, params }：type 是评估器类型（后台任务按它找到评估器），params 是该评估器的阈值；
// scopeJson 可选 sellerAccountIds（店铺）、skus（SKU）、ownerId（待办负责人）。

export type AlertRuleDomain = 'INVENTORY' | 'PRODUCT' | 'FINANCE' | 'AFTER_SALES' | 'ADS' | 'SYSTEM'
export type AlertRuleSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface AlertRuleDef {
  code: string
  domain: AlertRuleDomain
  name: string
  /** 命中条件的一句话说明（规则页与待办详情显示） */
  description: string
  severity: AlertRuleSeverity
  /** 预警被处理或忽略后，多久之内同一对象再次命中不重复提醒（分钟，0 至 10080） */
  cooldownMinutes: number
  /** 评估器类型 */
  type: string
  /** 评估器的默认阈值 */
  params: Readonly<Record<string, unknown>>
}

export const ALERT_RULE_DOMAIN_LABEL: Readonly<Record<AlertRuleDomain, string>> = {
  INVENTORY: '库存',
  PRODUCT: '商品',
  FINANCE: '财务与费用',
  AFTER_SALES: '售后与口碑',
  ADS: '广告',
  SYSTEM: '系统与账户',
}

const DAY = 24 * 60

export const ALERT_RULE_DEFS: readonly AlertRuleDef[] = [
  {
    code: 'INV_STOCKOUT_RISK',
    domain: 'INVENTORY',
    name: '断货风险',
    description: '按当前生效的库存规则计算，预计断货日早于最快补货到仓日（高风险）；可在阈值里加入“中风险”（断货日落在安全库存之内）。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'inventory.stockout-risk',
    params: { levels: ['HIGH'] },
  },
  {
    code: 'INV_EXCESS',
    domain: 'INVENTORY',
    name: '库存冗余',
    description: '库存覆盖天数超过目标覆盖天数 × 冗余倍数，或近期没有销量但仍有库存。',
    severity: 'INFO',
    cooldownMinutes: 7 * DAY,
    type: 'inventory.excess',
    params: {},
  },
  {
    code: 'INV_AGING_TIER',
    domain: 'INVENTORY',
    name: '库龄附加费即将跨档',
    description: '处于收费档下一级之前的库存，最迟在预警天数内会全部进入库龄附加费收费档（只有库龄分段数量，没有逐件库龄，所以按分段推算窗口）；只看库存规则里“库龄起算天数”及以上的档。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'inventory.aging-tier',
    params: { warnDays: 30 },
  },
  {
    code: 'INV_LOW_LEVEL_FEE',
    domain: 'INVENTORY',
    name: '低库存水平费风险',
    description: '库存规划报告显示该 SKU 已被收取低库存水平费，或预估费用大于 0。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'inventory.low-level-fee',
    params: {},
  },
  {
    code: 'INV_STRANDED',
    domain: 'INVENTORY',
    name: '滞留库存',
    description: '滞留库存报告里该 SKU 有滞留数量，或库存记录带有滞留原因。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'inventory.stranded',
    params: {},
  },
  {
    code: 'INV_INBOUND_DISCREPANCY',
    domain: 'INVENTORY',
    name: '入仓差异',
    description: '已关闭货件存在未消除的少收、多收或不合规问题。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'inbound.discrepancy',
    params: { kinds: ['SHORT', 'OVER', 'NONCOMPLIANCE'] },
  },
  {
    code: 'FEE_SIZE_TIER_CHANGE',
    domain: 'FINANCE',
    name: '尺寸分段变化',
    description:
      '预估配送费报告里某个 SKU 的亚马逊测量尺寸分段与前一天不同（亚马逊重新测量后可能改变配送费与仓储费）；报告每天一份，所以最早在报告导入的当天提醒，之后在回看天数内保持提醒，随后自动恢复。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'fee.size-tier-change',
    params: { windowDays: 7 },
  },
  {
    code: 'FIN_SETTLEMENT_DISCREPANCY',
    domain: 'FINANCE',
    name: '结算差异',
    description: '结算单的三方核对（结算报告、财务接口交易、我方订单）结果是“有差异”，且差额的绝对值达到阈值；只看结算周期在回看天数以内的结算单。差异消除（重新对平）后自动恢复。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'settlement.discrepancy',
    params: { lookbackDays: 90, minDiffAmount: 1 },
  },
  {
    code: 'FIN_FEE_OVERCHARGE',
    domain: 'FINANCE',
    name: '费用多收',
    description:
      '费用核查页最新一次核查里，同一店铺同一类费用（配送费、佣金、仓储费、入仓配置费）疑似多收的合计金额达到阈值（按币种分别合计）；已转为赔付机会的不再提醒。容差与口径见费用核查页，是我们自定的，可能有误报。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'fee.overcharge',
    params: { minOverchargeAmount: 5, kinds: ['FULFILLMENT', 'COMMISSION', 'STORAGE', 'INBOUND_PLACEMENT'] },
  },
  {
    code: 'FIN_REIMBURSEMENT_DEADLINE',
    domain: 'FINANCE',
    name: '赔付机会即将到期',
    description:
      '赔付中心里仍是“待处理”（还没有生成案件、没有忽略）的机会，距申请期限不超过预警天数。到期后机会会被赔付扫描标为“已过期”，预警随之恢复。期限是按企业设置的默认值推算的，不是亚马逊逐案给出的。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'reimbursement.deadline',
    params: { warnDays: 30 },
  },
  {
    code: 'RET_RATE_ABNORMAL',
    domain: 'AFTER_SALES',
    name: '异常退货率',
    description:
      '同一店铺的某个 ASIN 在回看天数内，退货件数 ÷ 销售件数达到阈值，且退货件数与销售件数都不少于最小样本（样本太小的波动不算异常）。销售件数没有汇总的 ASIN 不判断。阈值是我们自定的默认值，不是行业标准，请按品类调整。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'returns.abnormal-rate',
    params: { windowDays: 30, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 30 },
  },
  {
    code: 'ADS_HIGH_SPEND_LOW_RETURN',
    domain: 'ADS',
    name: '广告高花费低产出',
    description:
      '同一个美元广告活动在回看天数内（到昨天为止，不含今天）花费与点击都达到下限，且广告销售额为 0（也没有订单），或广告成本销售比不低于阈值（默认 100%，即花的比卖的多）。没有销售额数据的活动不判断，不当作 0。广告转化有数天滞后，最近几天的销售额会补记，所以窗口不宜太短；阈值是我们自定的默认值，不是亚马逊口径，请按毛利调整。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'ads.high-spend-low-return',
    params: { windowDays: 7, minSpend: 50, minClicks: 20, acosThreshold: 1 },
  },
  {
    code: 'ADS_STOCKOUT_ADVERTISING',
    domain: 'ADS',
    name: '断货商品仍在投放',
    description:
      '被推广商品日报表里，近几天（含今天）仍有花费的 ASIN，在该店铺最近一次库存快照（接口来源）里可售数量为 0。库存快照是日级的、不是实时库存；快照早于“快照最长天数”的不判断。库存补进来、或广告不再花钱，预警随之恢复。',
    severity: 'WARNING',
    cooldownMinutes: DAY,
    type: 'ads.stockout-advertising',
    params: { lookbackDays: 3, minSpend: 5, maxSnapshotAgeDays: 3 },
  },
  {
    code: 'ADS_OUT_OF_BUDGET',
    domain: 'ADS',
    name: '广告超预算',
    description:
      '启用中的广告活动，活动管理接口同步到的投放状态带“预算用完”（OUT_OF_BUDGET）。营销数据流第二版不含预算消耗数据集，且小时数据接收端尚未建成（14.10），所以只看投放状态，随活动同步刷新，不是实时的，也算不出超预算时长。',
    severity: 'WARNING',
    cooldownMinutes: DAY,
    type: 'ads.out-of-budget',
    params: {},
  },
  {
    code: 'ADS_CPC_SURGE',
    domain: 'ADS',
    name: '单次点击成本突增',
    description:
      '同一个美元广告活动最近几天（到昨天为止）的单次点击成本，不低于它此前基线期成本的指定倍数，且最近与基线的点击都达到下限（样本太少的波动不算）。用的是日级汇总，小时数据流接收端建成之前不能做到日内实时（今日广告页的“今日异常”用的是小时数据）。倍数与下限是我们自定的默认值。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'ads.cpc-surge',
    params: { recentDays: 3, baselineDays: 14, ratio: 1.5, minClicks: 30, minBaselineClicks: 100 },
  },
  {
    code: 'PRD_LISTING_ISSUE_NEW',
    domain: 'PRODUCT',
    name: '刊登问题新增',
    description:
      '刊登质量页里某个 SKU 出现了新的、还没解决的刊登问题或合规问题（首次发现时间在回看天数以内），严重度在阈值范围内（默认只看“错误”）。已经被搜索抑制的问题归“被搜索抑制”预警，这里不重复。问题解决或超出回看天数后自动恢复；首次发现时间是同步发现的时间，不是亚马逊产生问题的时间。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'listing.issue-new',
    params: { windowDays: 3, severities: ['ERROR'], kinds: ['ISSUE', 'COMPLIANCE'] },
  },
  {
    code: 'PRD_SEARCH_SUPPRESSED',
    domain: 'PRODUCT',
    name: '被搜索抑制',
    description:
      '刊登质量页里某个 SKU 有还没解决的“搜索抑制”问题（被抑制报告里的商品，或问题的执法动作是搜索抑制）。被抑制的商品在搜索结果里基本不展示，通常直接影响销量；补齐亚马逊要求的信息后，同步发现问题消失，预警随之恢复。预警没有估算影响金额，销量影响看刊登质量页里的估算。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'listing.search-suppressed',
    params: {},
  },
  {
    code: 'PRD_CONTENT_CHANGED_BY_OTHERS',
    domain: 'PRODUCT',
    name: '详情页被他人修改',
    description:
      '刊登变更记录里，某个 SKU 的标题或主图在回看天数内被改动，且修改人是“他人”（推送带修改人且不是本店卖家编号）或“未知”（同步比对发现、本系统没有写入能解释；可能是你自己在卖家后台改的，所以会有误报，可在阈值里去掉“未知”）。窗口过后自动恢复。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'listing.content-changed-by-others',
    params: { windowDays: 3, actors: ['OTHER', 'UNKNOWN'] },
  },
  {
    code: 'PRD_FEATURED_OFFER_LOST',
    domain: 'PRODUCT',
    name: '失去推荐报价资格',
    description:
      '推荐报价（购物车）观察里，某个 ASIN 此前我方是推荐报价获得者，最近一次观察已不是，且这次失去发生在回看天数内；因价格失去资格的归“价格健康异常”预警。重新获得推荐报价后自动恢复。观察来自每 2 小时的同步，推送接收端暂缓（14.10），所以最晚有两小时延迟。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'pricing.featured-offer-lost',
    params: { lookbackDays: 7 },
  },
  {
    code: 'PRD_PRICE_HEALTH',
    domain: 'PRODUCT',
    name: '价格健康异常',
    description:
      '定价页的价格健康状态为“价格高于预期”（我方价格比推荐报价预期价格高出阈值比例，且我方没有获得推荐报价）或“因价格失去资格”（价格健康通知标明；推送暂缓，目前只有接入后才会出现）。价格与预期价格只看最近 3 天内的观察，币种不一致的不判断。阈值是我们自定的默认值。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'pricing.price-health',
    params: { states: ['ABOVE_EXPECTED', 'LOST_ELIGIBILITY'], minGapRatio: 0.03, lostLookbackDays: 7 },
  },
  {
    code: 'PRD_HIJACK_OFFER',
    domain: 'PRODUCT',
    name: '我方 Listing 出现其他报价方（跟卖）',
    description:
      '官方竞争摘要里，我方某个 SKU 所在 ASIN 上出现了其他报价方，且这个报价方在回看天数内才出现、仍在报价、不在跟卖白名单里。报价方消失、超过回看天数或加入白名单后自动恢复。数据只来自竞争摘要（不抓前台页面），同步每 2 小时一次，商品很多时按轮转更晚；摘要只保留价格最低的 30 个报价，排在其后的卖家看不到。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'pricing.hijack-offer',
    params: { lookbackDays: 7, minOffers: 1 },
  },
  {
    code: 'PRD_PROMO_STACKING',
    domain: 'PRODUCT',
    name: '促销叠加或折扣过深',
    description:
      '同一个 ASIN 在进行中或即将开始的促销里，同一时段叠加的促销数达到下限，或叠加后的折扣深度达到下限（逐层叠乘；百分比折扣直接用，立减金额与固定价按最近一次价格折算，算不出深度的只计数）。整个目录范围的促销没有商品清单，不计入。促销结束、取消或调整后自动恢复。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'promotions.stacking',
    params: { minStack: 2, minDepthPct: 0.3 },
  },
  {
    code: 'REV_NEGATIVE_TOPIC_RISING',
    domain: 'AFTER_SALES',
    name: '负面评论主题上升',
    description:
      '同一个 ASIN 最近一次评论主题快照与它此前最近一次相比：有负面主题新进入前 10、提及量区间的下限变大、或名次上升不少于阈值（提及量不到下限的不算）。只比较接口给的主题与区间文字，不估算评论条数，也不判断语义；两次快照都要在回看天数内。',
    severity: 'WARNING',
    cooldownMinutes: 7 * DAY,
    type: 'reviews.negative-topic-rising',
    params: { lookbackDays: 30, kinds: ['NEW', 'MENTIONS_UP', 'RANK_UP'], minRankRise: 3, minMentionLow: 10 },
  },
  {
    code: 'SYS_SYNC_FAILED',
    domain: 'SYSTEM',
    name: '数据同步失败',
    description: '某个店铺的某个数据来源最近一次同步以失败收场（授权失效另有“授权失效”预警；限流与上游暂时不可用只算延迟，不在此列）。',
    severity: 'WARNING',
    cooldownMinutes: 6 * 60,
    type: 'system.sync-failed',
    params: {},
  },
  {
    code: 'SYS_AUTH_EXPIRING',
    domain: 'SYSTEM',
    name: '亚马逊授权失效或即将失效',
    description:
      '同步被亚马逊以“授权已失效”拒绝，且之后没有重新授权。亚马逊没有公布固定的授权有效期，所以“即将失效”默认不按授权年龄推算；如需提前提醒，可在阈值里设置授权最长年龄（天）与提前提醒天数。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'system.auth-expiring',
    params: { tokenMaxAgeDays: null, warnBeforeDays: 30 },
  },
  {
    code: 'SYS_FX_FETCH_FAILED',
    domain: 'SYSTEM',
    name: '汇率获取失败',
    description:
      '企业设置的主汇率来源最近一次获取失败，且连续失败次数达到阈值；期间系统沿用历史汇率，金额折算可能与当天实际汇率有偏差。来源恢复（获取成功一次）后预警自动恢复；也可以到汇率设置里手工覆盖当天汇率。备用来源失败不单独提醒。',
    severity: 'WARNING',
    cooldownMinutes: DAY,
    type: 'system.fx-failed',
    params: { minFailures: 3 },
  },
  {
    code: 'SYS_WRITE_SWITCH_CLOSED',
    domain: 'SYSTEM',
    name: '写入开关被自动关闭',
    description:
      '企业级写入开关被系统自动关闭（写调用连续失败，或亚马逊返回授权失效、权限不足），且之后没有被人工重新开启。关闭期间对应的写入（入仓、刊登、改价、广告等）全部被拦下；到“接口与写入开关”检查连接并重新开启后，预警自动恢复。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'system.write-switch-closed',
    params: {},
  },
  {
    code: 'SYS_ACCOUNT_STATUS_CHANGED',
    domain: 'SYSTEM',
    name: '账户状态变化',
    description:
      '店铺的亚马逊账户状态变成“有风险”或“停用”（账户健康里按每日快照取变化点；之前没有记录的第一天不算变化）。状态恢复正常后预警自动恢复。账户状态推送的接收端尚未建成（14.10），目前状态来自每日的账户健康报告，最长会晚一天发现。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'account.status-changed',
    params: { lookbackDays: 7, statuses: ['AT_RISK', 'DEACTIVATED'] },
  },
  {
    code: 'SYS_ACCOUNT_HEALTH_DECLINE',
    domain: 'SYSTEM',
    name: '账户健康指标未达标',
    description:
      '店铺最近一份账户健康快照里，订单缺陷率、政策合规这类指标未达到报告自带的目标（报告没给目标的指标不判断，也不替报告定阈值）。一个店铺合并成一条预警，指标恢复达标后自动恢复；快照超过设定天数没有更新时不判断（同步异常另有同步失败预警）。',
    severity: 'WARNING',
    cooldownMinutes: 3 * DAY,
    type: 'account.health-decline',
    params: { maxAgeDays: 3, groups: ['ORDER_DEFECT', 'POLICY'] },
  },
  {
    code: 'SYS_PII_BULK_VIEW',
    domain: 'SYSTEM',
    name: '大量查看买家信息明文',
    description:
      '同一个人在统计时长内，查看买家信息明文（审计里“查看买家信息明文”且确实看到了内容的记录）的次数达到上限。同一个订单反复查看也每次计数；被拒绝与没有内容可看的不算。统计窗口滚动计算，窗口过后自动恢复。预警对象是查看的人，不是订单；详情在审计中心的“个人信息明文查看”视图。时长与次数是我们自定的默认值，请按客服工作量调整。',
    severity: 'CRITICAL',
    cooldownMinutes: DAY,
    type: 'audit.pii-bulk-view',
    params: { windowMinutes: 60, maxViews: 20 },
  },
]

export const alertRuleDefOf = (code: string) => ALERT_RULE_DEFS.find(item => item.code === code)

/** 评估器类型对应的预置规则定义（自定义规则按它找到说明与默认阈值）。 */
export const alertRuleDefOfType = (type: string) => ALERT_RULE_DEFS.find(item => item.type === type)

/** 本包没有接入的预警（09 章 9.1 的“实时断货”依赖小时库存推送，接收端按 14.10 暂缓）。 */
export const ALERT_REALTIME_STOCKOUT_NOTE = '实时断货预警依赖亚马逊小时库存推送，推送接收端尚未建成（部署专项暂缓，见 14.10），当前以库存健康的日级判断提醒断货风险。'

export interface AlertUnconnectedType {
  key: string
  domain: AlertRuleDomain
  name: string
  /** 为什么还没有接入、什么时候能接入（规则页的“尚未接入”清单显示） */
  reason: string
}

/** 09 章 9.1 表里列出、但依赖项尚未交付而没有评估器的预警类型：规则页显示“尚未接入”，不生成规则行（没有评估器的规则不会被评估，也就不会出现凭空的预警）。 */
export const ALERT_UNCONNECTED_TYPES: readonly AlertUnconnectedType[] = [{ key: 'INV_REALTIME_STOCKOUT', domain: 'INVENTORY', name: '实时断货', reason: ALERT_REALTIME_STOCKOUT_NOTE }]
