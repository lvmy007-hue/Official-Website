import { z } from 'zod'

// 协作类契约（P1-28）：评论与关注、对象事件、运营日志、保存视图。

/** 对象类型与读取它所需的权限（评论、关注、事件时间线都“随对象读权限”）。null 表示登录成员即可。 */
export const ENTITY_READ_PERMISSION: Readonly<Record<string, string | null>> = {
  WORK_ITEM: null,
  ALERT: 'alerts.read',
  STORE: 'overview.read',
  ASIN: 'products.read',
  SKU: 'products.read',
  ORDER: 'orders.read',
  PURCHASE_ORDER: 'purchase.read',
  SUPPLIER: 'supplier.read',
  FIRST_MILE: 'firstmile.read',
  INBOUND_PLAN: 'inbound.read',
  INBOUND_SHIPMENT: 'inbound.read',
  CAMPAIGN: 'ads.read',
  REIMBURSEMENT_CASE: 'reimbursements.read',
  RETURN: 'returns.read',
  LISTING: 'listing.read',
  // P2a-06：库存记录（详情页评论与关注）与库存规则（版本变更事件）
  INVENTORY: 'inventory.read',
  REPLENISHMENT_POLICY: 'inventory.read',
  // P5-02：账户健康里的政策合规问题（处理记录的时间线）
  POLICY_ISSUE: 'account.health.read',
}
export const ENTITY_TYPES = Object.keys(ENTITY_READ_PERMISSION) as [string, ...string[]]
export const EntityTypeSchema = z.enum(ENTITY_TYPES, { error: '不支持的对象类型' })
const idText = z.string().min(1).max(64)

export const COMMENT_MAX_LENGTH = 2000
export const COMMENT_MAX_MENTIONS = 20

export const CommentListQuerySchema = z.object({ entityType: EntityTypeSchema, entityId: idText, limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(500).optional() })
export const CommentCreateBodySchema = z.object({
  entityType: EntityTypeSchema,
  entityId: idText,
  body: z.string().trim().min(1, '评论不能为空').max(COMMENT_MAX_LENGTH),
  mentions: z.array(idText).max(COMMENT_MAX_MENTIONS).default([]),
  parentId: idText.optional(),
})
export const WatchBodySchema = z.object({ entityType: EntityTypeSchema, entityId: idText })
/** 一个成员最多关注的对象数 */
export const WATCH_LIMIT = 2000

export const ENTITY_EVENT_KINDS = [
  'price.change',
  'budget.change',
  'listing.change',
  'inbound.confirm',
  'cost.change',
  'alert',
  'manual',
  'workitem',
  'content.change',
  'promotion',
  'reimbursement.payout',
  'reimbursement.status',
] as const
// 对象事件的查询已并入统一事件接口（P6-06，见 events.ts 与 events-query.ts）。

/** 对象类型的中文名（通知与界面文案用） */
export const ENTITY_LABEL: Readonly<Record<string, string>> = {
  WORK_ITEM: '待办',
  ALERT: '预警',
  STORE: '店铺',
  ASIN: '商品',
  SKU: 'SKU',
  ORDER: '订单',
  PURCHASE_ORDER: '采购单',
  SUPPLIER: '供应商',
  FIRST_MILE: '头程运单',
  INBOUND_PLAN: '入仓计划',
  INBOUND_SHIPMENT: '入仓货件',
  CAMPAIGN: '广告活动',
  ADS_RULE: '自动规则',
  REIMBURSEMENT_CASE: '赔付案件',
  RETURN: '退货',
  LISTING: '刊登',
  INVENTORY: '库存',
  REPLENISHMENT_POLICY: '库存规则',
  POLICY_ISSUE: '政策合规问题',
}

/** 对象详情页路径（来自 routes.md）；没有独立详情页的对象返回 null。 */
export function entityDetailPath(entityType: string, entityId: string): string | null {
  const id = encodeURIComponent(entityId)
  switch (entityType) {
    case 'WORK_ITEM':
      return `/app/my/work-items?item=${id}`
    case 'ALERT':
      return `/app/alerts/${id}`
    case 'ASIN':
      return `/app/products/${id}`
    case 'SKU':
      return `/app/pricing/${id}`
    case 'ORDER':
      return `/app/orders/${id}`
    case 'PURCHASE_ORDER':
      return `/app/purchase-orders/${id}`
    case 'SUPPLIER':
      return `/app/suppliers/${id}`
    case 'FIRST_MILE':
      return `/app/first-mile/${id}`
    case 'INBOUND_PLAN':
      return `/app/supply-chain/${id}`
    case 'INBOUND_SHIPMENT':
      return `/app/warehouse/${id}`
    case 'CAMPAIGN':
      return `/app/advertising/campaigns/${id}`
    case 'ADS_RULE':
      return `/app/advertising/rules/${id}`
    case 'REIMBURSEMENT_CASE':
      return `/app/reimbursements/${id}`
    case 'RETURN':
      return `/app/returns/${id}`
    case 'INVENTORY':
      return `/app/inventory/${id}`
    case 'POLICY_ISSUE':
      return `/app/account-health?issue=${id}`
    default:
      return null
  }
}

export const OPERATION_SCOPES = ['STORE', 'ASIN', 'CAMPAIGN'] as const
export const OPERATION_SCOPE_ENTITY: Record<(typeof OPERATION_SCOPES)[number], string> = { STORE: 'STORE', ASIN: 'ASIN', CAMPAIGN: 'CAMPAIGN' }
export const OPERATION_CATEGORIES = ['PRICE', 'ADS', 'LISTING', 'INVENTORY', 'PROMOTION', 'OTHER'] as const
export const OPERATION_CATEGORY_LABEL: Record<(typeof OPERATION_CATEGORIES)[number], string> = { PRICE: '价格', ADS: '广告', LISTING: '刊登', INVENTORY: '库存', PROMOTION: '促销', OTHER: '其他' }
export const OperationLogListQuerySchema = z.object({
  scope: z.enum(OPERATION_SCOPES),
  scopeRef: idText,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export const OperationLogCreateBodySchema = z.object({
  scope: z.enum(OPERATION_SCOPES),
  scopeRef: idText,
  occurredAt: z.string().datetime(),
  category: z.enum(OPERATION_CATEGORIES),
  text: z.string().trim().min(2, '请填写记录内容').max(2000),
})

// ---- 保存视图 ----
/** 一个人在同一个页面最多保存的视图数 */
export const SAVED_VIEW_LIMIT = 30
export const SavedViewListQuerySchema = z.object({ pageKey: z.string().min(1).max(80) })
const json = z.record(z.string(), z.unknown())
export const SavedViewCreateBodySchema = z.object({
  pageKey: z.string().min(1).max(80),
  name: z.string().trim().min(1, '请填写视图名称').max(40),
  filterJson: json,
  columnsJson: z.array(z.unknown()).max(200),
  sortJson: z.array(z.unknown()).max(10),
  shared: z.boolean().default(false),
  isDefault: z.boolean().default(false),
})
export const SavedViewUpdateBodySchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(40).optional(),
  filterJson: json.optional(),
  columnsJson: z.array(z.unknown()).max(200).optional(),
  sortJson: z.array(z.unknown()).max(10).optional(),
  shared: z.boolean().optional(),
  isDefault: z.boolean().optional(),
})
