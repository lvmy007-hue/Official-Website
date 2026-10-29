import type { Client } from 'pg'
import { insertRow } from './db-fixtures'

// 租户隔离测试的共用造数（行级安全套件与越权测试套件共用）。
// 把“每个租户每张租户表各造一行”做成自动的：新增的带 tenantId 的表会被自动纳入，不需要改测试。

/** 没有 tenantId 列、通过上级对象归属租户的子表 */
export const CHILD_TABLES: Record<string, { parent: string; foreignKey: string }> = {
  PurchaseOrderLine: { parent: 'PurchaseOrder', foreignKey: 'purchaseOrderId' },
  FbaInboundShipment: { parent: 'FbaInboundPlan', foreignKey: 'planId' },
  ConnectionHealth: { parent: 'PlatformConnection', foreignKey: 'connectionId' },
  FieldPermission: { parent: 'Role', foreignKey: 'roleId' },
}

/** 系统连接专用：租户连接没有任何权限（登录会话、商务订单与支付、官网表单、套餐目录） */
export const SYSTEM_ONLY_TABLES = [
  'Session',
  'MfaFactor',
  'DataEncryptionKey',
  'PlatformAdmin',
  'TenantInvitation',
  'ContactRequest',
  'CommercialPlan',
  'CommerceOrder',
  'Subscription',
  'PaymentRecord',
  'PaymentEvent',
  'RefundRequest',
  'InvoiceRequest',
  'CommerceAuditLog',
]

/** 有专门策略的全局表 */
export const SPECIAL_TABLES = ['Role', 'Tenant', 'User']

/** 只增不改的表：租户连接只有读与写入权限 */
export const APPEND_ONLY_TABLES = ['AuditEvent']

/** 租户只读的表：租户连接只有读取权限，写入只有平台经系统连接（生命周期事件、配额） */
export const READ_ONLY_TABLES = ['TenantLifecycleEvent', 'TenantQuota']

export const IGNORED_TABLES = new Set(['_prisma_migrations'])

// 造数时需要满足检查约束的列（其余必填列按类型自动补值）
const SEED_OVERRIDES: Record<string, Record<string, unknown>> = {
  StepUpVerification: { method: 'PASSWORD' },
  // P6-03 表格视图：个人视图必须有所有者，名称不超过 40 字，JSON 列传文本
  GridView: { scope: 'USER', ownerUserId: 'seed-user', name: '造数视图', config: JSON.stringify({}) },
  // P6-08 发货地址：国家代码必须是两位大写字母，州、邮编、电话有长度上限（其余文本列带标记）
  ShipFromAddress: { countryCode: 'US', stateOrProvince: 'CA', postalCode: '90001', phone: '5550100' },
  // P6-09 人工预测规则：对象类型与模式有取值限制，固定日销要在 0 到 100 万之间（造数默认 0 也合法，这里给明确值），时间段至少一天
  ForecastOverride: { scopeType: 'SKU', mode: 'FIXED', value: 5, fromDate: new Date('2026-01-01T00:00:00Z'), toDate: new Date('2026-01-31T00:00:00Z') },
  // P6-11 外部货号映射与装箱单列映射：来源只允许 MANUAL、IMPORT；列映射必须是 JSON 对象
  SkuAlias: { source: 'MANUAL' },
  PackingListMapping: { columns: JSON.stringify({}) },
  // P6-12 标签模板：纸张只允许三种、名称 1 到 40 字、选项与箱号规则必须是 JSON 对象；标签生成记录的类型只允许 BOX_CUSTOM、ITEM
  LabelTemplate: { paper: 'THERMAL_4X6', options: JSON.stringify({}), boxNoRule: JSON.stringify({}) },
  LabelPrintLog: { kind: 'ITEM', labelCount: 1 },
  // P6-13 退货原因映射：代码、中文释义、大类都有长度约束
  ReturnReasonMap: { labelZh: '造数原因', category: '未分类' },
  FieldPermission: { fieldKey: 'cost' },
  TenantQuota: { quotaKey: 'stores', limitValue: 5 },
  TenantOnboarding: { step: 'PROFILE', stepStateJson: {} },
  ConnectorChannelState: { domain: 'ORDERS' },
  ConnectorParityRun: { domain: 'ORDERS', status: 'PASSED' },
  ConnectorParityDiff: { category: 'UNEXPLAINED' },
  OrderStatusHistory: { source: 'API' },
  OrderCancellation: { cancelledBy: 'UNKNOWN' },
  OrderCharge: { chargeKind: 'ITEM' },
  ReplenishmentPolicy: { level: 'TENANT', levelRef: 'ALL', versionNo: 1, leadTimeDays: 30, safetyDays: 7, coverageDays: 60, redundancyMultiplier: 1.5, agingFromDays: 181 },
  IntegrationSwitch: { switchKey: 'sw.test' },
  IntegrationSwitchLog: { action: 'ENABLE' },
  FxRate: { rate: 7, quoteCurrency: 'CNY', rateDate: new Date('2026-01-01T00:00:00Z') },
  FxSourceConfig: { role: 'PRIMARY' },
  AlertInstance: { severity: 'WARNING' },
  // P6-16 汇总批次：类型与状态有检查约束；已发送必须有发送时间，所以造一行待发送的
  AlertDigest: { kind: 'FREQUENCY', status: 'PENDING' },
  // P6-17 跟卖观察：最近看到不能早于首次看到（造数默认两个时间可能相差几毫秒，这里给明确值）
  OfferCompetitor: { firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date('2026-01-01T00:00:00Z') },
  // P6-18 利润项目字典：层级、分组、正负方向有检查约束；一级项目不能有父项目；口径版本的类型与状态有检查约束，内容必须是 JSON 对象
  ProfitItem: { level: 1, group: 'OTHER', sign: 1, name: '造数项目' },
  MetricVersion: { kind: 'PROFIT_DICTIONARY', versionNo: 1, status: 'ACTIVE', config: JSON.stringify({}) },
  // P6-19 分摊规则：依据限定五种，生效月必须是当月第一天，非手动依据不能有手动比例
  AllocationRule: { basis: 'SALES_AMOUNT', effectiveMonth: new Date('2026-01-01T00:00:00Z') },
  // P6-20 预估费用：范围、方式、周期、状态有检查约束；金额不为负，比例不超过 100，截止日不早于起始日
  EstimatedFee: { scopeType: 'STORE', scopeId: 'seed-store', mode: 'FIXED', value: '1', currency: 'USD', period: 'MONTHLY', from: new Date('2026-01-01T00:00:00Z'), status: 'ACTIVE' },
  // P6-26 物流商、渠道、阶梯报价：名称与代码长度、材积除数为正、分抛系数 0 到 1、重量段上限大于下限、币种三位大写字母
  Carrier: { name: '造数物流商', code: 'SEED' },
  CarrierChannel: { name: '造数渠道', code: 'SEED', volumetricDivisor: 6000, splitFactor: 1 },
  ChannelRate: { region: 'US', weightFrom: 0, unitPrice: 1, currency: 'USD', billingMode: 'PER_KG', effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  // P6-27 审批记录：类型、状态有检查约束；待处理不能有处理时间
  ApprovalRequest: { type: 'FINANCE_POLICY', objectType: 'SeedObject', objectId: 'seed-object', title: '造数审批', requesterId: 'seed-user', status: 'PENDING', decidedAt: null },
  TenantSetting: { sellerAccountId: null },
  ExportJob: { format: 'CSV' },
  OperationLog: { scope: 'STORE' },
  PlatformSupportAccess: { scope: 'READ_ONLY', startsAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-02T00:00:00Z') },
  HourlySalesEvent: {
    asin: 'B00SEED0001',
    units: 0,
    salesAmount: 0,
    currency: 'USD',
    orders: 0,
    isLateArrival: false,
    hourStart: new Date('2026-01-01T00:00:00Z'),
    sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  HourlyTrafficEvent: { asin: 'B00SEED0001', pageViews: 0, isLateArrival: false, hourStart: new Date('2026-01-01T00:00:00Z'), sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
  HourlyInventoryEvent: { asin: 'B00SEED0001', availableQty: 0, isLateArrival: false, hourStart: new Date('2026-01-01T00:00:00Z'), sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
  // P2a-05 库存类：枚举列的检查约束需要合法取值
  InventoryDailySnapshot: { source: 'API', snapshotDate: new Date('2026-01-01T00:00:00Z') },
  StorageFeeRecord: { feeKind: 'STORAGE' },
  // P2b-06 费用核查：费用类别需要合法取值
  FeeAudit: { feeKind: 'FULFILLMENT' },
  // P2b-07 结算核对：类别、口径与状态需要合法取值
  SettlementLine: { category: 'INCOME' },
  Reconciliation: { scopeKind: 'SETTLEMENT', status: 'PENDING' },
  ReconciliationException: { kind: 'AMOUNT_MISMATCH', category: 'UNEXPLAINED', status: 'OPEN' },
  // P2b-08 到账登记：金额必须大于 0，账号末四位必须是四位数字
  Disbursement: { amount: 1, bankLast4: '1234' },
  // P2b-09 利润日表：口径与存货计价有检查约束
  ProfitDaily: { basis: 'ORDERED', costing: 'FIFO' },
  // P2b-12 销售税汇总：来源有检查约束，州不能为空
  SalesTaxSummary: { source: 'TAX_LIBRARY', state: 'WA' },
  // P2b-13 期间关账：状态、期间起止、审批结论与快照修订号有检查约束
  AccountingPeriod: { status: 'OPEN', periodStart: new Date('2026-01-01T00:00:00Z'), periodEnd: new Date('2026-01-31T00:00:00Z') },
  PeriodSnapshot: { revision: 1 },
  FinancePolicyVersion: { versionNo: 1, status: 'ACTIVE', revenueRecognition: 'ORDERED', inventoryCostMethod: 'FIFO', adsAllocationMode: 'BY_SALES', storeFeeAllocation: 'BY_SALES' },
  // P3-12 分时策略：枚举、168 格系数与范围 JSON 有检查约束；执行记录的结果与小时有检查约束
  DaypartingStrategy: {
    kind: 'ON_OFF',
    targetLevel: 'CAMPAIGN',
    status: 'PAUSED',
    // JSON 列一律传文本：数组会被驱动当成数据库数组而不是 JSON
    scopeJson: JSON.stringify({ ids: [] }),
    hourlyMultipliersJson: JSON.stringify(Array.from({ length: 168 }, () => 1)),
    timezone: 'UTC',
  },
  DaypartingRun: { outcome: 'SKIPPED', hour: 0 },
  // P3-13 自动规则：枚举、四块 JSON 与评估统计有检查约束；执行记录的动作、结果与证据有检查约束
  AdsAutomationRule: {
    level: 'TARGET',
    mode: 'SUGGEST',
    status: 'PAUSED',
    frequency: 'DAILY',
    scopeJson: JSON.stringify({ campaignIds: [] }),
    conditionJson: JSON.stringify({ conditions: [], textFilters: [] }),
    actionJson: JSON.stringify({ type: 'PAUSE' }),
    guardrailJson: JSON.stringify({ minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 }),
  },
  AdsAutomationRun: { actionType: 'PAUSE', outcome: 'SKIPPED', ruleVersion: 1, evidenceJson: JSON.stringify({}) },
  // P3-14 广告变更记录：实体类型、变更来源、快照 JSON 与哈希有检查约束
  AdsEntitySnapshot: { entityType: 'CAMPAIGN', stateJson: JSON.stringify({}), hash: 'seed-hash' },
  AdsChangeLog: { entityType: 'CAMPAIGN', actorKind: 'EXTERNAL' },
  // P3-17 广告写入记录：类型、来源、对象类型、状态与 JSON 有检查约束；默认造数的状态是排队中（没有完成时间）
  AdsWriteRun: { kind: 'CAMPAIGN_STATE', source: 'MANUAL', entityType: 'CAMPAIGN', status: 'PENDING', requestJson: JSON.stringify({}) },
  // P4-10 刊登质量：问题类型、严重度、影响、处理状态、变更类型、行为人、刊登状态、写入类型与状态有检查约束（默认造数的写入是校验预览、排队中）
  ListingSnapshot: { status: 'ACTIVE' },
  ListingIssue: { issueKind: 'ISSUE', severity: 'ERROR', impact: 'NONE', handlingStatus: 'OPEN' },
  ListingChangeEvent: { changeKind: 'CONTENT_CHANGE', actorKind: 'UNKNOWN' },
  ListingWriteRun: { kind: 'VALIDATE', status: 'PENDING', requestJson: JSON.stringify({}) },
  // P4-11 定价：价格必须大于 0、来源与护栏、规则、执行记录的枚举有检查约束（默认造数的数值列是 0，要显式给合法值）
  PriceSnapshot: { source: 'LISTING_API', price: 1 },
  BuyBoxSnapshot: { source: 'SYNC' },
  PriceGuardrail: { scope: 'STORE', minPrice: 1 },
  PricingRule: { mode: 'MANUAL', strategy: 'FOLLOW_EXPECTED', maxChangePct: 0.05, dailyLimit: 1, breakerFailures: 3, version: 1 },
  PricingRuleRun: { outcome: 'SKIPPED', ruleVersion: 1 },
  // P4-12 竞品监控：来源与 ASIN 格式（十位大写字母数字，且与我方对应商品不同）有检查约束
  WatchedAsin: { reason: 'MANUAL', asin: 'B0COMPET01' },
  // P4-13 评价与反馈：星级 1 到 5 与评分数至少一个、ASIN 格式、情感与范围取值、名次大于 0、请求状态有检查约束（默认造数的整数列是 0）
  ReviewMetricSnapshot: { asin: 'B0REVIEW01', avgRating: 4, ratingCount: 1 },
  ReviewTopic: { sentiment: 'POSITIVE', rank: 1 },
  BrowseNodeReviewTrend: { scope: 'ALL', sentiment: 'POSITIVE' },
  BrowseNodeReturnTrend: { scope: 'ALL' },
  SolicitationRequest: { status: 'REQUESTED' },
  // P4-14 A+ 内容：内容名称不能为空，审核事件的状态与写入记录的类型有检查约束（默认造数的名称是空串，要显式给值）
  AplusContent: { name: 'A+ 内容' },
  AplusAsinRelation: { asin: 'B0APLUS001' },
  AplusReviewEvent: { status: 'DRAFT' },
  AplusWriteRun: { kind: 'UPLOAD' },
  // P3-15 广告报告任务：来源有检查约束（旧版任务不需要模板与起止日期）
  AdsReportJob: { source: 'LEGACY' },
  // P2b-11 官方经济数据：日聚合粒度有检查约束（费用预览的区间检查靠造数的两个日期列取同一个值满足）
  EconomicsDaily: { aggregation: 'DAY' },
  StorageCapacitySnapshot: { sourceKind: 'REPORT' },
  RemovalOrder: { type: 'RETURN' },
  InventoryLedgerSummary: { aggregation: 'DAILY' },
  // P2a-07 补货：没有默认值的枚举列需要合法取值（其余必填列按类型补零值，满足非负与 0-1 检查）
  ReplenishmentAction: { action: 'ADOPT' },
  // 补货批次的冻结快照由计算写入，读取方按“快照一定带数据时间”处理；空对象造数会让列表接口在读取快照时报错（P5-13 安全扫描发现）
  ReplenishmentBatch: { snapshotJson: JSON.stringify({ dataTimes: { restockSnapshotDate: null } }) },
  // P2a-08 上游仓储：货件状态没有默认值，需要合法取值（入库订单的状态有默认值 LOCAL_DRAFT，本地草稿可以没有亚马逊订单编号）
  AwdInboundShipment: { status: 'CREATED' },
  // P2a-10 采购与国内仓：枚举与大小关系的检查约束需要合法取值（数量按类型补 0 即可满足抽检 ≤ 批量，收货数量合计要求大于 0）
  PurchaseReceipt: { totalQty: 1 },
  QualityInspection: { result: 'PASS' },
  PurchasePayment: { kind: 'DEPOSIT', amount: 1, currency: 'USD' },
  PurchaseApproval: { decision: 'PENDING' },
  StockCount: { status: 'COUNTING' },
  CostVersion: { source: 'MANUAL', versionNo: 1, unitProductCost: 1 },
  // P2a-11 头程物流：运输方式等枚举列没有默认值，数量与金额的检查约束要求大于 0
  FirstMileShipment: { mode: 'SEA' },
  FirstMileShipmentItem: { quantity: 1 },
  FirstMileCost: { item: 'FREIGHT', amount: 1, currency: 'USD' },
  FirstMileMilestone: { source: 'MANUAL' },
  LandedCostAllocation: { method: 'VOLUME', quantity: 1 },
  TransitTimeStat: { mode: 'SEA', sampleCount: 1 },
  // P2a-12 入仓计划：枚举与大于 0 的检查约束需要合法取值
  InboundPlanItem: { quantity: 1 },
  PackingOption: { status: 'OFFERED' },
  InboundBox: { quantity: 1, weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1 },
  PlacementOption: { status: 'OFFERED' },
  TrackingEvent: { source: 'MANUAL' },
  LabelPrintJob: { kind: 'BOX' },
  InboundOperation: { operation: 'CREATE_PLAN' },
  // P2a-13 货件接收：差异类型与来源互相约束（少收必须来自接收数量且数量大于 0），机会的规则编号与状态要合法
  ReceivingDiscrepancy: { kind: 'SHORT', source: 'RECEIPT', qty: 1 },
  ReimbursementOpportunity: { ruleCode: 'INBOUND_DISCREPANCY' },
  // P2b-03 赔付中心：案件的规则与状态受检查约束；官方赔付明细、证据包没有取值约束
  ReimbursementCase: { ruleCode: 'INBOUND_DISCREPANCY', status: 'OPPORTUNITY' },
  ReimbursementRecord: { matchBasis: 'CASE_ID' },
  // P2a-14 商品目录：子体不能等于父体，排名必须大于 0
  ProductVariantRelation: { parentAsin: 'B00SEEDPAR1', childAsin: 'B00SEEDCHD1' },
  SalesRankSnapshot: { rank: 1 },
  // P3-01 广告连接器：核对记录的状态与差异类别有检查约束
  AdsParityRun: { status: 'PASSED' },
  AdsParityDiff: { category: 'UNEXPLAINED' },
  // P3-02 广告数据模型：投放类别、否定投放层级与指标对象类型有检查约束
  AdsTarget: { kind: 'KEYWORD' },
  AdsNegativeTarget: { level: 'CAMPAIGN' },
  AdsPerformanceHourly: { entityType: 'CAMPAIGN' },
  // P4-01 销售与流量：粒度、来源与核对记录的层级、指标有检查约束
  SalesTrafficDaily: { granularity: 'DAY', source: 'DATA_KIOSK' },
  SalesTrafficAsinDaily: { asinGranularity: 'CHILD', asin: 'B00SEED0001', source: 'DATA_KIOSK' },
  SalesTrafficDiff: { level: 'DAY', metric: 'sessions' },
  // P4-04 品牌分析：周期种类有检查约束
  BrandSearchQueryPerformance: { reportPeriod: 'WEEK' },
  BrandSearchCatalogPerformance: { reportPeriod: 'WEEK' },
  BrandSearchTerm: { reportPeriod: 'WEEK' },
  BrandMarketBasket: { reportPeriod: 'WEEK' },
  BrandRepeatPurchase: { reportPeriod: 'WEEK' },
  // P5-02 账户健康：指标分组、账户状态、问题类型有检查约束
  AccountHealthSnapshot: { metricGroup: 'OTHER' },
  PolicyIssue: { kind: 'OTHER' },
  // P6-32 自定义指标与报表：编号要符合 C- 加字母数字；数组列若没有默认值时造数工具不认识 TEXT[]
  CustomMetric: { key: 'C-SEED01', name: '造数指标', dimensions: [], format: '{}', expression: '{}' },
  CustomReport: { source: 'product-performance', name: '造数报表', config: '{}', starredBy: [] },
  // P6-33 仪表盘：组件类型有检查约束；名称 1 到 40 字
  DashboardFolder: { name: '造数夹' },
  Dashboard: { name: '造数盘', layout: '{}', shared: false },
  DashboardWidget: { type: 'TEXT', query: '{}', options: '{}' },
}

// 业务上固定的取值：存在这一列就按此赋值（站点固定为美国站，让列表接口的默认过滤能命中造出来的行）
const FIXED_COLUMNS: Record<string, string> = { marketplaceId: 'ATVPDKIKX0DER' }

/** 带 tenantId 列的租户表（不含系统专用表），按表名排序。 */
export async function listTenantTables(admin: Client): Promise<string[]> {
  const { rows } = await admin.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
     ORDER BY c.relname`,
  )
  return rows.map(row => row.relname as string).filter(name => !SYSTEM_ONLY_TABLES.includes(name))
}

type ForeignKey = { table: string; column: string; refTable: string }

async function foreignKeys(admin: Client): Promise<ForeignKey[]> {
  const { rows } = await admin.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref
     FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
  )
  const unquote = (name: string) => name.replace(/^"|"$/g, '')
  return rows.map(row => ({ table: unquote(row.tbl), column: row.col, refTable: unquote(row.ref) }))
}

/** 按外键依赖排序：被引用的表排在前面（遇到环就按原顺序放行）。 */
function dependencyOrder(tables: string[], keys: ForeignKey[]): string[] {
  const ordered: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (table: string) => {
    if (state.has(table)) return
    state.set(table, 'visiting')
    for (const key of keys) if (key.table === table && key.refTable !== table && tables.includes(key.refTable)) visit(key.refTable)
    state.set(table, 'done')
    ordered.push(table)
  }
  for (const table of tables) visit(table)
  return ordered
}

async function markerColumns(admin: Client, table: string, marker: string) {
  const { rows } = await admin.query(
    `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('text', 'character varying')`,
    [table],
  )
  const values: Record<string, unknown> = {}
  for (const row of rows) {
    if (row.column_name in FIXED_COLUMNS) values[row.column_name] = FIXED_COLUMNS[row.column_name]
    else if (row.is_nullable === 'NO' && row.column_default === null) values[row.column_name] = `${row.column_name}-${marker}`
  }
  return values
}

/**
 * 为租户在每张租户表里造一行（已有行的表跳过），所有文本列都带上标记，便于断言“有没有泄露到别的租户的响应里”。
 * 外键指向同一租户里被引用表的那一行，保证关联完整（否则带关联的接口会因为查不到关联对象报错）。
 * 调用方负责在造数期间关闭外键校验（replica 模式）。
 */
export async function seedTenantRows(admin: Client, tables: string[], tenantId: string, marker: string): Promise<void> {
  const keys = await foreignKeys(admin)
  const refOf = async (table: string) => {
    const hasTenant = (await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenantId'`, [table])).rowCount
    if (!hasTenant) return null
    return ((await admin.query(`SELECT id FROM "${table}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [tenantId])).rows[0]?.id as string | undefined) ?? null
  }
  const foreignValues = async (table: string) => {
    const values: Record<string, unknown> = {}
    for (const key of keys) {
      if (key.table !== table || key.refTable === table) continue
      const id = await refOf(key.refTable)
      if (id) values[key.column] = id
    }
    return values
  }

  for (const table of dependencyOrder(tables, keys)) {
    const existing = await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [tenantId])
    if (existing.rows[0].n > 0) continue
    // 主键之外，“成员—用户”这类指向非租户表的外键保持默认值
    await insertRow(admin, table, { ...(await markerColumns(admin, table, marker)), ...(await foreignValues(table)), ...SEED_OVERRIDES[table], id: `${table}-${marker}`, tenantId })
  }
  for (const [table, { parent, foreignKey }] of Object.entries(CHILD_TABLES)) {
    const parentId = (await admin.query(`SELECT id FROM "${parent}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [tenantId])).rows[0].id
    await insertRow(admin, table, { ...(await markerColumns(admin, table, marker)), ...(await foreignValues(table)), ...SEED_OVERRIDES[table], id: `${table}-${marker}`, [foreignKey]: parentId })
  }
}
