import { z } from 'zod'

// 导出中心契约（P1-28，09 章 9.4）。导出范围继承发起页面的数据范围与权限；敏感字段（成本、利润、买家信息）按字段级权限过滤；
// 下载链接签名且短时有效；每次导出写审计。

export const EXPORT_FORMATS = ['CSV', 'XLSX'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED'] as const
export const EXPORT_STATUS_LABEL: Record<(typeof EXPORT_STATUSES)[number], string> = { QUEUED: '排队中', RUNNING: '生成中', DONE: '已完成', FAILED: '失败', EXPIRED: '已过期' }
/** 导出文件保留天数（过期后文件删除、记录保留状态） */
export const EXPORT_RETENTION_DAYS = 7
/** 下载链接有效期（秒） */
export const EXPORT_LINK_TTL_SECONDS = 300
/** Excel 格式单表最多行数（Excel 自身上限 1,048,576，含表头）；超过请用 CSV */
export const XLSX_MAX_ROWS = 1_000_000
/** 同一成员同时排队与生成中的导出任务上限 */
export const EXPORT_MAX_ACTIVE_PER_USER = 3
export type ExportFieldKey = 'cost' | 'profit' | 'buyer'

export interface ExportColumnSpec {
  key: string
  label: string
  /** 敏感字段：成员没有对应字段权限时，该列不会出现在导出里 */
  sensitive?: ExportFieldKey
}
export interface ExportKindSpec {
  kind: string
  label: string
  /** 来源页面路径（审计与列表展示） */
  sourcePage: string
  /** 发起导出所需的数据读取权限 */
  permission: string
  /** 允许的筛选条件键（发起页面当时的筛选）；带了其他键的请求会被拒绝，避免“看起来筛了其实没筛” */
  filterKeys: readonly string[]
  /** 数据是否按店铺授权划分；缺省是。审计日志不分店铺（storeScoped 为 false），不检查数据范围，也不因“没有店铺授权”拒绝。 */
  storeScoped?: boolean
  columns: readonly ExportColumnSpec[]
}

/** 可导出的数据目录。每个条目必须有 worker 里的取数实现（单元测试保证两边一致）。随各页面工作包扩充。 */
export const EXPORT_KINDS: readonly ExportKindSpec[] = [
  {
    kind: 'orders',
    label: '订单列表',
    sourcePage: '/app/orders',
    permission: 'orders.read',
    filterKeys: ['storeIds', 'status', 'q', 'from', 'to'],
    columns: [
      { key: 'amazonOrderId', label: '订单号' },
      { key: 'storeName', label: '店铺' },
      { key: 'purchaseDate', label: '下单时间' },
      { key: 'status', label: '订单状态' },
      { key: 'fulfillment', label: '履约方式' },
      { key: 'currency', label: '币种' },
      { key: 'amount', label: '订单金额' },
      { key: 'itemCount', label: '商品件数' },
    ],
  },
  {
    // 经营日报/周报/月报（P2a-02）：读店铺日汇总。广告、利润、会话尚未接入，故不放对应的列（避免导出一排空白或 0）。
    kind: 'overview-report',
    label: '经营报表',
    sourcePage: '/app/overview',
    permission: 'overview.read',
    filterKeys: ['storeIds', 'from', 'to', 'template'],
    columns: [
      { key: 'summaryDate', label: '日期' },
      { key: 'storeName', label: '店铺' },
      { key: 'currency', label: '币种' },
      { key: 'orders', label: '订单数' },
      { key: 'units', label: '销量（件）' },
      { key: 'salesAmount', label: '销售额' },
      { key: 'refundAmount', label: '退款额' },
      { key: 'feeAmount', label: '平台费用' },
    ],
  },
  {
    // 赔付证据包（P2b-03）：按证据包生成当时保存的清单（EvidencePack.contentManifestJson）逐行输出，之后证据变化不影响已生成的包。
    kind: 'reimbursement-evidence',
    label: '赔付证据包',
    sourcePage: '/app/reimbursements',
    permission: 'reimbursements.read',
    filterKeys: ['storeIds', 'packId'],
    columns: [
      { key: 'section', label: '类别' },
      { key: 'item', label: '内容' },
      { key: 'detail', label: '说明' },
      { key: 'at', label: '时间' },
    ],
  },
  {
    // 费用事件（P2b-05）：与页面同一套筛选；时间范围用页面返回的起止时刻（fromAt、toAt，ISO 时间），金额带符号（扣费为负），不含销售收入与税。
    kind: 'fee-events',
    label: '费用事件',
    sourcePage: '/app/finance',
    permission: 'finance.read',
    filterKeys: ['storeIds', 'category', 'status', 'reconciliation', 'q', 'fromAt', 'toAt'],
    columns: [
      { key: 'postedAt', label: '发生时间' },
      { key: 'storeName', label: '店铺' },
      { key: 'category', label: '费用类型' },
      { key: 'subtype', label: '子类型' },
      { key: 'amount', label: '金额' },
      { key: 'currency', label: '币种' },
      { key: 'transactionStatus', label: '交易状态' },
      { key: 'amazonOrderId', label: '订单号' },
      { key: 'asin', label: 'ASIN' },
      { key: 'sellerSku', label: 'SKU' },
      { key: 'settlementId', label: '结算单' },
      { key: 'reconciliation', label: '对账状态' },
      { key: 'reconciliationNote', label: '对账备注' },
      { key: 'source', label: '来源' },
    ],
  },
  {
    // 商品主数据（P4-07）：筛选与页面同一套（productFilterWhere）；只导出商品自身的资料，不含销售、利润与库存数字
    // （那些按店铺 × ASIN 汇总、还分权限，放进导出会让“同 ASIN 多个 SKU”重复计数）。库存风险与“只看已关注”不是商品表的列，不支持导出筛选。
    kind: 'products',
    label: '商品主数据',
    sourcePage: '/app/products',
    permission: 'products.read',
    filterKeys: ['storeIds', 'q', 'asin', 'sku', 'parentAsin', 'brand', 'category', 'status', 'fulfillment', 'ownerId', 'tag'],
    columns: [
      { key: 'storeName', label: '店铺' },
      { key: 'asin', label: 'ASIN' },
      { key: 'sellerSku', label: '卖家 SKU' },
      { key: 'fnsku', label: 'FNSKU' },
      { key: 'parentAsin', label: '父体 ASIN' },
      { key: 'title', label: '标题' },
      { key: 'brand', label: '品牌' },
      { key: 'category', label: '类目' },
      { key: 'fulfillment', label: '履约方式' },
      { key: 'listingStatus', label: '刊登状态' },
      { key: 'price', label: '价格' },
      { key: 'currency', label: '币种' },
      { key: 'ownerName', label: '负责人' },
      { key: 'tags', label: '标签' },
      { key: 'updatedAt', label: '更新时间' },
    ],
  },
  {
    // 我的报表（P6-32）：行在入队前由接口按查看人的权限取好，放进 filterJson.rows。worker 不再查业务表。
    kind: 'custom-report',
    label: '我的报表',
    sourcePage: '/app/reports/custom',
    permission: 'reports.read',
    filterKeys: ['reportId', 'rows'],
    columns: [
      { key: 'id', label: '行编号' },
      { key: 'label', label: '名称' },
      { key: 'valuesJson', label: '指标' },
    ],
  },
  {
    // 审计日志（P5-09）：与审计中心列表同一套筛选（共用 audit-where.ts），时间用起止时刻（fromAt、toAt）；不分店铺。
    // 不含修改前后的内容（那里可能有大段文字）与浏览器信息；来源地址只给有 audit.read 的人，与详情页一致。
    kind: 'audit-events',
    label: '审计日志',
    sourcePage: '/app/audit',
    permission: 'audit.read',
    storeScoped: false,
    filterKeys: ['actorId', 'action', 'resourceType', 'resourceId', 'result', 'source', 'page', 'requestId', 'q', 'fromAt', 'toAt'],
    columns: [
      { key: 'occurredAt', label: '时间' },
      { key: 'actorName', label: '操作人' },
      { key: 'sourceLabel', label: '来源' },
      { key: 'page', label: '所属页面' },
      { key: 'action', label: '动作代码' },
      { key: 'actionLabel', label: '动作' },
      { key: 'resourceType', label: '资源类型' },
      { key: 'resourceId', label: '资源编号' },
      { key: 'resultLabel', label: '结果' },
      { key: 'reason', label: '原因' },
      { key: 'accessModeLabel', label: '访问模式' },
      { key: 'ip', label: '来源地址' },
      { key: 'requestId', label: '请求编号' },
    ],
  },
]
/**
 * 文档类导出（P6-12）：自定义箱标签与商品标签（FNSKU）生成的是 PDF，不是按行读取的表格，所以不进 EXPORT_KINDS（那里每一项都有行级取数实现），
 * 也不能用 POST /exports 发起：只能由入仓计划的专用接口创建（任务载荷保存在 filterJson 里），worker 用对应的渲染器生成，结果同样在导出中心下载。
 */
export const PDF_EXPORT_KINDS: readonly ExportKindSpec[] = [
  { kind: 'inbound-box-labels', label: '自定义箱标签', sourcePage: '/app/supply-chain', permission: 'inbound.read', filterKeys: [], columns: [] },
  { kind: 'inbound-item-labels', label: '商品标签（FNSKU）', sourcePage: '/app/supply-chain', permission: 'inbound.read', filterKeys: [], columns: [] },
]
export const isPdfExportKind = (kind: string) => PDF_EXPORT_KINDS.some(item => item.kind === kind)
export const exportKindOf = (kind: string) => EXPORT_KINDS.find(item => item.kind === kind) ?? PDF_EXPORT_KINDS.find(item => item.kind === kind)
/** 导出任务的文件格式：表格类是 CSV、XLSX，文档类是 PDF。 */
export type ExportFileFormat = ExportFormat | 'PDF'

export const ExportCreateBodySchema = z.object({
  kind: z.string().min(1).max(60),
  format: z.enum(EXPORT_FORMATS).default('CSV'),
  /** 发起页面当时的筛选条件（范围、日期、状态等），保存后原样用于生成，不再受后续页面操作影响 */
  filters: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.array(z.string().max(64)).max(100)])).default({}),
  /** 想导出的列（缺省为全部可见列）；用户没有权限的敏感列即使被选中也会被去掉 */
  columns: z.array(z.string().max(60)).max(60).optional(),
  filterSummary: z.string().trim().max(300).default(''),
})
/**
 * 导出任务保存的“发起时的范围与字段策略”：接口服务在受理时按发起人当时的权限计算，worker 生成文件时再与发起人当前的权限取交集
 * （权限被收回则导出失败，不会多出任何内容）。
 */
export const ExportPolicySnapshotSchema = z.object({
  columns: z.array(z.string()).min(1),
  scope: z.object({ unrestricted: z.boolean(), storeIds: z.array(z.string()) }),
})
export type ExportPolicySnapshot = z.infer<typeof ExportPolicySnapshotSchema>

/** 导出失败原因（errorCode）对应的中文说明；未登记的一律显示“生成失败，请重新发起” */
export const EXPORT_ERROR_LABEL: Record<string, string> = {
  EXPORT_ACTOR_INACTIVE: '发起人已不在企业内，导出已取消',
  EXPORT_PERMISSION_REVOKED: '发起人的导出权限已被收回，导出已取消',
  EXPORT_SCOPE_EMPTY: '发起人当前的数据范围内没有可导出的店铺',
  EXPORT_ROWS_EXCEEDED: '行数超过 Excel 上限，请改用 CSV 或缩小筛选范围',
  EXPORT_KIND_UNKNOWN: '导出的数据类型已不再支持',
  EXPORT_STALE: '任务长时间没有完成，已被取消，请重新发起',
  EXPORT_QUEUE_UNAVAILABLE: '导出队列暂时不可用，请稍后重新发起',
  EXPORT_FAILED: '生成失败，请重新发起',
  // P6-12 标签生成：下面的失败都是业务原因，如实告诉用户怎么办
  LABEL_JOB_INVALID: '标签任务的内容已损坏，请重新发起',
  LABEL_BASE_MISSING: '没有找到可用的亚马逊箱标签文件（可能已被清理），请先在标签页签重新向亚马逊获取箱标签',
  LABEL_BASE_INVALID: '亚马逊箱标签文件无法读取（不是有效的 PDF 或已加密），请重新获取',
  LABEL_PAGE_MISMATCH: '亚马逊箱标签的页数与货件的箱数对不上，请确认运输方案后重新获取箱标签再试',
  LABEL_FONT_MISSING: '标签里含有中文等非英文字符，但 worker 没有配置可用的字体文件（LABEL_FONT_PATH），请联系管理员配置，或去掉这些内容后重试',
  LABEL_TOO_LARGE: '标签数量超过上限，请按货件或分批生成',
  LABEL_SCOPE_DENIED: '发起人当前的数据范围里已没有这个计划所在的店铺',
  LABEL_TEXT_TOO_LONG: '标签上要印的文字太长，放不进标签纸；请缩短品名、原产地或箱号规则后重新生成',
}

/** 导出文件名：数据类型 + 生成时间（北京时间，到分钟），不含筛选条件与个人信息。 */
export function exportFileName(label: string, format: ExportFileFormat, now: Date): string {
  const local = new Date(now.getTime() + 8 * 3_600_000).toISOString()
  const extension = format === 'XLSX' ? 'xlsx' : format === 'PDF' ? 'pdf' : 'csv'
  return `${label}_${local.slice(0, 10).replace(/-/g, '')}-${local.slice(11, 16).replace(':', '')}.${extension}`
}
export const EXPORT_CONTENT_TYPE: Record<ExportFileFormat, string> = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
}

export const ExportListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(500).optional() })
