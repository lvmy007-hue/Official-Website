import {
  DESTINATION_ENV_KEY,
  DESTINATION_MISSING_FALLBACK,
  DESTINATION_SETUP_STEPS,
  MARKETING_STREAM_AFFECTED,
  affectedPagesOf,
  subscriptionActionsOf,
  subscriptionStateOf,
  summarizeSubscriptions,
  type SubscriptionCenterResponse,
  type SubscriptionFilterView,
  type SubscriptionItem,
} from '@nova/api-contracts'

// 消息推送订阅页测试用的接口返回样例（只在测试里使用）：状态与动作可用性用契约里的同一批纯函数生成，页面与服务端不会各说各话。

export const STORE_A = { id: 's1', displayName: '美国主店', authorized: true }
export const STORE_B = { id: 's2', displayName: '美国二店', authorized: false }

const TYPES: Record<string, { label: string; pages: string[]; filterable?: boolean; grantless?: boolean }> = {
  ORDER_CHANGE: { label: '订单变化', pages: ['订单', '今日实时'] },
  ANY_OFFER_CHANGED: { label: '报价变化', pages: ['定价与购物车', '竞品监控'], filterable: true },
  TRANSACTION_UPDATE: { label: '财务交易更新', pages: ['结算交易'] },
  SHIPMENT_TRACKING_MILESTONE_CHANGED: { label: '货件追踪节点变化', pages: ['入仓货件'], grantless: true },
}

export interface ItemOptions {
  store?: typeof STORE_A
  type?: keyof typeof TYPES
  id?: string | null
  rowStatus?: string | null
  filter?: SubscriptionFilterView | null
  events24h?: number
  failures24h?: number
  version?: number | null
  lastReceivedAt?: string | null
  destinationConfigured?: boolean
  canManage?: boolean
}

export function subItem(options: ItemOptions = {}): SubscriptionItem {
  const store = options.store ?? STORE_A
  const type = options.type ?? 'ORDER_CHANGE'
  const spec = TYPES[type]!
  const configured = options.destinationConfigured ?? true
  const rowStatus = options.rowStatus === undefined ? null : options.rowStatus
  const hasRow = options.id !== undefined ? options.id !== null : rowStatus !== null
  const state = subscriptionStateOf({
    rowStatus: hasRow ? (rowStatus ?? 'NOT_CREATED') : null,
    destinationConfigured: configured,
    storeAuthorized: store.authorized,
    grantless: spec.grantless === true,
  })
  const failures24h = options.failures24h ?? 0
  return {
    id: hasRow ? (options.id ?? `sub-${store.id}-${type}`) : null,
    sellerAccountId: store.id,
    storeName: store.displayName,
    notificationType: type,
    label: spec.label,
    pages: spec.pages,
    state,
    filter: options.filter ?? null,
    destinationHint: hasRow ? '****0001' : null,
    lastReceivedAt: options.lastReceivedAt ?? null,
    events24h: options.events24h ?? 0,
    failures24h,
    version: hasRow ? (options.version ?? 1) : null,
    filterable: spec.filterable === true,
    actions: subscriptionActionsOf({ hasRow, state, canManage: options.canManage ?? true, destinationConfigured: configured, filterable: spec.filterable === true, failures24h }),
  }
}

/** 接收端没配置时的 `destination` 段（所需配置与退化说明取契约里的原文）。 */
export const missingDestination = (): SubscriptionCenterResponse['destination'] => ({
  configured: false,
  hint: null,
  envKey: DESTINATION_ENV_KEY,
  setupSteps: [...DESTINATION_SETUP_STEPS],
  fallbackNote: DESTINATION_MISSING_FALLBACK,
})

export function subList(over: Partial<SubscriptionCenterResponse> & { items?: SubscriptionItem[] } = {}): SubscriptionCenterResponse {
  const configured = over.destination?.configured ?? true
  const items = over.items ?? [subItem({ type: 'ORDER_CHANGE' }), subItem({ type: 'TRANSACTION_UPDATE' })]
  return {
    destination: { configured, hint: configured ? '****0001' : null, envKey: DESTINATION_ENV_KEY, setupSteps: [...DESTINATION_SETUP_STEPS], fallbackNote: DESTINATION_MISSING_FALLBACK },
    canManage: true,
    affectedPages: configured ? [] : [...affectedPagesOf(Object.values(TYPES)), MARKETING_STREAM_AFFECTED],
    stores: [STORE_A, STORE_B],
    items,
    summary: summarizeSubscriptions(items),
    truncated: false,
    ...over,
  }
}
