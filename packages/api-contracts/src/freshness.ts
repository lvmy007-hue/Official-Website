// 数据新鲜度契约（P1-28-12，freeze/importers.md 0.3、0.4；指标 M-011、M-620）。
// 每个数据来源有唯一 sourceKey，同步器在 DataFreshness 里按（企业、店铺、来源）记一行；接口按范围聚合后返回给页面。
// 没有任何记录的来源如实显示“尚无记录”，不编造时间；推送类来源接收端未配置期间为“未接入”（14.10）。

export const FRESHNESS_STATUSES = ['NORMAL', 'DELAYED', 'FAILED', 'UNAUTHORIZED', 'NOT_APPLICABLE', 'NOT_CONNECTED', 'WAITING_DEPENDENCY'] as const
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number]
/** 聚合后多出一种：范围内的店铺还没有任何同步记录 */
export type FreshnessViewStatus = FreshnessStatus | 'NO_RECORD'
export const FRESHNESS_STATUS_LABEL: Record<FreshnessViewStatus, string> = {
  NORMAL: '正常',
  DELAYED: '延迟',
  FAILED: '失败',
  UNAUTHORIZED: '未授权',
  NOT_APPLICABLE: '不适用',
  NOT_CONNECTED: '未接入',
  WAITING_DEPENDENCY: '等待依赖',
  NO_RECORD: '尚无记录',
}

/** 数据超过“同步频率 × 该倍数”没有覆盖到新数据，就算延迟（M-011 的“按时”口径） */
export const FRESHNESS_DELAY_FACTOR = 2

export interface FreshnessSourceSpec {
  key: string
  label: string
  /** 同步域（SyncJob.domain），同步器按它找到来源键 */
  domain?: string
  /** 期望的同步间隔（分钟）：用于判断延迟 */
  intervalMinutes: number
}

/** 来源目录：各数据域工作包落地同步器时追加；目录里没有的来源键不会出现在页面上。 */
export const FRESHNESS_SOURCES: readonly FreshnessSourceSpec[] = [
  { key: 'orders.api', label: '订单', domain: 'orders', intervalMinutes: 15 },
  { key: 'finance.transactions', label: '财务交易', domain: 'finance', intervalMinutes: 24 * 60 },
  { key: 'inventory.api', label: '库存', domain: 'inventory', intervalMinutes: 30 },
  { key: 'inbound.plan', label: '入仓计划', domain: 'inbound', intervalMinutes: 30 },
]
export const freshnessSourceOfDomain = (domain: string | null | undefined) => FRESHNESS_SOURCES.find(item => item.domain === domain)

/**
 * 库存与费用类报告的新鲜度来源（P2a-05，importers.md R-08 至 R-22）：报告类型 → 来源键与同步间隔。
 * 不并入 FRESHNESS_SOURCES：经营控制台的“数据源健康”总表保持精简（与小时推送的做法一致，见 CR-026）；
 * 库存健康、台账、仓储费用等页面按需用 aggregateFreshness(rows, storeIds, now, REPORT_FRESHNESS_SOURCES) 展示。
 */
export const REPORT_FRESHNESS_SOURCES: readonly (FreshnessSourceSpec & { reportType: string })[] = [
  { reportType: 'GET_FBA_INVENTORY_PLANNING_DATA', key: 'rpt.inventory-planning', label: '库存规划报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', key: 'rpt.myi-unsuppressed', label: '库存报告（未抑制）', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_MYI_ALL_INVENTORY_DATA', key: 'rpt.myi-all', label: '库存报告（全部）', intervalMinutes: 24 * 60 },
  { reportType: 'GET_AFN_INVENTORY_DATA', key: 'rpt.afn-inventory', label: '亚马逊物流库存报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_RESERVED_INVENTORY_DATA', key: 'rpt.reserved-inventory', label: '预留库存报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_STRANDED_INVENTORY_UI_DATA', key: 'rpt.stranded-inventory', label: '滞留库存报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT', key: 'rpt.restock-recommendations', label: '官方补货建议', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_RECOMMENDED_REMOVAL_DATA', key: 'rpt.recommended-removal', label: '推荐移除报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_LEDGER_DETAIL_VIEW_DATA', key: 'rpt.ledger-detail', label: '库存台账明细', intervalMinutes: 24 * 60 },
  { reportType: 'GET_LEDGER_SUMMARY_VIEW_DATA', key: 'rpt.ledger-summary', label: '库存台账汇总', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA', key: 'rpt.removal-order', label: '移除订单明细', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA', key: 'rpt.removal-shipment', label: '移除货件明细', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_STORAGE_FEE_CHARGES_DATA', key: 'rpt.storage-fee', label: '月度仓储费', intervalMinutes: 31 * 24 * 60 },
  { reportType: 'GET_FBA_OVERAGE_FEE_CHARGES_DATA', key: 'rpt.overage-fee', label: '超限费', intervalMinutes: 31 * 24 * 60 },
  { reportType: 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA', key: 'rpt.longterm-storage-fee', label: '长期仓储费', intervalMinutes: 31 * 24 * 60 },
  { reportType: 'GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA', key: 'rpt.inbound-noncompliance', label: '入仓不合规报告', intervalMinutes: 24 * 60 },
  // P2b-01（订单页）：包裹与替换关联
  { reportType: 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', key: 'rpt.fulfilled-shipments', label: '亚马逊物流发货报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA', key: 'rpt.shipment-replacement', label: '替换订单报告', intervalMinutes: 24 * 60 },
  // P2b-02（退货页）：客户退货报告
  { reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', key: 'rpt.customer-returns', label: '客户退货报告', intervalMinutes: 24 * 60 },
  // P2b-03（赔付中心，CR-002）：官方赔付明细
  { reportType: 'GET_FBA_REIMBURSEMENTS_DATA', key: 'rpt.reimbursements', label: '官方赔付明细报告', intervalMinutes: 24 * 60 },
  // P2b-06（费用核查）：预估配送费与佣金预览，费用核查的基准
  { reportType: 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA', key: 'rpt.estimated-fba-fees', label: '预估配送费报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_REFERRAL_FEE_PREVIEW_REPORT', key: 'rpt.referral-fee-preview', label: '佣金预览报告', intervalMinutes: 24 * 60 },
  // P4-01（销售与流量）：数据中心的补充来源，每日申请前一天
  { reportType: 'GET_SALES_AND_TRAFFIC_REPORT', key: 'rpt.sales-traffic', label: '销售与流量报告（补充）', intervalMinutes: 24 * 60 },
  // P4-04（品牌分析，需要品牌备案与品牌分析角色）：五份报告按周与按月申请，来源键与展示名见 brand-analytics.ts 的 BA_REPORT_DEFS
  { reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', key: 'rpt.ba.search-query', label: '品牌分析·搜索查询表现', intervalMinutes: 7 * 24 * 60 },
  { reportType: 'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT', key: 'rpt.ba.search-catalog', label: '品牌分析·目录表现', intervalMinutes: 7 * 24 * 60 },
  { reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', key: 'rpt.ba.search-terms', label: '品牌分析·热门搜索词', intervalMinutes: 7 * 24 * 60 },
  { reportType: 'GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT', key: 'rpt.ba.market-basket', label: '品牌分析·购物篮分析', intervalMinutes: 7 * 24 * 60 },
  { reportType: 'GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT', key: 'rpt.ba.repeat-purchase', label: '品牌分析·重复购买', intervalMinutes: 7 * 24 * 60 },
  // P4-05（促销与优惠券）：促销绩效与优惠券绩效，每日申请最近窗口；列名依据文档整理、尚未用真实报告核对（CR-080）
  { reportType: 'GET_PROMOTION_PERFORMANCE_REPORT', key: 'rpt.promotion-performance', label: '促销绩效报告', intervalMinutes: 24 * 60 },
  { reportType: 'GET_COUPON_PERFORMANCE_REPORT', key: 'rpt.coupon-performance', label: '优惠券绩效报告', intervalMinutes: 24 * 60 },
  // P4-10（刊登质量与合规）：被搜索抑制的商品，每日申请；列名依据文档整理、尚未用真实报告核对（CR-085）
  { reportType: 'GET_MERCHANTS_LISTINGS_FYP_REPORT', key: 'rpt.listings-fyp', label: '被搜索抑制报告', intervalMinutes: 24 * 60 },
  // P5-02（账户健康）：卖家表现报告，每日申请；字段依据文档整理、尚未用真实报告核对（CR-092）
  { reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT', key: 'rpt.seller-performance', label: '卖家表现报告（账户健康）', intervalMinutes: 24 * 60 },
]
/**
 * 按同步任务类型登记的来源（P2a-07）：任务类型与数据域不是一一对应时使用（订阅省与库存同走库存队列，但新鲜度单独记）。
 * 同样不并入 FRESHNESS_SOURCES，保持“数据源健康”总表精简。
 */
export const JOB_FRESHNESS_SOURCES: readonly (FreshnessSourceSpec & { jobType: string })[] = [
  { jobType: 'FBA_REPLENISHMENT', key: 'replenishment.api', label: '订阅省（补货）', intervalMinutes: 24 * 60 },
  // P2a-08：上游仓储（AWD）库存与入库货件，每 2 小时；写入类任务（AWD_ORDER_WRITE）不登记新鲜度
  { jobType: 'AWD_SYNC', key: 'awd.api', label: '上游仓储（AWD）', intervalMinutes: 120 },
  // P2a-14：商品目录（图片、品牌、类目、父体、销售排名），每日全量
  { jobType: 'CATALOG_SYNC', key: 'catalog.items-v2022', label: '商品目录', intervalMinutes: 24 * 60 },
  // P2b-04：亚马逊支持案件与沟通记录（只读），每 2 小时
  { jobType: 'SUPPORT_SYNC', key: 'support.api', label: '支持案件', intervalMinutes: 120 },
  // P4-05：亚马逊促销与优惠券（只读，接口限速每 10 秒 1 次，每日同步一次）
  { jobType: 'PROMOTIONS_SYNC', key: 'promotions.api', label: '促销与优惠券', intervalMinutes: 24 * 60 },
  // P4-10：刊登接口（问题项、刊登状态、商品类型、标题与主图），每日全量；写入类任务（LISTING_WRITE）不登记新鲜度
  { jobType: 'LISTING_SYNC', key: 'listings.items-v2021', label: '刊登问题与状态', intervalMinutes: 24 * 60 },
  // P4-11：定价接口（我方报价、推荐报价预期价格、竞争摘要），每 2 小时；改价写入沿用刊登写入任务（LISTING_WRITE），不登记新鲜度
  { jobType: 'PRICING_SYNC', key: 'pricing.api', label: '定价与购物车', intervalMinutes: 120 },
  // P4-12：竞品监控（对关注的竞品 ASIN 调用商品目录与竞争摘要接口），每 6 小时；没有关注任何竞品时任务直接跳过，新鲜度显示“不适用”
  { jobType: 'COMPETITOR_SYNC', key: 'competitors.api', label: '竞品监控', intervalMinutes: 360 },
  // P4-13：客户反馈接口（商品评论主题、类目评论与退货主题趋势），每日一次、每次轮转处理一批商品；请求评价（SOLICITATION_SEND）是写入任务，不登记新鲜度
  { jobType: 'FEEDBACK_SYNC', key: 'feedback.api', label: '评论与退货主题', intervalMinutes: 24 * 60 },
  // P4-14：A+ 内容接口（内容列表、审核状态、关联 ASIN、发布记录），每日一次；写入类任务（APLUS_WRITE）不登记新鲜度
  { jobType: 'APLUS_SYNC', key: 'aplus.api', label: 'A+ 内容', intervalMinutes: 24 * 60 },
  // P5-12A：广告实体（统一接口的活动、广告组、投放对象等，每 2 小时）与定时广告报表（每天一次，只记定时任务，用户手动申请的报告不记）；
  // 记在广告档案绑定的店铺名下，没有绑定店铺的档案不记录
  { jobType: 'ADS_ENTITY_SYNC', key: 'ads.entities-v1', label: '广告实体', intervalMinutes: 120 },
  { jobType: 'ADS_REPORT_V1', key: 'ads.reports-v1', label: '广告报表', intervalMinutes: 24 * 60 },
  // P2b-07：结算报告（亚马逊按结算周期生成，同步任务每日检索一次），页面据此显示结算数据的新鲜度
  { jobType: 'SETTLEMENT_SYNC', key: 'rpt.settlement', label: '结算报告', intervalMinutes: 24 * 60 },
  // P2b-12：销售税报告（卖家后台税务文档库生成后检索，不能主动申请），同步任务每日检索一次
  { jobType: 'TAX_SYNC', key: 'rpt.sales-tax', label: '销售税报告', intervalMinutes: 24 * 60 },
]
export const freshnessSourceOfJobType = (jobType: string | null | undefined) => JOB_FRESHNESS_SOURCES.find(item => item.jobType === jobType)
/**
 * 按数据中心数据集登记的来源（P2b-11）：任务类型都是 DATA_KIOSK_QUERY，靠任务上下文里的 `dataset` 区分是哪个数据集。
 * 同样不并入 FRESHNESS_SOURCES。情景模拟（dk.economics-simulation）是按需的一次性查询，不登记新鲜度。
 */
export const DATASET_FRESHNESS_SOURCES: readonly (FreshnessSourceSpec & { dataset: string })[] = [
  { dataset: 'dk.economics', key: 'dk.economics', label: '官方单品经济', intervalMinutes: 24 * 60 },
  { dataset: 'dk.economics-preview', key: 'dk.economics.preview', label: '官方费用预览', intervalMinutes: 24 * 60 },
  // P4-01：销售与流量（数据中心，需品牌分析角色），每日；三个数据集各记各的
  { dataset: 'dk.sales-traffic-by-date', key: 'dk.sales-traffic.date', label: '销售与流量（按日期）', intervalMinutes: 24 * 60 },
  { dataset: 'dk.sales-traffic-by-asin', key: 'dk.sales-traffic.asin', label: '销售与流量（按 ASIN）', intervalMinutes: 24 * 60 },
  { dataset: 'dk.sales-traffic-trends', key: 'dk.sales-traffic.trends', label: '销售与流量（ASIN 趋势）', intervalMinutes: 24 * 60 },
]
export const freshnessSourceOfDataset = (dataset: string | null | undefined) => DATASET_FRESHNESS_SOURCES.find(item => item.dataset === dataset)
export const freshnessSourceOfReport = (reportType: string | null | undefined) => REPORT_FRESHNESS_SOURCES.find(item => item.reportType === reportType)

/** 通用失败码的中文说明（freeze/importers.md 0.3）；未登记的失败码显示“同步失败，请稍后重试或查看同步中心” */
export const FRESHNESS_ERROR_LABEL: Record<string, string> = {
  AUTH_EXPIRED: '亚马逊授权已失效，请重新授权',
  ROLE_MISSING: '缺少该数据所需的亚马逊角色，请在亚马逊后台为应用授权',
  THROTTLE_EXHAUSTED: '亚马逊限流，稍后会自动重试',
  UPSTREAM_ERROR: '亚马逊服务暂时不可用，稍后会自动重试',
  REPORT_FATAL: '亚马逊报告生成失败',
  REPORT_CANCELLED: '亚马逊报告被取消',
  REPORT_TIMEOUT: '亚马逊报告生成超时',
  PARSE_HEADER: '亚马逊报告格式发生变化，已保留原始文件，请联系管理员',
  DEPENDENCY_MISSING: '依赖的数据还没有同步完成',
  SCOPE_UNAVAILABLE: '该店铺不具备此数据的前提条件',
  RETENTION_GAP: '部分历史数据超过亚马逊保留期，无法获取',
  TENANT_NOT_ACTIVE: '企业当前不在服务状态，同步已暂停',
  SUP_ROLE_PENDING: '亚马逊“卖家支持”受限角色尚未获批，支持案件暂时无法同步；案件编号仍可在赔付案件里手工回填',
  TAX_NOT_GENERATED: '销售税报告尚未生成：需在卖家后台“税务文档库”先生成报告，生成后会自动检索',
  TAX_ROLE_PENDING: '亚马逊“税务汇缴”受限角色尚未获批，销售税报告暂时无法获取；订单接口的税额不受影响',
  DK_NO_BRAND: '销售与流量需要“品牌分析”角色（店铺需有品牌备案并在亚马逊后台授权），暂时无法同步；会话与流量相关指标显示“尚未接入”，订单与销售额不受影响',
  BA_NO_BRAND: '品牌分析需要品牌备案并获批“品牌分析”角色，这家店暂时没有品牌分析数据；品牌分析各页写明前提，不显示示例数字',
  BA_PERIOD_INVALID: '品牌分析报告的时间范围必须是完整的一周（周日至周六）、一个自然月或一个自然季度',
  FBK_NO_BRAND_ACCESS: '评论主题需要品牌备案并获批“品牌分析”角色，这家店暂时没有评论与退货主题；评分概况（文件导入）与请求评价不受影响',
  ADS_ACCOUNT_MISSING: '这个广告档案还没有发现统一接口的广告账户编号，广告实体与新报告接口暂时无法同步；账户编号随广告档案同步自动发现，也可能该档案在统一接口里查不到',
  APL_ROLE_MISSING: 'A+ 内容需要品牌备案并获批“品牌内容”（A+ 内容管理）角色，这家店暂时无法同步 A+ 内容；其他数据不受影响，不显示示例数据',
  FEES_ROLE_PENDING: '费用预估需要获批“定价”或“商品刊登”角色，这家店暂时无法调用费用预估接口；新品试算会改用公开费率表并写明原因',
}
export const freshnessErrorMessage = (code: string | null | undefined) => (code ? (FRESHNESS_ERROR_LABEL[code] ?? '同步失败，请稍后重试或查看同步中心') : null)

/** 失败码 → 记录的状态：授权类→未授权；前提不满足→不适用；依赖→等待依赖；限流与上游错误→延迟；其余→失败 */
export function freshnessStatusForFailure(code: string): FreshnessStatus {
  if (
    code === 'AUTH_EXPIRED' ||
    code === 'ROLE_MISSING' ||
    code === 'SUP_ROLE_PENDING' ||
    code === 'TAX_ROLE_PENDING' ||
    code === 'DK_NO_BRAND' ||
    code === 'FBK_NO_BRAND_ACCESS' ||
    code === 'APL_ROLE_MISSING' ||
    code === 'FEES_ROLE_PENDING'
  )
    return 'UNAUTHORIZED'
  // 品牌分析没有品牌备案（importers.md R-35 至 R-39）：这家店没有这类数据，是“不适用”，不是同步故障
  if (code === 'SCOPE_UNAVAILABLE' || code === 'BA_NO_BRAND') return 'NOT_APPLICABLE'
  // 销售税报告还没在卖家后台生成：等卖家操作，算“等待依赖”，不是同步故障（不触发同步失败预警）
  // 广告档案还没发现统一接口账户编号：等账户发现，不是同步故障
  if (code === 'DEPENDENCY_MISSING' || code === 'TAX_NOT_GENERATED' || code === 'ADS_ACCOUNT_MISSING') return 'WAITING_DEPENDENCY'
  if (code === 'THROTTLE_EXHAUSTED' || code === 'UPSTREAM_ERROR') return 'DELAYED'
  return 'FAILED'
}

export interface FreshnessRow {
  sellerAccountId: string | null
  sourceKey: string
  lastAttemptAt: Date
  lastSuccessAt: Date | null
  dataThrough: Date | null
  status: string
  lastErrorCode: string | null
}

/** 单行的有效状态：记录为正常但数据覆盖时间已落后太多，按“延迟”处理 */
export function effectiveFreshnessStatus(row: Pick<FreshnessRow, 'status' | 'dataThrough' | 'lastSuccessAt'>, intervalMinutes: number, now: Date): FreshnessStatus {
  const status = (FRESHNESS_STATUSES as readonly string[]).includes(row.status) ? (row.status as FreshnessStatus) : 'FAILED'
  if (status !== 'NORMAL') return status
  const covered = row.dataThrough ?? row.lastSuccessAt
  if (!covered) return 'DELAYED'
  return now.getTime() - covered.getTime() > intervalMinutes * FRESHNESS_DELAY_FACTOR * 60_000 ? 'DELAYED' : 'NORMAL'
}

// 越靠前越需要关注：一个来源下有多个店铺时取最差的状态
const ATTENTION: readonly FreshnessViewStatus[] = ['FAILED', 'UNAUTHORIZED', 'DELAYED', 'WAITING_DEPENDENCY', 'NO_RECORD', 'NORMAL', 'NOT_CONNECTED', 'NOT_APPLICABLE']
const rank = (status: FreshnessViewStatus) => ATTENTION.indexOf(status)

export interface FreshnessSourceView {
  sourceKey: string
  label: string
  intervalMinutes: number
  status: FreshnessViewStatus
  statusLabel: string
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  /** 范围内各店铺数据覆盖时间里最早的一个（最差情况） */
  dataThrough: Date | null
  /** 当前时间 − 数据覆盖时间（M-620，分钟）；没有覆盖时间为 null */
  lagMinutes: number | null
  coverage: { total: number; fresh: number }
  errorCode: string | null
  errorMessage: string | null
}

/** 把范围内店铺的同步记录聚合成各来源的新鲜度（storeIds 是范围内全部店铺编号；不适用的店铺不计入覆盖）。 */
export function aggregateFreshness(rows: readonly FreshnessRow[], storeIds: readonly string[], now: Date, sources: readonly FreshnessSourceSpec[] = FRESHNESS_SOURCES) {
  const views = sources.map((spec): FreshnessSourceView => {
    const perStore = storeIds.map(storeId => {
      const row = rows.find(item => item.sourceKey === spec.key && item.sellerAccountId === storeId)
      return { row, status: (row ? effectiveFreshnessStatus(row, spec.intervalMinutes, now) : 'NO_RECORD') as FreshnessViewStatus }
    })
    const counted = perStore.filter(item => item.status !== 'NOT_APPLICABLE')
    const worst = counted.reduce<(typeof perStore)[number] | null>((current, item) => (!current || rank(item.status) < rank(current.status) ? item : current), null)
    const times = (pick: (row: FreshnessRow) => Date | null) => counted.flatMap(item => (item.row && pick(item.row) ? [pick(item.row) as Date] : []))
    const through = times(row => row.dataThrough ?? row.lastSuccessAt)
    const dataThrough = through.length > 0 && through.length === counted.length ? new Date(Math.min(...through.map(time => time.getTime()))) : null
    const status: FreshnessViewStatus = counted.length === 0 ? (perStore.length === 0 ? 'NO_RECORD' : 'NOT_APPLICABLE') : (worst?.status ?? 'NO_RECORD')
    const successes = times(row => row.lastSuccessAt)
    const attempts = times(row => row.lastAttemptAt)
    const errorCode = worst?.row?.lastErrorCode && status !== 'NORMAL' ? worst.row.lastErrorCode : null
    return {
      sourceKey: spec.key,
      label: spec.label,
      intervalMinutes: spec.intervalMinutes,
      status,
      statusLabel: FRESHNESS_STATUS_LABEL[status],
      lastAttemptAt: attempts.length ? new Date(Math.max(...attempts.map(time => time.getTime()))) : null,
      lastSuccessAt: successes.length ? new Date(Math.max(...successes.map(time => time.getTime()))) : null,
      dataThrough,
      lagMinutes: dataThrough ? Math.max(0, Math.round((now.getTime() - dataThrough.getTime()) / 60_000)) : null,
      coverage: { total: counted.length, fresh: counted.filter(item => item.status === 'NORMAL').length },
      errorCode,
      errorMessage: freshnessErrorMessage(errorCode),
    }
  })
  // M-011 数据完整度：按时同步成功的来源数 ÷ 应同步的来源数；未接入、不适用的不计入分母
  const due = views.filter(view => view.status !== 'NOT_APPLICABLE' && view.status !== 'NOT_CONNECTED')
  return {
    sources: views,
    summary: {
      completeness: due.length === 0 ? null : due.filter(view => view.status === 'NORMAL').length / due.length,
      attention: views.filter(view => !['NORMAL', 'NOT_APPLICABLE', 'NOT_CONNECTED'].includes(view.status)).length,
    },
  }
}
