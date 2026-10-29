import { z } from 'zod'
import { US_MARKETPLACE_ID } from './scope-search.js'

// 亚马逊通知订阅契约（P1-28，09 章 9.7；类型清单来自 freeze/importers.md 第五节 N-01 至 N-18）。
// 接收端（消息队列或事件总线）属于部署专项：未配置时订阅记录保持“未创建”，页面如实说明并标出受影响的页面。

export interface NotificationTypeSpec {
  type: string
  label: string
  payloadVersion: string
  /** 订阅后受益（实时性提升）的页面，接收端未就绪时在订阅页提示 */
  pages: readonly string[]
  /** 是否支持过滤条件（只有“报价变化”支持按站点与聚合周期过滤） */
  filterable?: boolean
  /** 无需卖家授权即可订阅（只能订阅一次、与店铺无关）；本期仍按店铺记录，便于统一管理 */
  grantless?: boolean
}

const t = (type: string, label: string, pages: readonly string[], payloadVersion = '1.0', extra: Partial<NotificationTypeSpec> = {}): NotificationTypeSpec => ({
  type,
  label,
  payloadVersion,
  pages,
  ...extra,
})

export const NOTIFICATION_TYPES: readonly NotificationTypeSpec[] = [
  t('ITEM_SALES_EVENT_CHANGE', '商品销售事件', ['今日实时']),
  t('DETAIL_PAGE_TRAFFIC_EVENT', '详情页流量事件', ['今日实时']),
  t('ITEM_INVENTORY_EVENT_CHANGE', '商品库存事件', ['今日实时', '库存健康']),
  t('FBA_INVENTORY_AVAILABILITY_CHANGES', '亚马逊物流库存可售变化', ['库存健康']),
  t('ANY_OFFER_CHANGED', '报价变化', ['定价与购物车', '竞品监控'], '1.0', { filterable: true }),
  t('PRICING_HEALTH', '定价健康', ['定价与购物车']),
  t('FEE_PROMOTION', '费用促销', ['费用核查']),
  t('LISTINGS_ITEM_STATUS_CHANGE', '刊登状态变化', ['刊登质量']),
  t('LISTINGS_ITEM_ISSUES_CHANGE', '刊登问题变化', ['刊登质量']),
  t('ITEM_PRODUCT_TYPE_CHANGE', '商品类型变化', ['刊登质量']),
  t('PRODUCT_TYPE_DEFINITIONS_CHANGE', '商品类型定义变化', ['刊登质量'], '2020-09-01'),
  t('BRANDED_ITEM_CONTENT_CHANGE', '品牌商品内容变化', ['刊登质量', '风险预警']),
  t('ORDER_CHANGE', '订单变化', ['订单', '今日实时']),
  t('TRANSACTION_UPDATE', '财务交易更新', ['结算交易']),
  t('REPORT_PROCESSING_FINISHED', '报告处理完成', ['报表中心'], '2020-09-18'),
  t('FEED_PROCESSING_FINISHED', '批量任务处理完成', ['批量刊登'], '2020-09-04'),
  t('ACCOUNT_STATUS_CHANGED', '账户状态变化', ['账户健康']),
  t('SHIPMENT_TRACKING_MILESTONE_CHANGED', '货件追踪节点变化', ['入仓货件'], '1.0', { grantless: true }),
]
export const NOTIFICATION_TYPE_KEYS: readonly string[] = NOTIFICATION_TYPES.map(item => item.type)
export const notificationTypeOf = (type: string) => NOTIFICATION_TYPES.find(item => item.type === type)
export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'INVALID', 'NOT_CREATED'] as const
export const SUBSCRIPTION_STATUS_LABEL: Record<(typeof SUBSCRIPTION_STATUSES)[number], string> = { ACTIVE: '有效', INVALID: '已失效', NOT_CREATED: '未创建' }
export const AGGREGATION_PERIODS = ['FiveMinutes', 'TenMinutes'] as const

export const SubscriptionFilterSchema = z.object({
  marketplaceIds: z
    .array(z.literal(US_MARKETPLACE_ID, { error: '站点只支持亚马逊美国站' }))
    .max(1)
    .optional(),
  aggregationTimePeriod: z.enum(AGGREGATION_PERIODS).optional(),
})
export type SubscriptionFilter = z.infer<typeof SubscriptionFilterSchema>

const idText = z.string().min(1).max(64)
export const SubscriptionCreateBodySchema = z.object({
  sellerAccountId: idText,
  notificationType: z.string().refine(value => NOTIFICATION_TYPE_KEYS.includes(value), '不支持的通知类型'),
  filter: SubscriptionFilterSchema.optional(),
})
export const SubscriptionUpdateBodySchema = z.object({ version: z.number().int().min(1), filter: SubscriptionFilterSchema })
/** POST /notifications/subscriptions/:id/replay：重放失败事件（指定事件，或该订阅类型下全部失败事件，最多 200 条） */
export const SubscriptionReplayBodySchema = z
  .object({ eventIds: z.array(idText).min(1).max(200).optional(), allFailed: z.literal(true).optional() })
  .refine(value => Boolean(value.eventIds) !== Boolean(value.allFailed), { message: '请指定要重放的事件，或选择全部失败事件' })
export const SUBSCRIPTION_REPLAY_MAX = 200
