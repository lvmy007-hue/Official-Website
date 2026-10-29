import type { ActionState } from './connection-center.js'

// 消息推送订阅页的契约（P5-05，09 章 9.7）。本文件不带 zod：前端页面与首屏路径可以直接取值。
// 订阅的创建、取消与事件重放由 P1-28 交付（`subscriptions.ts`，带 zod 的请求体校验）；这里只放页面要用的状态判定、动作可用性与响应类型。
// 接收端（消息队列或事件总线）属于部署专项（14.10）：未配置时正式显示“接收端未接入”，不创建订阅，并写明所需配置与受影响的页面。

export const SUBSCRIPTION_READ = 'connection.read'
export const SUBSCRIPTION_MANAGE = 'notifications.manage'
/** 部署专项创建接收端后，把它的编号配置到这个环境变量；订阅与后台任务都读它。 */
export const DESTINATION_ENV_KEY = 'AMAZON_NOTIFICATION_DESTINATION_ID'

export const SUBSCRIPTION_STATES = ['ACTIVE', 'PENDING', 'INVALID', 'NOT_SUBSCRIBED', 'STORE_NOT_AUTHORIZED', 'DESTINATION_MISSING'] as const
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]
export const SUBSCRIPTION_STATE_LABEL: Record<SubscriptionState, string> = {
  ACTIVE: '有效',
  PENDING: '处理中',
  INVALID: '已失效',
  NOT_SUBSCRIBED: '未订阅',
  STORE_NOT_AUTHORIZED: '店铺未授权',
  DESTINATION_MISSING: '接收端未接入',
}
export type SubscriptionTone = 'success' | 'warning' | 'error' | 'default'
export const SUBSCRIPTION_STATE_TONE: Record<SubscriptionState, SubscriptionTone> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  INVALID: 'error',
  NOT_SUBSCRIBED: 'default',
  STORE_NOT_AUTHORIZED: 'default',
  DESTINATION_MISSING: 'default',
}
export const SUBSCRIPTION_STATE_NOTE: Record<SubscriptionState, string> = {
  ACTIVE: '亚马逊已创建订阅，收到的事件会进入对应页面。',
  PENDING: '订阅记录已登记，等待后台任务在亚马逊创建（或按新的过滤条件重建）；长时间不变请检查店铺授权与接收端配置。',
  INVALID: '亚马逊拒绝了订阅请求（参数不对或没有权限）。请核对店铺授权与过滤条件后，取消订阅再重新订阅。',
  NOT_SUBSCRIBED: '还没有订阅；订阅后这类事件才会实时推送过来。',
  STORE_NOT_AUTHORIZED: '这个店铺没有有效的卖家接口授权，无法订阅；请先到连接中心授权。',
  DESTINATION_MISSING: '推送接收端尚未建成（部署专项）；现在订阅不会创建任何记录，相关页面退化为按补偿频率定时同步。',
}

/** 订阅一条通知所需的接收端配置说明；接收端未配置时在页面顶部逐条显示。 */
export const DESTINATION_SETUP_STEPS: readonly string[] = [
  '部署专项建成推送接收端（消息队列或事件总线），并在亚马逊卖家接口登记这个目的地。',
  `把目的地编号配置到服务端环境变量 ${DESTINATION_ENV_KEY}，重启接口服务与后台任务。`,
  '回到本页逐个店铺订阅需要的推送类型；创建由后台任务完成，完成后状态变为“有效”。',
]
export const DESTINATION_MISSING_FALLBACK = '接收端接入之前，近实时数据按补偿频率定时同步，只能看到日终或最近一次同步的数据，页面会如实标注，不会显示成 0。'

/** 过滤条件的聚合周期选项（取值与 `subscriptions.ts` 的 `AGGREGATION_PERIODS` 一致，契约测试核对）。 */
export const FILTER_AGGREGATION_OPTIONS = [
  { value: 'FiveMinutes', label: '5 分钟' },
  { value: 'TenMinutes', label: '10 分钟' },
] as const
export const aggregationLabel = (value: string | undefined) => FILTER_AGGREGATION_OPTIONS.find(item => item.value === value)?.label ?? value ?? ''

export interface SubscriptionFilterView {
  marketplaceIds?: string[]
  aggregationTimePeriod?: string
}

/** 一行订阅（店铺 × 推送类型）的状态：已有记录按记录，没有记录按前置条件。 */
export function subscriptionStateOf(input: { rowStatus: string | null; destinationConfigured: boolean; storeAuthorized: boolean; grantless: boolean }): SubscriptionState {
  const { rowStatus } = input
  if (rowStatus === 'ACTIVE') return 'ACTIVE'
  if (rowStatus === 'INVALID') return 'INVALID'
  if (!input.destinationConfigured) return 'DESTINATION_MISSING'
  if (rowStatus) return 'PENDING'
  if (!input.grantless && !input.storeAuthorized) return 'STORE_NOT_AUTHORIZED'
  return 'NOT_SUBSCRIBED'
}

export interface SubscriptionActions {
  subscribe: ActionState
  editFilter: ActionState
  unsubscribe: ActionState
  replay: ActionState
}

const yes: ActionState = { allowed: true, reason: null }
const no = (reason: string): ActionState => ({ allowed: false, reason })

/** 一行订阅可做的动作与不能做的原因；服务端用它给出权威结果，前端只负责把原因讲清楚。 */
export function subscriptionActionsOf(input: {
  hasRow: boolean
  state: SubscriptionState
  canManage: boolean
  destinationConfigured: boolean
  filterable: boolean
  failures24h: number
}): SubscriptionActions {
  const denied = input.canManage ? null : '需要“消息推送订阅管理”权限'
  const subscribe = (() => {
    if (denied) return no(denied)
    if (input.hasRow) return no('已经订阅，不能重复订阅')
    if (!input.destinationConfigured) return no('推送接收端尚未接入（部署专项），暂时不能订阅')
    if (input.state === 'STORE_NOT_AUTHORIZED') return no('这个店铺没有有效的卖家接口授权，请先到连接中心授权')
    return yes
  })()
  const editFilter = (() => {
    if (denied) return no(denied)
    if (!input.hasRow) return no('还没有订阅')
    if (!input.filterable) return no('这类推送不支持过滤条件')
    if (!input.destinationConfigured) return no('推送接收端尚未接入（部署专项），暂时不能修改')
    return yes
  })()
  const unsubscribe = denied ? no(denied) : input.hasRow ? yes : no('还没有订阅')
  const replay = (() => {
    if (denied) return no(denied)
    if (!input.hasRow) return no('还没有订阅')
    if (input.failures24h <= 0) return no('近 24 小时没有失败事件')
    return yes
  })()
  return { subscribe, editFilter, unsubscribe, replay }
}

export interface SubscriptionItem {
  /** 订阅记录编号；还没订阅时为空 */
  id: string | null
  sellerAccountId: string
  storeName: string
  notificationType: string
  label: string
  pages: string[]
  state: SubscriptionState
  filter: SubscriptionFilterView | null
  /** 这一行订阅使用的接收端（只显示末 4 位）；没有订阅记录时为空 */
  destinationHint: string | null
  lastReceivedAt: string | null
  events24h: number
  failures24h: number
  version: number | null
  filterable: boolean
  actions: SubscriptionActions
}

export interface SubscriptionStoreOption {
  id: string
  displayName: string
  /** 是否有已授权的卖家接口连接 */
  authorized: boolean
}

export interface AffectedPage {
  page: string
  /** 这个页面依赖的推送类型（中文名） */
  types: string[]
}

/** 今日广告依赖的是营销数据流（第二版），不是卖家接口推送，本页不管理它；接收端没接入期间同样退化，所以一并标出（14.10）。 */
export const MARKETING_STREAM_AFFECTED: AffectedPage = { page: '今日广告', types: ['营销数据流（部署专项另行接入，本页不管理）'] }

export interface SubscriptionCenterSummary {
  rows: number
  active: number
  pending: number
  invalid: number
  events24h: number
  failures24h: number
}

export interface SubscriptionCenterResponse {
  destination: {
    configured: boolean
    /** 接收端编号末 4 位 */
    hint: string | null
    envKey: string
    setupSteps: string[]
    fallbackNote: string
  }
  canManage: boolean
  /** 接收端未配置时，因此退化的页面；已配置时为空 */
  affectedPages: AffectedPage[]
  stores: SubscriptionStoreOption[]
  items: SubscriptionItem[]
  summary: SubscriptionCenterSummary
  /** 店铺超过上限时只列出前面的店铺 */
  truncated: boolean
}

export const SUBSCRIPTION_STORE_LIMIT = 200

/** 统计摘要：只数有订阅记录的行；失败数与事件数是近 24 小时。 */
export function summarizeSubscriptions(items: readonly Pick<SubscriptionItem, 'id' | 'state' | 'events24h' | 'failures24h'>[]): SubscriptionCenterSummary {
  const summary: SubscriptionCenterSummary = { rows: 0, active: 0, pending: 0, invalid: 0, events24h: 0, failures24h: 0 }
  for (const item of items) {
    summary.events24h += item.events24h
    summary.failures24h += item.failures24h
    if (!item.id) continue
    summary.rows += 1
    if (item.state === 'ACTIVE') summary.active += 1
    else if (item.state === 'INVALID') summary.invalid += 1
    else summary.pending += 1
  }
  return summary
}

/** 接收端未接入时，按页面归并“哪些页面因此退化”；页面顺序按首次出现的顺序。 */
export function affectedPagesOf(types: readonly { label: string; pages: readonly string[] }[]): AffectedPage[] {
  const byPage = new Map<string, string[]>()
  for (const type of types) {
    for (const page of type.pages) {
      const list = byPage.get(page) ?? []
      list.push(type.label)
      byPage.set(page, list)
    }
  }
  return [...byPage.entries()].map(([page, labels]) => ({ page, types: labels }))
}
