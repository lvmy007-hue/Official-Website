import { FRESHNESS_ERROR_LABEL } from './freshness'
import { spReportOf } from './report-center-catalog'

// 同步中心契约（P5-06，09 章 9.8）。不 import zod：前端要用这里的常量与纯函数，请求参数校验在带 zod 的 sync-center-query.ts。
// 约定：没有数据写“尚无记录”，同步器没有交付的数据域写“尚未接入”，不拿 0 冒充；失败原因一律给中文说明，失败码另外保留。

export const SYNC_READ = 'sync.read'
export const SYNC_MANAGE = 'sync.manage'
/** 队列任务的最大尝试次数（packages/workflow 的 MAX_ATTEMPTS）；人工重试会把尝试次数清零重新计。 */
export const SYNC_MAX_ATTEMPTS = 5
export const SYNC_TIMELINE_MAX = 40
export const SYNC_RESULT_MAX = 20

// ---- 数据域（09 章 9.8 的 18 个数据域，外加连接与系统任务）----

export const SYNC_DATA_DOMAINS = [
  'ORDERS',
  'INVENTORY',
  'FINANCE',
  'LISTINGS',
  'PRICING',
  'INBOUND',
  'AWD',
  'REPORTS',
  'BRAND',
  'FEEDBACK',
  'PROMOTIONS',
  'SUBSCRIBE_SAVE',
  'APLUS',
  'SUPPORT',
  'ACCOUNT_HEALTH',
  'ADS_ENTITIES',
  'ADS_REPORTS',
  'ADS_STREAM',
  'SYSTEM',
] as const
export type SyncDataDomain = (typeof SYNC_DATA_DOMAINS)[number]

export const SYNC_DOMAIN_LABEL: Readonly<Record<SyncDataDomain, string>> = {
  ORDERS: '订单',
  INVENTORY: '库存',
  FINANCE: '财务交易',
  LISTINGS: '商品与刊登',
  PRICING: '定价',
  INBOUND: '入仓',
  AWD: '上游仓储',
  REPORTS: '业务报告与数据中心',
  BRAND: '品牌分析',
  FEEDBACK: '客户反馈',
  PROMOTIONS: '促销',
  SUBSCRIBE_SAVE: '订阅省',
  APLUS: 'A+ 内容',
  SUPPORT: '支持案件',
  ACCOUNT_HEALTH: '账户健康',
  ADS_ENTITIES: '广告实体',
  ADS_REPORTS: '广告报表',
  ADS_STREAM: '营销数据流',
  SYSTEM: '连接与系统任务',
}

/** LIVE 同步器已交付；PARTIAL 只交付一部分；NOT_CONNECTED 同步器没有交付，页面写“尚未接入”。 */
export type SyncDomainAvailability = 'LIVE' | 'PARTIAL' | 'NOT_CONNECTED'

export const SYNC_DOMAIN_AVAILABILITY: Readonly<Record<SyncDataDomain, { availability: SyncDomainAvailability; note: string | null }>> = {
  ORDERS: { availability: 'LIVE', note: null },
  INVENTORY: { availability: 'LIVE', note: null },
  FINANCE: { availability: 'LIVE', note: null },
  LISTINGS: { availability: 'LIVE', note: null },
  PRICING: { availability: 'LIVE', note: '含竞品监控' },
  INBOUND: { availability: 'LIVE', note: null },
  AWD: { availability: 'LIVE', note: null },
  REPORTS: { availability: 'LIVE', note: '含亚马逊物流报告与数据中心查询' },
  BRAND: { availability: 'LIVE', note: '需要品牌备案与品牌分析角色' },
  FEEDBACK: { availability: 'LIVE', note: '含请求评价' },
  PROMOTIONS: { availability: 'LIVE', note: null },
  SUBSCRIBE_SAVE: { availability: 'LIVE', note: null },
  APLUS: { availability: 'LIVE', note: '需要品牌备案与 A+ 内容角色' },
  SUPPORT: { availability: 'LIVE', note: '需要“卖家支持”受限角色获批' },
  ACCOUNT_HEALTH: { availability: 'LIVE', note: null },
  ADS_ENTITIES: { availability: 'LIVE', note: '含广告账户档案、统一接口账户编号发现、广告对象落库（每 2 小时）与广告写入；统一接口的字段尚未对真实广告账户核对' },
  ADS_REPORTS: { availability: 'LIVE', note: '每天定时申请活动、广告组、投放对象、搜索词、广告商品、广告位、转化商品与小时报表；报表字段尚未对真实广告账户核对' },
  ADS_STREAM: { availability: 'NOT_CONNECTED', note: '营销数据流需要推送接收端（部署专项，14.10），接收端建成前没有同步任务' },
  SYSTEM: { availability: 'LIVE', note: '连接健康检查等不属于数据域的任务' },
}

// ---- 任务类型 ----

export const SYNC_JOB_TYPE_LABEL: Readonly<Record<string, string>> = {
  FBA_ORDERS: '订单同步',
  FBA_INVENTORY: '库存同步',
  FBA_FINANCE: '财务交易同步',
  FBA_INBOUND_SYNC: '入仓计划同步',
  FBA_INBOUND_CREATE: '创建入仓计划',
  FBA_INBOUND_OP: '入仓计划操作',
  FBA_REPLENISHMENT: '订阅省同步',
  AWD_SYNC: '上游仓储同步',
  AWD_ORDER_WRITE: '上游仓储入库订单',
  AWD_LABELS: '上游仓储货件标签',
  CATALOG_SYNC: '商品目录同步',
  LISTING_SYNC: '刊登问题与状态同步',
  LISTING_WRITE: '刊登与价格写入',
  PRICING_SYNC: '定价与购物车同步',
  PRICING_FEE_ESTIMATE: '费用预估',
  COMPETITOR_SYNC: '竞品监控同步',
  FEEDBACK_SYNC: '评论与退货主题同步',
  SOLICITATION_SEND: '请求评价',
  PROMOTIONS_SYNC: '促销与优惠券同步',
  APLUS_SYNC: 'A+ 内容同步',
  APLUS_WRITE: 'A+ 内容写入',
  SUPPORT_SYNC: '支持案件同步',
  SETTLEMENT_SYNC: '结算报告同步',
  TAX_SYNC: '销售税报告同步',
  FBA_REPORT_CREATE: '亚马逊报告申请',
  FBA_REPORT_POLL: '亚马逊报告轮询',
  DATA_KIOSK_QUERY: '数据中心查询',
  FBA_ADS: '广告账户档案同步',
  ADS_REPORT_CREATE: '广告报告申请（旧接口）',
  ADS_REPORT_POLL: '广告报告轮询（旧接口）',
  ADS_ENTITY_SYNC: '广告实体同步',
  ADS_REPORT_V1: '广告报告（新接口）',
  ADS_PARITY: '广告报告新旧核对',
  ADS_WRITE: '广告写入',
  CONNECTION_HEALTH_CHECK: '连接健康检查',
}
export const syncJobTypeLabel = (type: string) => SYNC_JOB_TYPE_LABEL[type] ?? type

/** 向亚马逊写入的任务类型：重试会重新提交一次写入，页面在确认框里提醒。 */
const WRITE_TYPES = new Set(['FBA_INBOUND_CREATE', 'FBA_INBOUND_OP', 'AWD_ORDER_WRITE', 'LISTING_WRITE', 'SOLICITATION_SEND', 'APLUS_WRITE', 'ADS_WRITE'])
export const isWriteSyncType = (type: string) => WRITE_TYPES.has(type)

const REPORT_JOB_TYPES = new Set(['FBA_REPORT_CREATE', 'FBA_REPORT_POLL'])
const ACCOUNT_HEALTH_REPORT = 'GET_V2_SELLER_PERFORMANCE_REPORT'
const BRAND_PREFIX = 'GET_BRAND_ANALYTICS'

/** 品牌分析、账户健康、财务三类报告按报告类型归域，其余报告归“业务报告与数据中心”。 */
export function syncReportDomainOf(reportType: string | null | undefined): SyncDataDomain {
  if (!reportType) return 'REPORTS'
  if (reportType === ACCOUNT_HEALTH_REPORT) return 'ACCOUNT_HEALTH'
  if (reportType.startsWith(BRAND_PREFIX)) return 'BRAND'
  return spReportOf(reportType)?.domain === 'FINANCE' ? 'FINANCE' : 'REPORTS'
}

/** 同步任务类型（与上下文里的报告类型）→ 数据域。认不出的类型归“连接与系统任务”，不丢任务。 */
export function syncDataDomainOf(type: string, context?: unknown): SyncDataDomain {
  if (REPORT_JOB_TYPES.has(type)) {
    const reportType = context && typeof context === 'object' ? (context as { reportType?: unknown }).reportType : undefined
    return syncReportDomainOf(typeof reportType === 'string' ? reportType : null)
  }
  switch (type) {
    case 'FBA_ORDERS':
      return 'ORDERS'
    case 'FBA_INVENTORY':
      return 'INVENTORY'
    case 'FBA_FINANCE':
    case 'SETTLEMENT_SYNC':
    case 'TAX_SYNC':
      return 'FINANCE'
    case 'CATALOG_SYNC':
    case 'LISTING_SYNC':
    case 'LISTING_WRITE':
      return 'LISTINGS'
    case 'PRICING_SYNC':
    case 'PRICING_FEE_ESTIMATE':
    case 'COMPETITOR_SYNC':
      return 'PRICING'
    case 'FBA_INBOUND_SYNC':
    case 'FBA_INBOUND_CREATE':
    case 'FBA_INBOUND_OP':
      return 'INBOUND'
    case 'AWD_SYNC':
    case 'AWD_ORDER_WRITE':
    case 'AWD_LABELS':
      return 'AWD'
    case 'DATA_KIOSK_QUERY':
      return 'REPORTS'
    case 'FEEDBACK_SYNC':
    case 'SOLICITATION_SEND':
      return 'FEEDBACK'
    case 'PROMOTIONS_SYNC':
      return 'PROMOTIONS'
    case 'FBA_REPLENISHMENT':
      return 'SUBSCRIBE_SAVE'
    case 'APLUS_SYNC':
    case 'APLUS_WRITE':
      return 'APLUS'
    case 'SUPPORT_SYNC':
      return 'SUPPORT'
    case 'FBA_ADS':
    case 'ADS_ENTITY_SYNC':
    case 'ADS_WRITE':
      return 'ADS_ENTITIES'
    case 'ADS_REPORT_CREATE':
    case 'ADS_REPORT_POLL':
    case 'ADS_REPORT_V1':
    case 'ADS_PARITY':
      return 'ADS_REPORTS'
    default:
      return 'SYSTEM'
  }
}

// ---- 任务状态 ----

export const SYNC_STATES = ['QUEUED', 'RETRY_WAIT', 'POLL_WAIT', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const
export type SyncState = (typeof SYNC_STATES)[number]
export const SYNC_STATE_LABEL: Readonly<Record<SyncState, string>> = {
  QUEUED: '排队中',
  RETRY_WAIT: '等待重试',
  POLL_WAIT: '等待亚马逊报告',
  RUNNING: '运行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
}
export const SYNC_STATE_COLOR: Readonly<Record<SyncState, string>> = { QUEUED: 'default', RETRY_WAIT: 'warning', POLL_WAIT: 'processing', RUNNING: 'processing', SUCCEEDED: 'success', FAILED: 'error' }
export const SYNC_STATE_HINT: Readonly<Record<SyncState, string>> = {
  QUEUED: '任务已入队，还没有开始执行',
  RETRY_WAIT: '上一次尝试失败，按退避时间自动重试，失败原因见任务详情',
  POLL_WAIT: '已向亚马逊申请报告，每 30 秒回来查询一次，生成后自动下载导入',
  RUNNING: '后台任务正在执行',
  SUCCEEDED: '任务已完成',
  FAILED: '重试用尽或遇到不可重试的错误，已进入失败任务（死信）',
}

/** 同步任务的状态 → 页面状态。PENDING 按尝试次数与失败码区分排队、等待重试、等待报告；人工重试会把尝试次数清零，所以重试后的任务回到“排队中”。 */
export function syncStateOf(job: { status: string; attempts: number; failureCode: string | null }): SyncState {
  if (job.status === 'RUNNING') return 'RUNNING'
  if (job.status === 'SUCCEEDED') return 'SUCCEEDED'
  if (job.status === 'PENDING') return job.failureCode ? 'RETRY_WAIT' : job.attempts > 0 ? 'POLL_WAIT' : 'QUEUED'
  return 'FAILED'
}

export const SYNC_PRIORITY_LABEL: Readonly<Record<number, string>> = { 1: '用户触发', 2: '推送增量', 3: '定时', 4: '历史回补' }
export const syncPriorityLabel = (priority: number) => SYNC_PRIORITY_LABEL[priority] ?? `优先级 ${priority}`

// ---- 失败原因 ----

const SYNC_FAILURE_LABEL: Readonly<Record<string, string>> = {
  CONNECTION_DISCONNECTED: '连接已在连接中心断开，排队的任务已作废',
  REPORT_CANCELLED: '报告任务已在报表中心取消',
  JOB_TENANT_MISMATCH: '任务与企业的归属校验未通过，已拒绝执行',
  WORKER_CRASHED: '后台任务进程中断，任务已转入失败；可以重试',
  QUEUE_UNAVAILABLE: '队列暂时不可用，任务没有入队；可以重试',
  RATE_LIMIT_WAIT_EXCEEDED: '店铺限速等待过久，已延后重试',
  SYNC_JOB_TYPE_UNKNOWN: '任务类型没有对应的处理流程',
  SELLER_ACCOUNT_NOT_BOUND: '连接没有绑定店铺',
  FBA_REPORT_FAILED: '亚马逊侧报告生成失败',
}
/** 失败码 → 中文说明；没有登记的失败码给出通用说明并保留失败码。 */
export const syncFailureText = (code: string | null | undefined): string | null => (code ? (SYNC_FAILURE_LABEL[code] ?? FRESHNESS_ERROR_LABEL[code] ?? `同步失败（${code}）`) : null)

/** 重试的前置条件：只有失败的任务可以重试；已作废的任务（连接已断开、报告已取消、归属校验未通过）重试没有意义。返回不能重试的原因，可以重试返回 null。 */
export function syncRetryBlockReason(job: { status: string; failureCode: string | null }): string | null {
  const state = syncStateOf({ status: job.status, attempts: 1, failureCode: job.failureCode })
  if (state !== 'FAILED') return '只有失败的任务可以重试；排队、运行和等待中的任务会自动继续'
  if (job.failureCode === 'CONNECTION_DISCONNECTED') return '连接已断开，请先在连接中心重新授权，再发起新的同步'
  if (job.failureCode === 'REPORT_CANCELLED') return '报告任务已在报表中心取消，请在报表中心重新创建'
  if (job.failureCode === 'JOB_TENANT_MISMATCH') return '任务的归属校验未通过，不能重试'
  return null
}
