import {
  DESTINATION_ENV_KEY,
  DESTINATION_MISSING_FALLBACK,
  DESTINATION_SETUP_STEPS,
  MARKETING_STREAM_AFFECTED,
  NOTIFICATION_TYPES,
  affectedPagesOf,
  subscriptionActionsOf,
  subscriptionStateOf,
  summarizeSubscriptions,
  type SubscriptionCenterResponse,
  type SubscriptionFilterView,
  type SubscriptionItem,
} from '@nova/api-contracts'

// 消息推送订阅页的装配（P5-05，09 章 9.7）：纯函数，输入读出来的店铺、订阅记录与近 24 小时事件计数，输出页面响应。
// 每个店铺 × 每种推送类型一行（18 种）；已有订阅记录按记录，没有记录按前置条件（接收端、店铺授权）给出状态。

export const maskTail = (value: string) => (value.length <= 4 ? '****' : `****${value.slice(-4)}`)

export interface SubscriptionRowInput {
  id: string
  sellerAccountId: string
  destinationId: string
  notificationType: string
  status: string
  filterJson: unknown
  lastReceivedAt: Date | null
  version: number
}
export interface EventCountInput {
  sellerAccountId: string | null
  notificationType: string
  status: string
  count: number
}
export interface SubscriptionCenterInput {
  destinationId: string | null
  canManage: boolean
  stores: { id: string; displayName: string }[]
  authorizedStoreIds: ReadonlySet<string>
  rows: SubscriptionRowInput[]
  events: EventCountInput[]
  truncated: boolean
}

const filterOf = (value: unknown): SubscriptionFilterView | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { marketplaceIds?: unknown; aggregationTimePeriod?: unknown }
  const view: SubscriptionFilterView = {}
  if (Array.isArray(raw.marketplaceIds)) view.marketplaceIds = raw.marketplaceIds.filter((item): item is string => typeof item === 'string')
  if (typeof raw.aggregationTimePeriod === 'string') view.aggregationTimePeriod = raw.aggregationTimePeriod
  return view.marketplaceIds?.length || view.aggregationTimePeriod ? view : null
}

export function buildSubscriptionCenter(input: SubscriptionCenterInput): SubscriptionCenterResponse {
  const configured = input.destinationId !== null
  const counts = new Map<string, { total: number; failed: number }>()
  for (const event of input.events) {
    if (!event.sellerAccountId) continue
    const key = `${event.sellerAccountId}|${event.notificationType}`
    const current = counts.get(key) ?? { total: 0, failed: 0 }
    current.total += event.count
    if (event.status === 'FAILED') current.failed += event.count
    counts.set(key, current)
  }
  // 同一店铺同一类型在不同接收端下可能各有一条记录：优先显示当前接收端的那条
  const byKey = new Map<string, SubscriptionRowInput>()
  for (const row of input.rows) {
    const key = `${row.sellerAccountId}|${row.notificationType}`
    const current = byKey.get(key)
    if (!current || (input.destinationId !== null && row.destinationId === input.destinationId)) byKey.set(key, row)
  }
  const items: SubscriptionItem[] = input.stores.flatMap(store =>
    NOTIFICATION_TYPES.map(spec => {
      const key = `${store.id}|${spec.type}`
      const row = byKey.get(key)
      const count = counts.get(key)
      const state = subscriptionStateOf({
        rowStatus: row?.status ?? null,
        destinationConfigured: configured,
        storeAuthorized: input.authorizedStoreIds.has(store.id),
        grantless: spec.grantless === true,
      })
      const failures24h = count?.failed ?? 0
      return {
        id: row?.id ?? null,
        sellerAccountId: store.id,
        storeName: store.displayName,
        notificationType: spec.type,
        label: spec.label,
        pages: [...spec.pages],
        state,
        filter: filterOf(row?.filterJson),
        destinationHint: row ? maskTail(row.destinationId) : null,
        lastReceivedAt: row?.lastReceivedAt?.toISOString() ?? null,
        events24h: count?.total ?? 0,
        failures24h,
        version: row?.version ?? null,
        filterable: spec.filterable === true,
        actions: subscriptionActionsOf({ hasRow: Boolean(row), state, canManage: input.canManage, destinationConfigured: configured, filterable: spec.filterable === true, failures24h }),
      }
    }),
  )
  return {
    destination: {
      configured,
      hint: input.destinationId ? maskTail(input.destinationId) : null,
      envKey: DESTINATION_ENV_KEY,
      setupSteps: [...DESTINATION_SETUP_STEPS],
      fallbackNote: DESTINATION_MISSING_FALLBACK,
    },
    canManage: input.canManage,
    affectedPages: configured ? [] : [...affectedPagesOf(NOTIFICATION_TYPES), MARKETING_STREAM_AFFECTED],
    stores: input.stores.map(store => ({ id: store.id, displayName: store.displayName, authorized: input.authorizedStoreIds.has(store.id) })),
    items,
    summary: summarizeSubscriptions(items),
    truncated: input.truncated,
  }
}
