# P0-04 导入器与同步清单（冻结稿）

依据：02 章 2.1、2.3、2.4、2.5；10 章 10.3；12 章 12.5；14 章 P0-04。
本文件把每一个数据来源（接口、报告、数据集、推送、广告报表、营销数据流、文件导入、汇率）落到"解析器、目标表、幂等键、频率、所需角色、流式方式、失败码、新鲜度记录点、工作包"。

角色一栏为 **2026 年 10 月 21 日从亚马逊官方"角色对照表"逐项抽取**（"至少具备其一即可"），不是凭记忆填写。官方未逐项列出的，明确标注"实测核对"，在 P1-26 用真实授权验证。

---

## 零、通用约定

### 0.1 范围固定

- 所有请求固定 `marketplaceIds=ATVPDKIKX0DER`（美国站），不接受其他站点参数；
- 所有同步表带 10.1 的 4 个来源字段：`sourceUpdatedAt`、`syncedAt`、`sourceReportJobId`、`sourceRecordId`；
- 下文"幂等键"默认**省略前缀 `(tenantId, storeId)`**；分区表的幂等键必须再包含分区日期列（已在各行写出）。

### 0.2 流式模式（12.5）

| 代号 | 模式 | 做法 |
|---|---|---|
| S1 | 报告 | 创建 → 轮询（有推送则等推送，推送缺失时按退避轮询兜底）→ 取文档地址 → 下载流 → 解压流 → 逐行解析 → 每 1000 行一批 upsert；原始文件同时流式写入对象存储并登记 `RawReportFile`；全程不整文件进内存 |
| S2 | 接口分页 | 游标逐页拉取，每页立即写库；每页后保存断点（游标、时间窗）；令牌过期则从断点时间重新开页 |
| S3 | 数据中心查询 | 提交查询 → 轮询状态 → 取结果文档地址 → 下载流 → 逐行（JSON Lines）解析 → 每 1000 行一批 upsert；结果文档同时存入对象存储（亚马逊只保留 30 天） |
| S4 | 推送 | 接收端把消息体原样写入 `AmazonNotificationEvent` 并入队，处理器逐条幂等处理；消息体只存编号与参数的引用，不在队列里放大对象 |
| S5 | 操作驱动 | 用户或规则触发的单对象请求；写操作"先记录意图、再调用、再记录结果"；异步操作写 `InboundOperation` 并轮询 |
| S6 | 文件导入 | 浏览器经签名地址直传对象存储 → 服务端流式解析 → 先预检（列、类型、行数、重复）再入库；预检失败不落库 |
| S7 | 营销数据流 | 亚马逊投递到我方存储桶并发队列通知 → 逐文件流式解析 → 批量 upsert |

### 0.3 通用失败码

所有来源共用下列失败码（写入 `SyncJob`、`DataFreshness`，页面按码显示中文原因与处置建议）。各来源的**专属失败码**写在各表"专属失败码"列。

| 失败码 | 含义 | 是否重试 | 页面处置 |
|---|---|---|---|
| `AUTH_EXPIRED` | 授权失效或刷新失败 | 否 | 提示重新授权，状态"授权失效" |
| `ROLE_MISSING` | 缺少该来源所需角色（接口返回无权限） | 否 | 显示所需角色名称与申请方式，状态"未授权"；页面显示正式空状态，不降级为假数据 |
| `THROTTLED` | 被限流 | 是（退避加抖动，令牌桶降速） | 不报错；连续耗尽重试次数转 `THROTTLE_EXHAUSTED` |
| `THROTTLE_EXHAUSTED` | 限流重试用尽 | 稍后再排 | 状态"延迟" |
| `UPSTREAM_ERROR` | 亚马逊 5xx 或网络错误 | 是 | 状态"延迟" |
| `REPORT_FATAL` / `REPORT_CANCELLED` | 报告生成失败或被取消 | 按次数重试，仍失败则死信 | 显示原因，可手动重试 |
| `REPORT_TIMEOUT` | 超过等待上限 | 是 | 同上 |
| `REPORT_NO_DATA` | 报告生成成功但无数据 | — | **不算失败**：记录"本期无数据"并更新新鲜度 |
| `DOC_EXPIRED` | 文档下载地址过期 | 是（重新取地址） | 自动处理 |
| `DOC_CHECKSUM` | 下载内容校验不一致 | 是 | 自动处理 |
| `PARSE_HEADER` | 关键列缺失 | 否 | 状态"格式变化"，保留原始文件，通知管理员；**新增列与未知枚举值不算错误**，只记录 |
| `PARSE_ROW` | 单行解析错误 | — | 行写入隔离记录继续处理；错误行占比超过 1% 整体判失败 |
| `DEPENDENCY_MISSING` | 依赖的数据域尚未就绪（如无商品主数据） | 是（延后） | 状态"等待依赖" |
| `SCOPE_UNAVAILABLE` | 店铺不具备该来源前提（如未做品牌备案） | 否 | 显示前提条件，状态"不适用" |
| `RETENTION_GAP` | 回补范围超过亚马逊保留期，该段数据取不到 | 否 | 在回补进度里标记缺口，不伪造 |
| `QUOTA_EXCEEDED` | 触碰我方租户配额 | 否 | 提示联系平台 |

### 0.4 数据新鲜度记录点

每个来源有唯一 `sourceKey`，在 `DataFreshness` 中以 `(tenantId, storeId, sourceKey)` 一行记录：
`lastAttemptAt`、`lastSuccessAt`、`dataThrough`（数据覆盖到的时间点）、`lastRowCount`、`status`（正常、延迟、失败、未授权、不适用、未接入、等待依赖）、`lastErrorCode`。
**记录点**：与该批最后一次写库在**同一事务**内提交，保证"显示新鲜"与"数据已落库"一致。未配置接收端的推送类来源，状态固定为"未接入"（见 14.10）。

### 0.5 保留期与回补约束

| 来源 | 亚马逊侧保留 | 我方处理 |
|---|---|---|
| 报告文档（未注明的） | 90 天 | 原始文件落我方对象存储后不再依赖亚马逊 |
| 数据中心查询结果 | 30 天 | 必须当天落库，提醒文案写入同步中心 |
| 订单接口分页令牌 | 24 小时 | 断点按时间窗保存，令牌过期重开页 |
| 广告报告（按日） | 15 个月，单报告最多 120 天 | 历史回补按 120 天切片 |
| 广告报告（按小时） | 14 天 | 只用于近期，不做长回补 |
| 广告报告（按月） | 6 年，单报告最多 25 个月 | — |
| 营销数据流 | 订阅后回补 70 天 | 订阅时触发一次回补 |
| 财务交易 | 最近 48 小时订单可能尚未出现 | 财务近 3 天每日重拉，处理延迟入账与状态转换（递延 → 已释放） |

### 0.6 解析器通用要求

1. 原始文件先存对象存储，再分批解析（10.3 统一要求 1）；
2. 容忍新字段与未知枚举值（要求 2）；
3. 前端不等待下载与解析（要求 4）；
4. 重复同步不产生重复数据，靠"幂等键 + upsert"，且以 `sourceUpdatedAt` 较新者为准（要求 5）；
5. 单文件解析器不超过 400 行，放在 `apps/worker/src/importers/<域>/`；连接器放 `connectors/`；
6. 每个解析器配"官方格式样例文件"单元测试（测试租户只通过真实导入器加载样例，生产租户代码层拒绝）。

### 0.7 角色名称对照

| 英文名称（亚马逊官方） | 中文说明 |
|---|---|
| Amazon Fulfillment | 亚马逊物流 |
| Inventory and Order Tracking | 库存与订单跟踪 |
| Finance and Accounting | 财务与会计 |
| Product Listing | 商品刊登 |
| Pricing | 定价 |
| Brand Analytics | 品牌分析 |
| Selling Partner Insights | 卖家洞察 |
| Buyer Solicitation | 请求评价 |
| Amazon Warehousing and Distribution | 亚马逊仓储分销 |
| Direct to Consumer Shipping (Restricted) | 直接面向消费者配送（受限，涉及买家信息） |
| Tax Remittance (Restricted) | 税务汇缴（受限） |
| Tax Invoicing (Restricted) | 税务开票（受限） |
| Selling Partner Support (Restricted) | 卖家支持（受限） |

---

## 一、卖家接口（02 章 2.1，共 26 项）

写操作的开关与权限见 `permissions.md` 第六节。表中"频率"为默认值，企业设置中可调。

| 编号 | 来源与操作 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 流式 | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|---|
| I-01 | `Orders API v2026-01-01`：`searchOrders`、`getOrder`，`includedData` 取买家、收货、履约、收入明细、费用、促销、取消、包裹、税、付款 | `orders.search-v2026` | `Order`、`OrderItem`、`OrderCharge`、`OrderPackage`、`OrderCancellation`、`OrderStatusHistory` | `Order`：`(amazonOrderId, purchaseDate)`；`OrderItem`：`(orderItemId, purchaseDate)`；`OrderCharge`：`(orderItemId, chargeKind, componentKey, purchaseDate)`；`OrderStatusHistory`：`(orderId, status, sourceUpdatedAt)` | 推送实时；补偿每 15 分钟；历史回补按需 | Amazon Fulfillment、Buyer Communication、Buyer Solicitation、Direct to Consumer Shipping (Restricted)、Finance and Accounting、Inventory and Order Tracking、Pricing、Product Listing、Professional Services (Restricted)、Selling Partner Insights、Tax Invoicing (Restricted)、Tax Remittance (Restricted) | S2 | `ORD_PAGE_TOKEN_EXPIRED`（按时间窗断点续拉）、`ORD_PII_ROLE_MISSING`（无买家信息角色：买家字段为空并标注"无权限"，其余数据正常） | `orders.api` | P1-26、P2b-01 |
| I-02 | `Finances API v2024-06-19`：`listTransactions`（含 `transactionStatus`：递延、已释放、递延后释放） | `finance.transactions-v2024` | `FbaFinancialTransaction`；派生 `FbaFeeEvent`（9 类费用分类） | 交易：`(sellerAccountId, transactionId, postedAt)`（官方给稳定的 `transactionId`，无需哈希）；费用明细：`(sellerAccountId, "交易编号:项目序号:拆分位置", postedAt)`。状态会变化，重复拉取覆盖状态与金额（CR-021） | 推送实时；增量每次前推 14 天重拉（状态刷新）；每次增量后单独核对“递延”交易（接口不再返回的改为“递延后已释放”）并写当天递延余额 | Finance and Accounting | S2 | `FIN_TXN_STATUS_UNKNOWN`（未知状态值：入库并记录，不中断） | `finance.transactions` | P1-26、P2b-05 |
| I-03 | ~~`Finances API v2024-06-19`：`listBalances`~~ **官方该版本不存在此操作（2026-10-22 对照官方模型文件复核，见 CR-021）**。替代：由 I-02 的 `listTransactions(transactionStatus=DEFERRED)` 汇总当天“递延余额”（官方没有通用的账户余额接口；“卖家钱包”余额接口需要钱包账户与证书，不在本期范围） | `finance.balances-derived` | `AccountBalanceSnapshot`（`balanceType=DEFERRED`） | `(snapshotDate, currency, balanceType, accountType)` | 每次增量财务同步后 | Finance and Accounting | S2 | — | `finance.balances` | P1-26、P2b-08 |
| I-03 补（CR-046） | I-02 的 `listTransactions` 现在还把递延交易上的 `contexts[].maturityDate`（`DeferredContext`，交易层或明细层，取最晚的）写入 `FbaFinancialTransaction.maturityAt`（预计释放日）；接口没给就不写（也不覆盖已有值），页面据此把递延金额按周分桶，没给的单列“接口没给预计释放日”，不用下单日推算；解析在 `importers/finance/v2024-parse.ts` 的 `maturityOf` | — | — | — | — | — | — | — | — | P2b-08 |
| I-04 | ~~`Finances API v2024-06-19`：`listSummary`~~ **官方该版本不存在此操作（同上）**。替代：结算汇总用结算报告（R 类）与 I-02 交易按结算编号汇总对账，对账工作在 P2b-07 | — | `Reconciliation`（P2b-07 由结算报告与交易自行汇总） | — | — | — | — | — | — | P2b-07 |
| I-05 | `FBA Inventory API v1`：库存汇总（可售、在途、预留、不可售、调查中） | `inventory.summaries-v1` | `FbaInventoryRecord`、`InventoryDailySnapshot` | `FbaInventoryRecord`：`(sellerSku, fnsku)`；快照：`(sellerSku, fnsku, snapshotDate)` | 每 30 分钟；推送 `FBA_INVENTORY_AVAILABILITY_CHANGES` 触发刷新 | Amazon Fulfillment、Product Listing | S2 | — | `inventory.api` | P2a-05 |
| I-06 | `FBA Inbound Eligibility API v1`：发货前资格预检 | `inbound.eligibility-v1` | `InboundEligibilityCheck` | `(planId, sellerSku, program, checkedAt)` | 操作驱动 | Amazon Fulfillment | S5 | `ELIG_INELIGIBLE`（不合格：返回原因码，页面展示，不当作同步失败） | `inbound.eligibility` | P2a-12 |
| I-07 | `Fulfillment Inbound API v2024-03-20`：创建计划；生成、列出、确认装箱方案；提交箱内物品信息；生成、列出、确认分仓方案；货件与货件明细；箱子；生成、列出、确认运输方案；送达时间窗；更新追踪信息；取消计划；查询异步操作状态 | `inbound.plan-v20240320` | `FbaInboundPlan`、`InboundPlanItem`、`PackingOption`、`PackingGroup`、`Box`、`PlacementOption`、`TransportOption`、`DeliveryWindow`、`FbaInboundShipment`、`ShipmentItem`、`TrackingEvent`、`InboundOperation` | 计划：`(inboundPlanId)`；子对象：`(inboundPlanId, 对象类型, 来源编号)`；操作：`(operationId)` | 进行中的计划每 30 分钟；写操作驱动 | Amazon Fulfillment | S2、S5 | `INB_OP_FAILED`（异步操作失败，带 `operationProblems` 原文）、`INB_OP_TIMEOUT`、`INB_PLACEMENT_EXPIRED`（分仓方案过期）、`INB_VOID_WINDOW_CLOSED`（作废窗口已过）、`INB_SWITCH_OFF`（写入开关关闭，仅预览） | `inbound.plan` | P2a-12 |
| I-08 | `Amazon Warehousing and Distribution API v2024-05-09`：入库订单创建、更新、取消、确认；入库货件（含 SKU 预期与接收、有效期、预处理）；箱标签；更新运输信息；库存（含有效期、补货订单预留、发往上游仓储在途、上游仓储发往亚马逊物流在途） | `awd.inbound-v2024`、`awd.inventory-v2024` | `AwdInventory`、`AwdInboundOrder`、`AwdInboundShipment`、`AwdShipmentItem` | `AwdInventory`：`(sku, snapshotDate)`；订单：`(orderId)`；货件：`(shipmentId)`；明细：`(shipmentId, sku)` | 每 2 小时；写操作驱动 | Amazon Warehousing and Distribution | S2、S5 | `AWD_NOT_ENROLLED`（店铺未使用上游仓储：状态"不适用"，页面显示开通前提） | `awd.api` | P2a-08 |
| I-09 | `Catalog Items API v2022-04-01`：查询、获取商品 | `catalog.items-v2022` | `FbaProduct`（属性、图片、品牌、类目、父 ASIN）、`ProductVariantRelation`、`SalesRankSnapshot` | `FbaProduct`：`(asin)`；关系：`(parentAsin, childAsin)`；排名：`(asin, classificationId, snapshotDate)` | 每日全量；新商品出现时即时补取 | Product Listing | S2 | `CAT_ASIN_NOT_FOUND`（目录无该 ASIN：标记待核实） | `catalog.items` | P2a-14、P4-07 |
| I-10 | `Listings Items API v2021-08-01`：获取、修改、局部修改、删除 | `listings.items-v2021` | `ListingSnapshot`、`ListingContentSnapshot`（字段级）、`ListingIssue`、`PriceSnapshot`、`ListingChangeEvent` | 快照：`(sellerSku, snapshotDate)`；内容：`(sellerSku, fieldPath, contentHash)`；问题：`(sellerSku, issueCode, attributeName)`；价格：`(sellerSku, snapshotAt)` | 推送实时；每日全量；写后立即回读 | Inventory and Order Tracking、Product Listing | S2、S5 | `LST_VALIDATION_FAILED`（校验预览未通过）、`LST_SWITCH_OFF` | `listings.items` | P4-09、P4-10 |
| I-11 | `Listings Restrictions API v2021-08-01`：查询限制 | `listings.restrictions-v2021` | 不落库：结果随请求返回，缓存实例保留 1 小时 | — | 按需 | Product Listing | S5 | — | `listings.restrictions`（只记录最近一次成功时间） | P4-10 |
| I-12 | `Product Type Definitions API v2020-09-01`：查询定义 | `producttypes.definitions-v2020` | 定义 JSON 存对象存储并登记 `RawReportFile`；解析后的必填项存缓存实例；变更由推送 `PRODUCT_TYPE_DEFINITIONS_CHANGE` 触发刷新 | `(productType, version, locale)` | 按需 + 推送触发 | Product Listing、Pricing、Inventory and Order Tracking、Brand Analytics（各操作要求不同，至少其一） | S5 | — | `producttypes.definitions` | P4-10 |
| I-13 | `Product Pricing API v2022-05-01`：`getFeaturedOfferExpectedPriceBatch`（每批最多 40 个 SKU）、`getCompetitiveSummary`（每批最多 20 个 ASIN） | `pricing.featured-v2022`、`pricing.competitive-v2022` | `FeaturedOfferExpectedPrice`、`CompetitiveSummarySnapshot`、`CompetitiveOffer`、`BuyBoxSnapshot` | `(sellerSku 或 asin, snapshotAt)`；报价：`(asin, offerKey, snapshotAt)` | 每 2 小时；`ANY_OFFER_CHANGED`、`PRICING_HEALTH` 触发即时刷新 | Pricing | S2 | `PRC_BATCH_PARTIAL`（批内个别项失败：失败项单独重试，成功项照常入库） | `pricing.api` | P4-11、P4-12 |
| I-14 | `Product Fees API v0`：费用预估 | `fees.estimate-v0` | `FeeAudit`（预估基准列）；定价模拟结果不落库，随请求返回 | `(sellerSku, estimateDate, priceBasis)` | 按需 | Pricing、Product Listing | S5 | — | `fees.estimate` | P2b-06、P4-11（**P2b-06 没有做**：费用核查的基准只用 R-23、R-24 两份报告，未调用该接口，留给 P4-11 定价模拟） |
| I-15 | `Customer Feedback API v2024-06-01`：商品评论主题（前 10 正面、前 10 负面）、类目评论主题与 6 个月趋势、类目退货主题与趋势（7 个操作） | `feedback.topics-v2024`、`feedback.browsenode-v2024` | `ReviewTopic`、`BrowseNodeReviewTrend`、`BrowseNodeReturnTrend` | `(asin, topicKey, snapshotDate)`；趋势：`(browseNodeId, month, scope)` | 每周 | Brand Analytics、Selling Partner Insights | S2 | `FBK_NO_BRAND_ACCESS`（无品牌分析权限：状态"未授权"） | `feedback.api` | P4-13 |
| I-16 | `Solicitations API v1`：查询可用动作、发起请求评价 | `solicitations.v1` | `SolicitationRequest` | `(amazonOrderId)`（每单只请求一次，数据库唯一约束） | 操作驱动；每日汇总可请求订单 | Buyer Solicitation、Product Listing | S5 | `SOL_WINDOW_CLOSED`（超出送达后第 5 至 30 天窗口）、`SOL_ALREADY_SENT`、`SOL_SWITCH_OFF` | `solicitations.api` | P4-13 |
| I-17 | `Promotions API v2025-12-01`：`searchPromotions`、`getPromotion`、`getSelection` | `promotions.v2025` | `Promotion`、`PromotionItem`（校验问题随促销存储） | `Promotion`：`(promotionId)`；`PromotionItem`：`(promotionId, asin 或 sku)` | 每日 | Pricing、Product Listing | S2 | — | `promotions.api` | P4-05 |
| I-18 | `A+ Content Management API v2020-11-01`：内容查询、创建、更新、关联 ASIN、提交审核、查询审核状态 | `aplus.v2020` | `AplusContent`、`AplusAsinRelation`、`AplusReviewEvent` | `(contentReferenceKey)`；关联：`(contentReferenceKey, asin)`；审核事件：`(contentReferenceKey, status, sourceUpdatedAt)` | 每日；写操作驱动 | Brand Analytics、Product Listing | S2、S5 | `APL_REVIEW_REJECTED`（审核被拒：带原文原因，生成待办）、`APL_SWITCH_OFF` | `aplus.api` | P4-14 |
| I-19 | `Replenishment API v2022-11-07`：卖家指标、报价列表、报价指标 | `replenishment.v2022` | `SubscribeSaveMetric`、`SubscribeSaveOffer` | 指标：`(sellerAccountId, granularity, metricDate)`；报价：`(sellerAccountId, sku, snapshotDate)`（官方没有报价编号，用 SKU 定位） | 任务类型 `FBA_REPLENISHMENT`，随全量同步每 6 小时一次（并非严格每日） | Brand Analytics、Inventory and Order Tracking | S2 | `SNS_NOT_ENROLLED`（未使用订阅省：状态"不适用"；识别方式为启发式，见 CR-030） | `replenishment.api`（任务类型到来源的映射见 `JOB_FRESHNESS_SOURCES`） | P2a-07、P4-06 |
| I-20 | `Support API v2025-02-01`：`listCases`、`getCase`、`listContacts`（只读） | `support.v2025` | `SupportCase`、`SupportContact` | 案件：`(caseId)`；沟通：`(caseId, contactId)` | 每 2 小时 | Selling Partner Support (Restricted) | S2 | `SUP_ROLE_PENDING`（受限角色未获批：状态"未授权"，页面显示申请方式；案件编号仍可手工回填） | `support.api` | P2b-04 |
| I-21 | `Tracking API v2026-01-30`：`getShipmentTracking` | `tracking.v2026` | `TrackingEvent` | `(trackingIdentifier, milestone, occurredAt)` | 由推送 `SHIPMENT_TRACKING_MILESTONE_CHANGED` 与按需查询触发 | 无需授权（grantless） | S5 | `TRK_NOT_COVERED`（接口不覆盖入仓货件时返回的未覆盖结果：状态"不适用"，改用 I-F03 文件导入或手工回填） | `tracking.api` | P2a-11、P2a-13 |
| I-22 | `Notifications API v1`：目的地、订阅、过滤表达式 | `notifications.manage-v1` | `NotificationSubscription` | `(destinationId, notificationType, filterHash)` | 操作驱动；每日核对订阅有效性 | 创建订阅所需角色取决于通知类型（见第四节每类的角色） | S5 | `NTF_NO_DESTINATION`（接收端未配置：状态"未接入"，不创建订阅） | `notifications.subscriptions` | P1-21、P5-05 |
| I-23 | `Feeds API v2021-06-30`：批量刊登、批量价格修改 | `feeds.v2021` | `WorkflowRun`、`WorkflowStep`；原始上传与处理结果存对象存储并登记 `RawReportFile`；结果落 `ListingChangeEvent` | `(feedId)`；行级结果：`(feedId, messageId)` | 操作驱动；`FEED_PROCESSING_FINISHED` 触发取结果 | Amazon Fulfillment、Brand Analytics、Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking、Pricing、Product Listing、Selling Partner Insights、Tax Invoicing (Restricted) | S5 | `FEED_FATAL`、`FEED_PARTIAL`（部分失败：逐行展示原因）、`FEED_SWITCH_OFF` | `feeds.api` | P4-09、P4-11 |
| I-24 | `Uploads API v2020-11-01`：文件上传（A+ 图片） | `uploads.v2020` | 不独立落库，上传结果写入所属 A+ 内容草稿 | — | 操作驱动 | Product Listing | S5 | — | `uploads.api` | P4-14 |
| I-25 | `Sellers API v1`：参与的站点与账户信息 | `sellers.v1` | `PlatformConnection`、`ConnectionHealth`（现有模型） | `(sellerId)` | 授权完成时与每日 | Finance and Accounting、Product Listing、Selling Partner Insights（美国站可用的角色；其余角色仅限其他区域） | S2 | `SLR_NOT_US`（账户未参与美国站：状态"不适用"，不允许绑定） | `sellers.api` | P5-04 |
| I-26 | `Data Kiosk API v2023-11-15`：提交查询、查询状态、取结果文档（**取消查询暂未实现**：现有流程没有需要主动取消的场景，随需要它的页面操作再补，见 CR-021；具体数据集由 P2b-11 起注册） | `datakiosk.runner-v2023` | 见第二节两个数据集 | 见第二节 | 见第二节 | Brand Analytics（查询创建时按字段逐项校验角色） | S3 | `DK_QUERY_FAILED`、`DK_QUERY_CANCELLED`、`DK_FIELD_ROLE_DENIED`（某字段角色不足） | 见第二节 | P1-26 |

> **I-08 实现说明（P2a-08，CR-031）**：连接器 `apps/worker/src/connectors/awd-api.ts`，导入器 `apps/worker/src/importers/awd/`（`parse.ts`、`packages.ts`、`sync.ts`），写操作 `runtime/awd-workflow.ts` 与 `connectors/awd-dispatch.ts`。
> - 读：`listInventory`（分页，`details=SHOW`）、`listShipments`（按更新时间升序、`updatedAfter` 增量）、`getShipment`（`skuQuantities=SHOW`，取按 SKU 的预计与接收）、`getOrder`（按订单编号）；**官方没有“列出入库订单”的操作**，订单编号取自货件，另加我方已提交且未结束的订单（`DRAFT / VALIDATING / CONFIRMED`）逐个读取；单次最多翻 100 页、读 300 个明细，超出标 `incomplete`，下次继续。
> - 写：`createOrder`、`updateOrder`（PUT 整单覆盖）、`confirmOrder`、`cancelOrder`（确认与取消返回 204）、`updateTransport`；创建时每个包装必须有长宽高，预处理方与贴标方固定为卖家（`SELF`）；创建用我方参考号做对账，崩溃后可能留下亚马逊侧的孤儿草稿（见 CR-031）。
> - 标签：`getLabels` 异步生成，worker 取到 PDF 后存对象存储，页面只拿 5 分钟有效的签名链接。
> - “店铺没有开通上游仓储”只靠错误形状启发式识别（`isAwdNotEnrolled`：404，或 400 且文字含 enrol、onboard、not eligible 等），识别后记新鲜度 `NOT_APPLICABLE`，不写行；**403（缺角色）按错误处理，不当作未开通**；未调用官方“资格查询”接口。

---

> **I-06、I-07 实现说明（P2a-12，CR-035）**：同步任务类型 `FBA_INBOUND_SYNC`（进行中的计划，只拉当前阶段需要看的：装箱方案只在确认前，运输方案与送达时间窗只在分仓确认后、运输确认前），新鲜度来源 `inbound.plan`；操作任务 `FBA_INBOUND_OP`，14 种操作（资格预检、创建计划、生成与确认装箱方案、提交箱内物品、生成与确认分仓方案、生成运输方案、确认运输方案、生成与确认送达时间窗、回填追踪号、取消计划、取箱标签），每个操作一行 `InboundOperation`，状态为排队、亚马逊处理中、成功、失败、超时（15 分钟）。资格预检（I-06）与标签是只读调用，直接执行；其余写操作经 `INBOUND_PLAN_OP` 工作流提交（得到异步操作编号），再由监听器每 30 秒轮询到结果，成功后回写并同步计划，失败原样记下亚马逊的 `operationProblems`。资格预检按 ASIN 逐个查询，没有 ASIN 的 SKU 记 `ASIN_UNKNOWN`，非 401/403/429/5xx 的 4xx 记在该 SKU 上（`SP_API_<状态码>`），不当作同步失败。**已知缺口**：货件的接收数量与箱标签用 v0 接口（`getShipmentItems`、`getLabels`），2024-03-20 版没有对应读取；`inbound.eligibility`（I-06 的新鲜度来源）未单列，资格预检的时间随计划显示；货件时间线里“开始接收、接收完成”是同步时看到的时间（`OBSERVED`），不是亚马逊发生的时间；不合规问题报告（R-25）与赔付归 P2a-13、P2b-03。

> **R-25、入仓差异派生实现说明（P2a-13，CR-036）**：I-07 同步到已关闭的货件时调用 `deriveReceiving`（`importers/inbound/receiving-derive.ts`）：应发减已收，为正写 `SHORT`、为负写 `OVER`（缺任何一边数量不判），差异消失写 `resolvedAt`；少收在货件关闭满等待期（默认 45 天）后产出 `INBOUND_DISCREPANCY` 赔付机会（`dedupKey = 货件编号:SKU`），估算金额 = 少收数量 × 当前生效的 `CostVersion.unitProductCost`，没有成本时为空；过了申请期限（540 天）仍待处理的转为已过期，从没产出过的不补产出，人工处理过的状态不覆盖。派生出错只记警告，不拖垮计划同步。R-25 `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA` 现在同一遍扫描里写两处：财务费用事件（原有）与 `ReceivingDiscrepancy(kind=NONCOMPLIANCE)`（`importers/inbound/noncompliance-rows.ts`），每日申请最近 30 天窗口，新鲜度来源 `rpt.inbound-noncompliance`。**未验证**：报告的列名（`fba-shipment-id`、`sku`、`problem-type`、`issue-reported-date`、`fee-total`，数量列 `quantity` 等多个候选）按文档与既有费用导入器假设，没有真实报告样例与真实店铺实测；报告没有“已解决”列，不判断问题是否消除。

> **I-09 实现说明（P2a-14，CR-037）**：同步任务类型 `CATALOG_SYNC`（`importers/catalog/items-sync.ts`，接口封装 `connectors/catalog-api.ts`），新鲜度来源 `catalog.items-v2022`，阈值 24 小时。对店铺里每个 ASIN 取目录条目（每次最多 20 个标识，单店最多处理 20000 个商品），写回 `FbaProduct` 的图片、品牌、类目（两级）、父体、商品类型，并同步 `ProductVariantRelation` 与 `SalesRankSnapshot`（每个同步日一份）。目录没返回的 ASIN 标记 `catalogStatus=NOT_FOUND`（待核实），不清空已有数据；返回了但某字段缺失，保留原值；已有值与目录值不同且两边都有值时，往商品时间线写一条“亚马逊侧变更”事件（首次填入不算变更）；整批被拒（400）退化为逐个请求，其余错误原样抛出，交给任务运行时重试。定时：独立的每日定时器（不跟 6 小时全量同步一起跑），worker 启动 5 分钟后补跑一次；该连接上还有进行中的任务时本轮跳过。**与冻结的出入**：“新商品出现时即时补取”没有做（新商品要等下一轮每日同步，页面显示“商品目录尚未同步”）；P4-07 才会做目录的字段级内容对比。**未验证**：返回字段（`summaries`、`images`、`salesRanks`、`relationships`）与上限按官方接口模型核对，用夹具测试，没有对真实店铺实测；变更事件的发生时间是同步时间，不是亚马逊上实际变更的时间。**P4-03 补充（CR-078）**：请求的 `includedData` 增加 `attributes`，只读变体主题列出的那几个维度（颜色、尺码等）的取值，写入 `FbaProduct.variantAttributes`，其余属性不存；同步时再比较商品上一次与这一次的父体与变体属性，记 `EntityEvent`：`variation.child_added`、`variation.child_removed`（对象类型 `PARENT_ASIN`，对象编号是父体 ASIN）与 `variation.attribute_change`（对象类型 `ASIN`，对象编号是商品编号；属性只比较前后都有值的维度）。首次填入不记事件（商品没同步过目录时不记），所以“变体结构变更历史”从第二次同步起才有内容；事件幂等键 `catalog:<类型>:<ASIN>:<同步日>`，同一天重跑不重复。**未验证**：`attributes` 里变体维度的字段名按官方接口模型取，用夹具测试，没有对真实店铺实测。

> **R-03、R-05 实现说明（P2b-01，CR-039）**：两份报告都在 `apps/worker/src/importers/orders/fulfillment-reports.ts`（`fulfillmentImporterFor` 登记到 `connectors/report-import.ts`），每日申请最近 7 天窗口（`listeners/report-schedule.ts`），新鲜度来源 `rpt.fulfilled-shipments`（“亚马逊物流发货报告”）与 `rpt.shipment-replacement`（“替换订单报告”），阈值均 24 小时。**R-03** 写 `OrderPackage`：按订单号找到订单（订单还没同步下来的行跳过，下一次报告会补上），同一订单同一追踪号已有包裹（订单接口写的）就补充承运商、配送服务、配送中心、发货时间，没有就以发货编号为包裹编号新建；报告里的收件人、邮箱、地址等列**一概不读取**。**R-05** 把订单标成替换订单（`isReplacement`、`replacedOrderId`、`replacementReason`），找不到订单的行跳过。**与冻结的出入**：冻结幂等键 `(amazonOrderId, shipmentItemId, trackingNumber)` 实际落在 `OrderPackage` 的 `(sellerAccountId, orderId, packageId, trackingNumber)`，`packageId` 取发货编号；R-05 的唯一键没有单独建，更新是幂等的。**R-06（促销报告）没有做**，订单列表的“是否促销”筛选只按订单行上的促销折扣金额判断；**N-13（ORDER_CHANGE 推送）按 14.10 暂缓**，订单详情时间线只有订单接口同步留下的状态变化与包裹事件。**未验证**：两份报告的列名（`amazon-order-id`、`shipment-id`、`shipment-item-id`、`tracking-number`、`carrier`、`ship-service-level`、`fulfillment-center-id`、`shipment-date`，替换报告的原订单、替换订单、原因列）按官方文档与既有导入器假设，没有真实报告样例与真实店铺实测。

> **I-20 实现说明（P2b-04，CR-042）**：连接器 `apps/worker/src/connectors/support-api.ts`，解析 `importers/support/parse.ts`，同步 `importers/support/sync.ts`（夹具 `apps/worker/fixtures/support/`）；任务类型 `SUPPORT_SYNC`（`dispatch.ts` 分发），新鲜度来源 `support.api`（“支持案件”，阈值 2 小时），`listeners/schedules.ts` 每 2 小时一次，也随 6 小时全量同步。接口路径、参数与枚举对照亚马逊官方模型文件 `support_2025-02-01.json` 复核：**列出案件是 `POST /support/2025-02-01/cases`**（请求体含 `marketplaceId`，固定美国站，按创建时间从新到旧，每页 50 个，翻页带 `nextToken`），沟通是 `GET /cases/{caseId}/contacts`（每页 50 条，按创建时间从旧到新，可能返回空页但有 `nextToken`）。**与冻结的出入**：不调用 `getCase`（`listCases` 返回的案件已含状态、主题、创建与更新与解决时间、预约回电）。同步规则：案件最多翻 40 页（2000 个），沟通每次最多重取 100 个案件（未解决的优先、再按更新时间新到旧）、每案最多 500 条，触到上限标记为不完整（`incomplete`，下一次继续）；案件没变化不写（预约回电用 `canonicalize` 比较，因为 jsonb 会重排键）；沟通记录只在“案件更新时间与上次取沟通时不一致”时重取，按（案件、沟通编号）插入、已有的跳过；亚马逊不再返回的案件保留，不当作删除；某个案件的沟通取不到（400、404）跳过该案件并计数，其余错误原样抛出交给任务运行时重试。**受限角色未获批**：接口返回 403 时以不可重试的 `SUP_ROLE_PENDING` 结束，新鲜度状态为“未授权”，页面显示申请方式（`SUPPORT_ROLE_GUIDE`），赔付案件里的亚马逊案件编号仍可手工回填；`SUP_ROLE_PENDING` 不触发“同步失败”预警（多数店铺会长期处于这个状态，页面上已有说明）。不读取、不保存主邮箱、抄送邮箱、预约里的电话号码，附件只存名称。**未验证**：只对照了官方接口模型与夹具，没有真实店铺实测，也没有拿到过真实的 403 响应（“403 就是未获批受限角色”是按官方文档的推断，其他原因的 403 也会显示为未授权）；沟通渠道与发送方角色的取值按官方模型，亚马逊新增渠道时保留该条沟通、正文为空。

> **I-02、N-14 实现说明（P2b-05，CR-043）**：I-02 每条费用明细在写入时就分类（`classifyFeeLine`，契约 `fee-events.ts`；三个写入点——v2024 交易写入、月度仓储费报告、入仓不合规报告（R-25）——用同一个分类器，两份报告的行类型固定归类、不按文字猜），并带来源交易状态；重复写入只覆盖分类、状态、金额等来源字段，**从不覆盖人工对账字段**；增量后核对递延交易把“递延后已释放”同步到费用明细。N-14 `TRANSACTION_UPDATE`：处理器 `importers/finance/transaction-update.ts`，注册在 `importers/notifications/register.ts`；推送只当“有交易变化”的信号，不解析内容，给对应店铺排一个 `FBA_FINANCE` 同步任务（推送增量优先级；已有排队中的不重复排；入队失败时把任务标失败并抛错），新鲜度 `ntf.transaction-update`。**推送接收端按 14.10 暂缓，现在没有任何东西会把这类事件收进来，由每 6 小时的财务同步（前推 14 天重拉）兜底**；载荷里的店铺编号字段按官方文档整理、未经真实推送验证；所需角色仍未核实（G-04）。

## 二、数据中心数据集（`Data Kiosk API v2023-11-15`）

结果文档只保留 30 天，**当天必须落库**。美国站参数必传。

| 编号 | 数据集与查询 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 流式 | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|---|
| D-01 | `analytics_salesAndTraffic_2024_04_24`：`salesAndTrafficByDate`（日、周、月） | `dk.sales-traffic-by-date` | `SalesTrafficDaily` | `(date, granularity)` | 每日；近 7 天每日重拉以覆盖修正 | Brand Analytics | S3 | `DK_NO_BRAND`（未备案品牌：状态"未授权"） | `dk.sales-traffic.date` | P4-01、P4-02 |
| D-02 | 同上：`salesAndTrafficByAsin`（父体、子体、SKU 粒度） | `dk.sales-traffic-by-asin` | `SalesTrafficAsinDaily` | `(asin, asinGranularity, date)` | 每日；P4-01 实现（CR-076）：每次只查一天（不依赖官方是否支持按日拆分的参数），每个粒度每天重拉最近 3 天、第一次回补 7 天，更长的历史由 D-03 的 7 天与 90 天窗口承担 | Brand Analytics | S3 | 同上 | `dk.sales-traffic.asin` | P4-01、P4-03 |
| D-03 | 同上：`salesAndTrafficTrends`（ASIN 级趋势） | `dk.sales-traffic-trends` | `SalesTrafficAsinDaily`（趋势列） | `(asin, date)` | 每日；P4-01 实现（CR-076）：按“逐日、子体粒度”解读，一次查询一个窗口（有数据 7 天，第一次回补 90 天），写子体行并只更新官方给了值的列；**查询字段与返回结构未对真实店铺核对**（D-01、D-02 同） | Brand Analytics | S3 | 同上 | `dk.sales-traffic.trends` | P4-01 |
| D-04 | `analytics_economics_2024_03_15`：`economics`（销售、费用分项、广告、卖家提供的单位成本、净收益；按 MSKU 与日聚合） | `dk.economics` | `EconomicsDaily` | `(msku, date, aggregation)` | 每日；近 14 天重拉 | Selling Partner Insights | S3 | `DK_NO_COST_PROVIDED`（卖家未在后台提供成本：成本列为空并标注，不用 0 代替）；P2b-11 已实现（CR-049）：每个店铺每天一个查询，近 14 天重拉，第一次回补 90 天，定时只在生产环境；**查询字段与返回结构未对真实店铺核对** | `dk.economics` | P1-26、P2b-11 |
| D-05 | 同上：`economicsPreview`（未来最多 120 天的费用预估） | `dk.economics-preview` | `EconomicsPreview` | `(msku, feeType, rangeStart, rangeEnd)` | 每日一次，每个店铺一个查询（区间取 119 天；P2b-11 已实现，CR-049：每次查询带同一个 `queriedAt`，页面只看最近一次且 3 天内的，7 天前的旧行定时清理） | Selling Partner Insights | S3 | — | `dk.economics.preview` | P2b-06、P2b-11 |
| D-06 | 同上：`economicsSimulation`（按动作类型模拟，每次最多 100 个商品，最远 90 天） | `dk.economics-simulation` | `EconomicsSimulationRun` | `(runId)`（每次运行一条，保存入参与结果） | 按需（`POST /replenishment/simulate` 的 `AWD` 与 P2b-11 的 `POST /finance/economics/simulate`（`AWD` 或 `SIPP`，可带自定义单价），作业类型 `DATA_KIOSK_QUERY`，数据集编号 `dk.economics-simulation`；没有 `actionType` 参数的旧任务按 `AWD`；CR-049） | Selling Partner Insights（需“卖家洞察”角色） | S3 | `DK_SIM_LIMIT`（超过 100 个商品或 90 天：服务端先拦截）；实现：每次只查 1 个 MSKU，`sendToAWDQuantity` 为入参，行结果按 `msku\|startDate\|endDate` 累计进 `resultJson`，重试覆盖不翻倍；P2a-07 已实现（CR-030） | `dk.economics.simulation`（只记最近一次成功；P2a-07 未写，见 CR-030） | P2a-07、P2b-11 |

---

## 三、报告（02 章 2.3，共 42 个条目）

报告的创建与排程用 `Reports API v2021-06-30`；报告生成完成靠推送 `REPORT_PROCESSING_FINISHED`，接收端未配置时按退避轮询兜底。时间窗上限、`reportOptions` 以开工时官方当期文档为准（P1-26 复核并写入连接器常量）。
下表"频率"沿用 10.3 的"每日、按周、按月"。幂等键中的"行键"指由报告行的稳定业务列（SKU、FNSKU、日期、地点、处置状态、原因码、单据编号等）拼成的键，具体列在解析器测试夹具中固定。

### 3.1 订单与履约（7 个）

| 编号 | 报告类型 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|
| R-01 | `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` | `rpt.orders-by-order-date` | `Order`、`OrderItem`（与 I-01 同键，回补用） | 同 I-01 | 历史回补按需，按官方时间窗上限切片 | Amazon Fulfillment、Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking、Pricing | — | `rpt.orders.by-date` | P1-26、P2b-01 |
| R-02 | `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` | `rpt.orders-by-last-update` | `Order`、`OrderItem` | 同 I-01 | 每日对账（补偿以接口为主） | Amazon Fulfillment、Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking、Pricing、Product Listing | — | `rpt.orders.by-update` | P1-26、P2b-01 |
| R-03 | `GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL` | `rpt.fulfilled-shipments` | `OrderPackage`（承运商、追踪号、发货时间、配送中心） | `(amazonOrderId, shipmentItemId, trackingNumber)` | 每日 | Amazon Fulfillment、Inventory and Order Tracking、Pricing | — | `rpt.fulfilled-shipments` | P2b-01 |
| R-04 | `GET_AMAZON_FULFILLED_SHIPMENTS_DATA_TAX` | `rpt.fulfilled-shipments-tax` | `OrderCharge`（`chargeKind=TAX`） | `(amazonOrderId, shipmentItemId, taxKind)` | 每日 | Tax Remittance (Restricted) | `ROLE_MISSING`（受限角色未获批：税明细列显示"未授权"） | `rpt.fulfilled-shipments.tax` | P2b-12（**未做，CR-050**：冻结的落点 `OrderCharge(TAX)` 与销售税汇总页对不上，受限角色报告又没有真实样例，销售税页把“发货报告”标为“尚未接入”）|
| R-05 | `GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA` | `rpt.shipment-replacement` | `Order` 增加替换关联列（原订单编号、替换订单编号、替换原因码） | `(replacementOrderId, originalOrderId, sku)` | 每日 | Amazon Fulfillment | — | `rpt.shipment-replacement` | P2b-01 |
| R-06 | `GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_PROMOTION_DATA` | `rpt.shipment-promotion` | `OrderCharge`（`chargeKind=PROMOTION`） | `(amazonOrderId, shipmentItemId, promotionId)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.shipment-promotion` | P2b-01 |
| R-07 | `GET_FBA_FULFILLMENT_CUSTOMER_TAXES_DATA` | `rpt.customer-taxes` | `OrderCharge`（`chargeKind=TAX`） | `(amazonOrderId, shipmentItemId, taxKind)` | 每日 | Amazon Fulfillment、Tax Remittance (Restricted) | — | `rpt.customer-taxes` | P2b-12（**未做，CR-050**，原因同 R-04）|

### 3.2 库存、费用、移除（17 个）

| 编号 | 报告类型 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|
| R-08 | `GET_FBA_INVENTORY_PLANNING_DATA`（库龄分段、超额、7/30/60/90 天销量、建议动作、建议售价与促销天数、建议移除量、低库存水平费、最低库存水平、历史可售天数、季节性、建议发货量与日期、库龄附加费分段预估、长期仓储费、预留拆分） | `rpt.inventory-planning` | `InventoryPlanningSnapshot`（全字段）、`InventoryAgeSnapshot` | `(sku, fnsku, snapshotDate)` | 每日 | Amazon Fulfillment | — | `rpt.inventory-planning` | P2a-05、P2a-06 |
| R-09 | `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` | `rpt.myi-unsuppressed` | `InventoryDailySnapshot` | `(sku, fnsku, snapshotDate, source)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.myi-unsuppressed` | P2a-05 |
| R-10 | `GET_FBA_MYI_ALL_INVENTORY_DATA` | `rpt.myi-all` | `InventoryDailySnapshot` | 同 R-09 | 每日 | Amazon Fulfillment、Pricing | — | `rpt.myi-all` | P2a-05 |
| R-11 | `GET_AFN_INVENTORY_DATA` | `rpt.afn-inventory` | `InventoryDailySnapshot` | 同 R-09 | 每日 | Amazon Fulfillment | — | `rpt.afn-inventory` | P2a-05 |
| R-12 | `GET_LEDGER_DETAIL_VIEW_DATA` | `rpt.ledger-detail` | `InventoryLedgerEntry` | `(eventDate, fnsku, fulfillmentCenter, disposition, reasonCode, referenceId, 行序)` 哈希 | 每日 | Amazon Fulfillment | `LEDGER_NOT_BALANCED`（台账平衡校验不通过：保留数据并标记，生成预警） | `rpt.ledger-detail` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-13 | `GET_LEDGER_SUMMARY_VIEW_DATA` | `rpt.ledger-summary` | `InventoryLedgerSummary` | `(date, fnsku, fulfillmentCenter, disposition, aggregation)` | 每日 | Amazon Fulfillment | 同上 | `rpt.ledger-summary` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-14 | `GET_RESERVED_INVENTORY_DATA` | `rpt.reserved-inventory` | `InventoryDailySnapshot`（预留拆分列） | 同 R-09 | 每日 | Amazon Fulfillment、Pricing | — | `rpt.reserved-inventory` | P2a-05 |
| R-15 | `GET_STRANDED_INVENTORY_UI_DATA` | `rpt.stranded-inventory` | `InventoryDailySnapshot`（滞留数量、滞留原因列） | 同 R-09 | 每日 | Amazon Fulfillment、Pricing | — | `rpt.stranded-inventory` | P2a-05 |
| R-16 | `GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT` | `rpt.restock-recommendations` | `AmazonRestockRecommendation` | `(sku, fnsku, snapshotDate)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.restock-recommendations` | P2a-05、P2a-07 |
| R-17 | `GET_FBA_RECOMMENDED_REMOVAL_DATA` | `rpt.recommended-removal` | `InventoryPlanningSnapshot`（推荐移除列，标注来源为本报告） | `(sku, fnsku, snapshotDate)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.recommended-removal` | P2a-05、P2a-09 |
| R-18 | `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` | `rpt.removal-order` | `RemovalOrder` | `(orderId, sku, fnsku, disposition)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.removal-order` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-19 | `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` | `rpt.removal-shipment` | `RemovalShipment` | `(orderId, shipmentId, sku, fnsku)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.removal-shipment` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-20 | `GET_FBA_STORAGE_FEE_CHARGES_DATA`（月度仓储费，含仓储利用率与利用率附加费） | `rpt.storage-fee` | `StorageFeeRecord`（`feeKind=STORAGE`）、`StorageCapacitySnapshot`（利用率） | `(chargeMonth, fnsku, fulfillmentCenter, feeKind)`；利用率：`(chargeMonth, storageType)` | 每月（月结后每日检查是否已出） | Amazon Fulfillment、Pricing | — | `rpt.storage-fee` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-21 | `GET_FBA_OVERAGE_FEE_CHARGES_DATA` | `rpt.overage-fee` | `StorageFeeRecord`（`feeKind=OVERAGE`） | 同 R-20 | 每月 | Amazon Fulfillment | — | `rpt.overage-fee` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-22 | `GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA` | `rpt.longterm-storage-fee` | `StorageFeeRecord`（`feeKind=LONGTERM`） | 同 R-20 | 每月 | Amazon Fulfillment、Pricing | — | `rpt.longterm-storage-fee` | P2a-05（导入器）、P2a-09（页面与平衡校验） |
| R-23 | `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA`（预估配送费，费用核查基准） | `rpt.estimated-fba-fees` | `FeeBaseline`（配送费基准、测量尺寸与重量、尺寸分段；冻结写的是 `FeeAudit`，实现拆成基准表与结果表，见 CR-044） | `(sellerAccountId, sku, snapshotDate)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.estimated-fba-fees` | P2b-06（**已实现；列名按官方文档整理，未对真实报告核对**） |
| R-24 | `GET_REFERRAL_FEE_PREVIEW_REPORT`（佣金预览） | `rpt.referral-fee-preview` | `FeeBaseline`（售价与单件预估佣金，与 R-23 各写各的列） | `(sellerAccountId, sku, snapshotDate)` | 每日 | Finance and Accounting | — | `rpt.referral-fee-preview` | P2b-06（**已实现；列名按官方文档整理，未对真实报告核对**） |

### 3.3 入仓、售后、结算、刊登（9 个）

| 编号 | 报告类型 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|
| R-25 | `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA` | `rpt.inbound-noncompliance` | `ReceivingDiscrepancy`（`kind=NONCOMPLIANCE`） | `(shipmentId, sku, problemType, 报告行序)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.inbound-noncompliance` | P2a-13 |
| R-26 | `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | `rpt.customer-returns` | `FbaReturnCase`（现有模型，补退货明细列） | `(returnDate, orderId, sku, fnsku, licensePlateNumber)` | 每日 | Amazon Fulfillment、Pricing | — | `rpt.customer-returns` | P2b-02 |

> **P2b-07 实现说明（CR-045）**：R-28 已实现（`apps/worker/src/importers/finance/settlement-report.ts`）。**结算报告不能主动申请，只能列出已生成的**（G-05 的结论：Reports API 2021-06-30 `getReports`，`processingStatuses=DONE`，`createdSince` 最多 90 天，只用 nextToken 翻页），所以任务 `SETTLEMENT_SYNC` 是检索型：`connectors/settlement-api.ts` 列出 → `connectors/settlement-dispatch.ts` 跳过已导入 → 下载导入 → 导入后立刻核对（`settlements/run.ts`，另每 6 小时对近 120 天重算），每日一次，新鲜度来源 `rpt.settlement`。汇总行写 `FbaSettlement`（只写报告给了的列），明细行写 `SettlementLine`（键 `(settlementId, lineNo)`，行序号是数据行位置，明细行的结算单编号为空时沿用上一个汇总行）；**明细不写 `FbaFinancialTransaction`**。**列名与分类关键字没有对照真实报告**，缺少 `settlement-id` 列整份报告按格式变化失败。
>
> **P2b-03 实现说明（CR-041）**：R-27 已实现（`apps/worker/src/importers/reimbursements/report.ts`，`report-import.ts` 按 `REIMBURSEMENT_REPORT_TYPE` 精确分发），每日申请，窗口 30 天（`report-schedule.ts` 的 `windowed('GET_FBA_REIMBURSEMENTS_DATA', 30)`），登记新鲜度来源 `rpt.reimbursements`。用到的列名按官方文档假设：`reimbursement-id`、`approval-date`、`amount-total`（没有时用 `amount-per-unit` × `quantity-reimbursed-total`）、`quantity-reimbursed-total`、`sku`（或 `merchant-sku`）、`fnsku`、`asin`、`reason`、`currency-unit`（缺列时按 USD，**这是我们的假设**）、`amazon-order-id`、`case-id`；缺 `reimbursement-id`、`approval-date`、金额列任一整份报告失败；**没有真实报告样例，未对真实店铺实测**。幂等键即表里的 `(sellerAccountId, reimbursementId, sku, fnsku)`；重复导入只更新报告里有的列，**从不覆盖匹配结果**（`matchedCaseId`、`matchBasis`、`matchedAt`）。赔付明细没有对应案件时保留，页面显示在统计的“未归属赔付”里，给案件回填亚马逊案件编号后下一次匹配自动归属。匹配由后台每 3 小时一次的赔付扫描完成（`apps/worker/src/reimbursements/run.ts`，先匹配、再检测、再把过期机会标为已过期）：顺序为 案件编号一致 → 订单号与 SKU 一致且候选唯一 → SKU 一致且赔付原因关键字吻合且批准日不早于案件提交（前一天容差）且候选唯一，**候选不唯一或没有候选一律不猜**；案件实收 = 已匹配赔付明细金额合计，达到批准金额（没有批准金额则只要有实收）才标 `PAID`；匹配到案件的赔付明细同时回填案件缺失的亚马逊案件编号。机会识别 7 类中 6 类已产出（费用多收等 P2b-06），时限默认值见 `reimbursement-windows.ts`。

> **P2b-02 实现说明（CR-040）**：R-26 已实现（pps/worker/src/importers/returns/report.ts，
eport-import.ts 按 RETURNS_REPORT_TYPE 精确分发，替换了原先 	ype.includes('RETURNS') 的宽松匹配）。每日申请，窗口 30 天（
eport-schedule.ts 的 windowed(..., 30)），登记新鲜度来源 
pt.customer-returns。列名按官方文档假设：
eturn-date、order-id、sku、sin、nsku、product-name、quantity、ulfillment-center-id、detailed-disposition、
eason、status、license-plate-number、customer-comments；**没有真实报告样例，未对真实店铺实测**。缺 order-id 或 
eturn-date 列整份报告失败；行内没有退货日期的行跳过并计入跳过数，没有订单号的行忽略。幂等键即上表（sellerAccountId + 订单号 + ASIN + SKU + FNSKU + 退货件编号 + 退货时间，落在 FbaReturnCase_report_uq）。导入器**只写报告里有的列**：处置原值写 detailedDisposition、归并分组写 disposition，原因写 
eason，报告状态写 
eportStatus，买家备注（1000 字截断）**加密后写 customerCommentsCipher**（P6-14：与买家信息同一密钥与保留规则，同时记保留期与识别出的个人信息类别；没有加密能力或已过保留期就不写，不写明文；报告没给备注时不覆盖旧备注；详情只给状态，明文只经 `POST /pii/reveal`，不进日志与导出）；**从不覆盖** status、
eimbursementStatus、
eimbursementCaseId、
efundAmount（报告没有退款金额，退款金额一律来自财务交易）。
| R-27 | `GET_FBA_REIMBURSEMENTS_DATA`（赔付明细） | `rpt.reimbursements` | **`ReimbursementRecord`（缺口，见第九节 G-01）**；匹配后回写 `ReimbursementCase` 实收金额 | `(reimbursementId, sku, fnsku)` | 每日 | Amazon Fulfillment、Pricing | `REIMB_UNMATCHED`（无对应案件：保留记录，进入"未归属赔付"待办，不丢弃） | `rpt.reimbursements` | P2b-03 |
| R-28 | `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`（唯一结算格式） | `rpt.settlement-v2` | `FbaSettlement`（结算汇总）、`FbaFinancialTransaction`（`source=SETTLEMENT`） | 汇总：`(settlementId)`；明细：`(settlementId, 行序)` | 每日检索新结算（结算期结束后出现） | Finance and Accounting | `SETTLEMENT_NOT_GENERATED`（结算期未结束：不是失败，状态保持"等待结算"） | `rpt.settlement` | P2b-07 |
| R-29 | `GET_MERCHANT_LISTINGS_ALL_DATA` | `rpt.listings-all` | `ListingSnapshot` | `(sellerSku, snapshotDate)` | 每日 | Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking、Pricing、Product Listing | — | `rpt.listings-all` | P4-09 |
| R-30 | `GET_MERCHANT_LISTINGS_INACTIVE_DATA` | `rpt.listings-inactive` | `ListingSnapshot`（状态=非活跃） | 同 R-29 | 每日 | Inventory and Order Tracking、Pricing、Product Listing | — | `rpt.listings-inactive` | P4-09 |
| R-31 | `GET_MERCHANT_CANCELLED_LISTINGS_DATA` | `rpt.listings-cancelled` | `ListingSnapshot`（状态=已取消） | 同 R-29 | 每日 | Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking、Pricing、Product Listing | — | `rpt.listings-cancelled` | P4-09 |
| R-32 | `GET_MERCHANTS_LISTINGS_FYP_REPORT`（被搜索抑制的商品） | `rpt.listings-fyp` | `ListingIssue`（`issueKind=SEARCH_SUPPRESSED`） | `(sellerSku, issueCode)` | 每日 | Product Listing | — | `rpt.listings-fyp` | P4-10 |
| R-33 | 销售税：`GET_FLAT_FILE_SALES_TAX_DATA`（**不可 `createReport`，不可排程**；由卖家在后台"税务文档库"生成，用 `getReports` 按类型检索；美国站、卖家、制表符分隔、内容每日更新、保留期最长 90 天） | `rpt.sales-tax-flat` | `SalesTaxSummary`（按州汇总；订单接口 `TAX` 数据另列标注来源） | `(taxPeriod, state, jurisdictionKey, taxKind)` | **检索模式**：每日检索新生成的报告；检索不到则状态"待生成" | Tax Remittance (Restricted) | `TAX_NOT_GENERATED`（税务文档库尚未生成：页面提示"需在卖家后台税务文档库先生成报告"，不伪造数据）、`ROLE_MISSING`（页面显示"未授权：需申请受限角色"） | `rpt.sales-tax` | P2b-12（**已实现，CR-050；列名按官方文档与同类报告惯例整理，未对真实报告核对**：任务 `TAX_SYNC` 每日检索 + 启动后 12 分钟一次，共用 `connectors/report-retrieval.ts`（与结算报告同一套检索逻辑）；导入器 `importers/tax/sales-tax-report.ts` 按（报告日期、州、辖区、税种）汇总，**`taxPeriod` 存日不是月**，同事务先删后写所以重复导入不翻倍，缺州、税额、日期的行跳过，不读订单号与收货地址；失败码用 `TAX_ROLE_PENDING`（403，状态“未授权”）与 `TAX_NOT_GENERATED`（90 天内没有报告，状态“等待依赖”），都不触发同步失败预警；`SalesTaxSummary` 只存 `TAX_LIBRARY` 来源，订单接口的税读取时从 `OrderCharge` 现算）|

### 3.4 业务报告、品牌分析、促销、账户（9 个）

| 编号 | 报告类型 | 解析器 | 目标表 | 幂等键 | 频率 | 所需角色（至少其一） | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|
| R-34 | `GET_SALES_AND_TRAFFIC_REPORT`（数据中心的补充来源） | `rpt.sales-traffic` | `SalesTrafficDaily`、`SalesTrafficAsinDaily`（标注来源为补充，与 D-01、D-02 同键，数据中心优先，差异写核对记录） | 同 D-01、D-02 | 每日 | Brand Analytics | `ST_SOURCE_DIFF`（与数据中心差异超阈值：只记录，不覆盖）；P4-01 实现（CR-076）：JSON 报告，只给数据中心已有数据的店铺每天申请昨天（UTC 日）一整天；整份作为一条记录读入，超过 500 万字符以明确错误失败；ASIN 部分没有日期列，只在窗口恰好一天时导入；差异记在 `SalesTrafficDiff`（相对差异超过 2% 且绝对差异超过 1 才记）；**字段名未对真实店铺核对** | `rpt.sales-traffic` | P4-01 |
| R-35 | `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` | `rpt.ba-search-query-performance` | 品牌分析表 1（命名在 `models.md` 定稿） | `(reportPeriod, periodStart, asin, searchQuery)` | 按周、按月 | Brand Analytics | `BA_NO_BRAND`（无品牌备案：状态"不适用"，页面显示前提） | `rpt.ba.search-query` | P4-04 |
| R-36 | `GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT` | `rpt.ba-search-catalog-performance` | 品牌分析表 2 | `(reportPeriod, periodStart, asin)` | 按周、按月 | Brand Analytics | 同上 | `rpt.ba.search-catalog` | P4-04 |
| R-37 | `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` | `rpt.ba-search-terms` | 品牌分析表 3 | `(reportPeriod, periodStart, searchTerm, rank)` | 按周、按月 | Brand Analytics | 同上 | `rpt.ba.search-terms` | P4-04 |
| R-38 | `GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT` | `rpt.ba-market-basket` | 品牌分析表 4 | `(reportPeriod, periodStart, asin, pairedAsin)` | 按周、按月 | Brand Analytics | 同上 | `rpt.ba.market-basket` | P4-04 |
| R-39 | `GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT` | `rpt.ba-repeat-purchase` | 品牌分析表 5 | `(reportPeriod, periodStart, asin)` | 按周、按月 | Brand Analytics | 同上 | `rpt.ba.repeat-purchase` | P4-04 |
| R-40 | `GET_PROMOTION_PERFORMANCE_REPORT`（含促销接口映射编号） | `rpt.promotion-performance` | `PromotionMetric` | `(promotionId, asin, metricDate)`；映射编号用于关联 `Promotion` | 每日 | Brand Analytics、Selling Partner Insights | — | `rpt.promotion-performance` | P4-05 |
| R-41 | `GET_COUPON_PERFORMANCE_REPORT` | `rpt.coupon-performance` | `CouponMetric` | `(couponId, metricDate)` | 每日 | Brand Analytics | — | `rpt.coupon-performance` | P4-05 |
| R-42 | `GET_V2_SELLER_PERFORMANCE_REPORT`（账户健康各项指标） | `rpt.seller-performance` | `AccountHealthSnapshot`、`PolicyIssue` | `(snapshotDate, metricKey)`；问题：`(issueId)` | 每日；推送 `ACCOUNT_STATUS_CHANGED` 触发即时刷新（**P5-02 已实现每日报告（CR-092）；推送触发的即时刷新随推送接收端按 14.10 暂缓**；报告格式按通用方式解析，未用真实店铺核对） | Selling Partner Insights | — | `rpt.seller-performance` | P5-02 |

> **I-17、R-40、R-41 实现说明（P4-05，CR-080）**：代码在 `apps/worker/src/importers/promotions/`（`parse.ts` 解析、`sync.ts` 同步器、`reports.ts` 两个报告导入器）与 `connectors/promotions-api.ts`。**I-17**（任务 `PROMOTIONS_SYNC`，随生产同步每 24 小时一次，启动后 14 分钟首次）：只调 `searchPromotions` 与 `getSelection`——搜索结果已含全部促销字段，不再逐个调 `getPromotion`；回看 400 天内开始的促销，每次最多搜索 10 页（每页 100 个）；清单只在“促销更新时间与上次取清单时不一致”或版本号变化时重取，每次最多重取 15 个促销（进行中与即将开始优先，再按开始时间新到旧），每个最多 5 页，超出标“商品清单不完整”；`CATALOG` 类型（整个目录参与）没有清单，只记类型；清单整份取回后才先删后写，取不全不会留下半份；促销本身没变（含状态）就不写；403 → 不可重试的 `ROLE_MISSING`（新鲜度“未授权”，页面给申请方式），单个促销取清单遇 400、404 跳过，其余错误交任务运行时分类重试；亚马逊不再返回的促销保留（历史记录），不删除。新鲜度来源 `promotions.api`，阈值 24 小时。**R-40、R-41**：每日申请最近 30 天窗口（`listeners/report-schedule.ts`），导入器按表头别名识别列，**认不出必需列时整份以 `PARSE_HEADER` 失败**；R-40 一行 = 映射编号 × ASIN × 日，R-41 一行 = 映射编号 × 日；`--`、空值存空（不是 0），整行都没有指标的行跳过，日期不合法的行跳过；重复导入按唯一键覆盖。新鲜度来源 `rpt.promotion-performance`、`rpt.coupon-performance`，阈值 24 小时。**未验证**：报告的列名、粒度与“映射编号 = 促销接口 `trackingId`”这个关联键都没有真实报告样本核对（`verification-log.md` 11.3）。

> **I-10、I-11、I-23、R-32、N-08 至 N-12 实现说明（P4-10，CR-085）**：代码在 `apps/worker/src/importers/listings/`（`items-parse.ts` 解析、`items-sync.ts` 同步器、`fyp-report.ts` 报告导入器、`notifications.ts` 推送处理器、`write-parse.ts` 校验与批量结果解析）、`connectors/listings-api.ts`、`feeds-api.ts`、`listing-dispatch.ts` 与 `runtime/listing-write-workflow.ts`。**I-10**（任务 `LISTING_SYNC`，每 24 小时一次，启动后 16 分钟首次，不随 6 小时全量同步）：只调 `searchListingsItems`（美国站，取摘要与问题，每页 20 个，每次最多 500 页）；**翻不完标“未完成”，这一轮不做“消失即解决”的整体对账**（没读到不等于已解决）；问题按 `(店铺, SKU, 类型, 代码, 属性)` 幂等，仍然存在更新最后出现时间、消失写解决时间、再出现重开；状态变化重置 `statusSince`；标题、主图、商品类型两边都有值且不同才记变更，首次填入不算；403（缺“商品刊登”角色）以不可重试的 `LISTING_ROLE_MISSING` 结束。新鲜度来源 `listings.items-v2021`，阈值 24 小时。**R-32**：每日申请 `GET_MERCHANTS_LISTINGS_FYP_REPORT`，认不出 SKU 列（别名都对不上）时整份以 `PARSE_HEADER` 失败并留存原始文件；只有表头没有数据行表示“当前没有被搜索抑制的商品”，会把此前的抑制全部标为已解决。新鲜度来源 `rpt.listings-fyp`，阈值 24 小时。**I-11**：只读，逐个 ASIN 查询，结果写在任务记录里，1 小时过期，不落独立业务表；**I-12（商品类型定义）本包没有实现**，商品类型取自 I-10 同步下来的值，批量任务里没有商品类型的商品被拒绝（422）。**I-23**：批量任务建输入文件（`JSON_LISTINGS_FEED`）、上传、创建任务后**立刻把任务编号写回记录**，重放时看到编号就沿用；**结果取回用后台每 30 秒轮询一次（最多 240 次），不是等推送 `FEED_PROCESSING_FINISHED`**；整份被拒绝或取消是 `FEED_FATAL`，逐商品有错误是部分成功（`PARTIAL`，逐行展示原因），轮询超时是 `FEED_TIMEOUT`（亚马逊那边可能仍在处理）；原始上传与处理结果文件**没有**登记 `RawReportFile`（没有留存，只保存解析后的逐商品结果）。**N-08、N-09、N-10、N-12** 的处理器已注册，**推送接收端按 14.10 暂缓，没有接收端就不会有事件进来，页面的推送区一律写“尚未接入”**；N-11（商品类型定义变更）要刷新的缓存没有实现，不注册处理器。**每日同步之外没有任何实时通道**：“他人内容修改”页签只来自每日同步对标题与主图的比对。限速：沿用 SP-API 客户端按店铺的通用限速与 429 重试，**没有为这几组接口单独配置官方公布的速率**；**所有路径、参数与响应字段都是依据亚马逊官方文档整理，没有用真实店铺响应核对**（见 CR-085 未验证清单）。

> 3.1 至 3.4 合计：7 + 17 + 9 + 9 = **42 个报告类型条目**。02 章 2.3 表内列举的明确类型共 41 个（订单 7、库存 17、入仓 1、售后 2、结算 1、刊登 4、业务报告 1、品牌分析 5、促销 2、账户 1），另加本次确定类型的销售税报告 1 个（R-33），合计 42。已用脚本逐个类型核对，无遗漏。

---

## 四、推送（02 章 2.4）

接收端（亚马逊消息队列到我方）属部署专项，暂缓；**监听器代码、解析器、测试夹具在工作包内完成**。接收端未配置期间，各推送类来源的新鲜度状态为"未接入"，页面按 14.10 显示正式空状态并退化为报告数据。

幂等：`AmazonNotificationEvent` 以 `(notificationId)` 唯一（亚马逊通知元数据里的通知编号），重复投递直接丢弃；小时级事件允许延迟最长 24 小时的补发，按 `(asin, hourStart)` upsert，`sourceUpdatedAt` 较新者覆盖。

| 编号 | 推送类型 | 解析器 | 目标表 | 业务幂等键 | 频率 | 所需角色（至少其一） | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|
| N-01 | `ITEM_SALES_EVENT_CHANGE` | `ntf.item-sales` | `HourlySalesEvent` | `(asin, hourStart)` | 每小时 | Brand Analytics | `NTF_SCHEMA`（消息体结构变化：保留原文入死信，不丢） | `ntf.item-sales` | P2a-03 |
| N-02 | `DETAIL_PAGE_TRAFFIC_EVENT` | `ntf.page-traffic` | `HourlyTrafficEvent` | `(asin, hourStart)` | 每小时 | Brand Analytics | 同上 | `ntf.page-traffic` | P2a-03 |
| N-03 | `ITEM_INVENTORY_EVENT_CHANGE` | `ntf.item-inventory` | `HourlyInventoryEvent` | `(asin, hourStart)` | 每小时 | Brand Analytics | 同上 | `ntf.item-inventory` | P2a-03 |
| N-04 | `FBA_INVENTORY_AVAILABILITY_CHANGES` | `ntf.fba-inventory` | 快照写 `InventoryDailySnapshot`（只更新当日 API 来源行的可售数量；完整数量由每 30 分钟的 I-05 补齐，**未**单独触发刷新，见 CR-028） | `(sku, snapshotAt)` | 变化时 | Amazon Fulfillment | 同上 | `ntf.fba-inventory` | P2a-05 |
| N-05 | `ANY_OFFER_CHANGED` | `ntf.any-offer` | `CompetitiveOffer`、`BuyBoxSnapshot` | `(asin, offerKey, observedAt)` | 变化时 | Pricing | 同上 | `ntf.any-offer` | P4-11、P4-12 |
| N-06 | `PRICING_HEALTH` | `ntf.pricing-health` | `BuyBoxSnapshot`（失去推荐报价资格标记）；生成预警实例 | `(sku, observedAt)` | 变化时 | Pricing | 同上 | `ntf.pricing-health` | P4-11、P4-15 |
| N-07 | `FEE_PROMOTION` | `ntf.fee-promotion` | `EntityEvent`（费用变化提醒） | `(promotionKey, sku)` | 变化时 | Finance and Accounting、Product Listing | 同上 | `ntf.fee-promotion` | P2b-06 |
| N-08 | `LISTINGS_ITEM_STATUS_CHANGE` | `ntf.listings-status` | `ListingChangeEvent`；触发 I-10 回读 | `(sellerSku, occurredAt)` | 变化时 | Product Listing | 同上 | `ntf.listings-status` | P4-09、P4-10 |
| N-09 | `LISTINGS_ITEM_ISSUES_CHANGE` | `ntf.listings-issues` | `ListingIssue`；触发 I-10 回读 | `(sellerSku, issueCode, attributeName)` | 变化时 | Product Listing | 同上 | `ntf.listings-issues` | P4-10 |
| N-10 | `ITEM_PRODUCT_TYPE_CHANGE` | `ntf.item-product-type` | `ListingChangeEvent` | `(asin, occurredAt)` | 变化时 | Pricing（仅北美）、Product Listing | 同上 | `ntf.item-product-type` | P4-10 |
| N-11 | `PRODUCT_TYPE_DEFINITIONS_CHANGE` | `ntf.product-type-definitions` | 触发 I-12 刷新缓存 | `(productType, version)` | 变化时 | Product Listing | 同上 | `ntf.product-type-definitions` | P4-10 |
| N-12 | `BRANDED_ITEM_CONTENT_CHANGE` | `ntf.branded-content` | `ListingContentSnapshot`、`ListingChangeEvent`（标注是否本人修改）；触发预警 | `(asin, fieldPath, occurredAt)` | 变化时 | Product Listing | 同上 | `ntf.branded-content` | P4-09、P4-15 |
| N-13 | `ORDER_CHANGE` | `ntf.order-change` | 触发 I-01 单订单回读；`OrderStatusHistory` | `(amazonOrderId, status, occurredAt)` | 变化时 | Amazon Fulfillment、Direct to Consumer Shipping (Restricted)、Inventory and Order Tracking | 同上 | `ntf.order-change` | P2b-01 |
| N-14 | `TRANSACTION_UPDATE` | `ntf.transaction-update` | 触发 I-02 增量拉取 | `(transactionId)` | 变化时 | 官方未逐类型列出（订阅时按"该通知类型关联角色"校验），**实测核对**，预计为 Finance and Accounting | 同上 | `ntf.transaction-update` | P1-26、P2b-05 |
| N-15 | `REPORT_PROCESSING_FINISHED` | `ntf.report-finished` | 推进对应报告任务 | `(reportId)` | 报告完成时 | 任一报告角色 | 同上 | `ntf.report-finished` | P1-20、P1-21 |
| N-16 | `FEED_PROCESSING_FINISHED` | `ntf.feed-finished` | 推进对应批量任务 | `(feedId)` | 完成时 | 任一批量任务角色 | 同上 | `ntf.feed-finished` | P4-09 |
| N-17 | `ACCOUNT_STATUS_CHANGED` | `ntf.account-status` | `AccountHealthSnapshot`；生成预警实例 | `(occurredAt, statusTo)` | 变化时（**P5-02 已实现处理器（CR-092）并登记，推送接收端未建（14.10 暂缓），目前没有真实推送进来**；预警由预警引擎读快照评估，不在处理器里直接生成实例） | Selling Partner Insights | 同上 | `ntf.account-status` | P5-02 |
| N-18 | `SHIPMENT_TRACKING_MILESTONE_CHANGED` | `ntf.shipment-tracking` | `TrackingEvent` | `(trackingIdentifier, milestone, occurredAt)` | 变化时 | 无需授权（grantless） | 同上 | `ntf.shipment-tracking` | P2a-11、P2a-13 |

---

## 五、广告（02 章 2.5）

广告是**独立授权体系**（`AdsProfile`），不使用卖家接口的角色；"所需角色"一栏改写为"所需授权"。统一接口的账户头为 `Amazon-Ads-AccountId`，旧接口为 `Amazon-Advertising-API-Scope`，**二者不能同时发送**；`AdsProfile` 同时保存两种编号。

| 编号 | 来源 | 解析器 | 目标表 | 幂等键 | 频率 | 所需授权 | 流式 | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|---|
| A-01 | `Amazon Ads API v1`（`/adsApi/v1`）：广告活动、广告组、广告、投放对象、广告关联、广告扩展、品牌旗舰店、活动预测、推荐 | `ads.entities-v1` | `AdsCampaign`、`AdsPortfolio`、`AdsAdGroup`、`AdsAd`、`AdsTarget`、`AdsKeyword`、`AdsNegativeTarget`、`AdsCreative`、`AdsEntitySnapshot`、`AdsRecommendation`、`AdsForecastRun` | 各实体：`(adsAccountId, entityType, entityId)`；快照：`(entityType, entityId, snapshotAt)` | 每 2 小时；写操作后立即刷新 | 广告账户授权（读取、写入范围） | S2 | `ADS_ACCOUNT_UNBOUND`（广告账户未绑定店铺：只在广告连接页可见，不进入业务页）、`ADS_EXTERNAL_CHANGE`（识别到外部修改：写 `AdsChangeLog`，不算失败）、`ADS_SWITCH_OFF`（对应开关关闭，仅预览） | `ads.entities` | P3-01、P3-02、P3-03 |
| A-02 | `Reporting API v1`（`/adsApi/v1/create/reports`、`/adsApi/v1/retrieve/reports`）：自由组合维度与指标，跨广告产品；按流量日期归因；返回警告信号 | `ads.reports-v1` | `AdsMetric`（日）、`AdsTermMetric`（词级）、`AdsPlacementMetric`、`AdsAdvertisedProductMetric`、`AdsConvertedProductDaily` | 日指标：`(entityType, entityId, date)`；词级：`(campaignId, targetId, searchTerm, date)`；位置：`(campaignId, placement, date)`；商品：`(campaignId, advertisedAsin, date)` | 每日；**近 3 天每日重拉**，覆盖归因回补；历史回补按 120 天切片 | 广告账户授权（读取） | S1 | `ADS_WARNING_SIGNAL`（报告返回警告信号：保存信号并在页面角标提示，数据照常入库）、`ADS_REPORT_WINDOW`（超出单报告窗口上限：前端先拦截） | `ads.reports` | P3-01、P3-15 |
| A-03 | `Amazon Marketing Stream v2`：`ads-performance-v1`（小时级，约 400 项指标、50 余个维度）、`ads-converted-product-v1`（日级，ASIN 级转化，含光环销售）；订阅后回补 70 天；投递到我方存储桶并发队列通知；不含预算消耗与实体变更数据集；投放对象只带编号；低于阈值的搜索词归为"其他" | `ads.stream-performance`、`ads.stream-converted` | `AdsPerformanceHourly`、`AdsConvertedProductDaily` | `(entityType, entityId, hourStart)`；转化：`(campaignId, advertisedAsin, purchasedAsin, date)` | 最快每 15 分钟；**接收端暂缓** | 广告账户授权（数据流订阅） | S7 | `STREAM_NO_SINK`（接收端未配置：状态"未接入"）、`STREAM_ID_UNRESOLVED`（投放对象只带编号：先靠 A-01 解析名称，解析不到的显示编号） | `ads.stream` | P3-06 |
| A-04 | 旧版并行核对：商品推广第三版、品牌推广第四版、展示型推广、报告第三版、营销数据流第一版 | `ads.legacy-compare` | 仅写核对记录（不新增业务数据依赖） | `(compareDate, entityType, metricKey)` | 迁移期每日 | 同旧授权 | S1 | `ADS_LEGACY_DIFF`（按"时间口径、归因口径、范围、未解释"四类记录） | `ads.legacy-compare` | P3-01 |

> 旧版接口于 2027 年 6 月 30 日停止，A-04 在核对通过后关闭；亚马逊广告智能体服务（开放测试）不纳入生产。

> **A-01、A-02 实现说明（P5-12A，CR-104）**：代码在 `apps/worker/src/ads-entities/`（`sync.ts` 同步器、`map.ts` 字段映射、`write.ts` 幂等写入、`archive.ts` 对账归档、`accounts.ts` 账户发现、`schedule.ts` 排程、`dispatch.ts` 任务分发）与 `ads-reports/auto-schedule.ts`，契约在 `packages/api-contracts/src/ads-sync.ts`。**A-01 只实现了七类实体**：`AdsCampaign`、`AdsAdGroup`、`AdsAd`、`AdsKeyword`、`AdsTarget`、`AdsNegativeTarget`、`AdsPortfolio`；上表里的 `AdsCreative`、`AdsEntitySnapshot`、`AdsRecommendation`、`AdsForecastRun`、广告扩展、品牌旗舰店、活动预测与推荐**没有同步器**（变更记录的对比快照仍由原有流程生成）。任务 `ADS_ENTITY_SYNC` 按广告档案各跑一个，来源键 `ads.entities-v1`，每 2 小时排一次（企业可放慢或暂停，不能更快），统一接口账户编号由档案同步后的账户发现填入，缺编号以“等待依赖”收场；**本包没有新增“写操作后立即刷新”**，写入后的本地回写沿用 P3-17。每批最多 500 个对象一个事务，按对象编号幂等，只更新确有变化的列，亚马逊没给的字段不覆盖；本轮没读到的对象归档（否定投放删除本地行），分页没翻完、返回为空而本地有行、一次要归档超过一半且不少于 20 行时都不归档。**A-02 没有新的导入器**，只新增每 6 小时一次的自动排程，复用既有 `ADS_REPORT_V1` 的创建、轮询与落库：商品推广 8 个模板，其他产品只排活动日报；模板满 20 小时、失败或停滞超过 12 小时重排，首次回看 30 天（小时级 14 天）、之后每次最近 3 天（冻结写的“历史回补按 120 天切片”没有自动执行，仍是手动回补）；定时报告请求编号为 `schedule`，只有定时报告记入新鲜度 `ads.reports-v1`（阈值 1440 分钟）。**接口路径、字段与限速都是依据官方文档整理，没有用真实广告账户核对**（见 CR-104 未验证清单）。

---

## 六、文件导入（没有官方来源的数据）

只用于方案已确认"文件导入并标注来源"的数据。导入文件不允许来自抓取亚马逊前台；每个字段落库时记录 **来源（文件）、采集日期、导入人、文件哈希**，页面同位置标注。需要权限 `data.import`。

| 编号 | 数据 | 解析器 | 目标表 | 幂等键 | 文件模板 | 失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|
| F-01 | 平均星级与评分数（官方无接口） | `file.review-metrics` | `ReviewMetricSnapshot`（字段级标注来源） | `(asin, captureDate, metricKey)` | 列：ASIN、采集日期、平均星级、评分数、星级分布（可选）；模板在页面下载 | `FILE_COLUMN_MISSING`、`FILE_VALUE_RANGE`（星级超出 1 至 5）、`FILE_DUPLICATE` | `file.review-metrics` | P4-13 |
| F-02 | 仓储限额（来自卖家后台"库容管理"导出） | `file.storage-capacity` | `StorageCapacitySnapshot` | `(captureDate, storageType)` | 列：存储类型、限额、已用、采集日期 | 同上 | `file.storage-capacity` | P2a-09 |
| F-03 | 货代节点与承运商追踪号（`Tracking API` 不覆盖入仓货件时的补充） | `file.forwarder-milestones` | `FirstMileMilestone`、`TrackingEvent` | `(shipmentRef, milestone, occurredAt)` | 列：头程单号、节点、发生时间、地点、备注 | 同上 | `file.forwarder-milestones` | P2a-11 |
| F-04 | 商品成本与采购单据批量导入（我方录入的批量形式） | `file.costs-bulk` | `CostVersion`（草稿，需确认后生效） | `(sku, effectiveFrom, versionNo)` | 列：SKU、生效日期、币种、单价、附加成本 | 同上 | `file.costs-bulk` | P2b-14 |

> F-04 不是"没有官方来源的亚马逊数据"，而是我方录入的批量形式，随工作包 P2b-14 落地；列出是为了让所有文件入口有统一预检、统一权限和统一审计。
>
> **F-04 实现说明（P2b-14，CR-052）**：由 API 直接解析，不经 worker：POST /costs/import 收浏览器读出的 CSV 文本（含文件名，最大约 200 KB、500 行，COST_IMPORT_COLUMNS 列出中英文表头：SKU、生效日期、币种必填，采购单价、头程分摊、关税、其他成本至少填一项，备注可选），**逐行校验，一行有错整份拒绝**（错误按行号返回，页面显示在文件下面），通过后写成 FILE_IMPORT 草稿（sourceDocId = IMP<8 位十六进制>:<行号>，同一文件重复提交会生成新的草稿，不去重），确认生效在商品成本页。只认 CSV 文本（按表头判断逗号、分号或制表符分隔），不认 Excel。预检、权限（costs.write 且范围为全部店铺）与审计（COST_VERSIONS_IMPORTED）沿用写接口的统一机制；**没有走 data.import 权限与通用文件预检**，也没有签名直传。

> **P2a-11 实现说明（CR-034）**：F-03 在 API 里直接解析，不走 worker 任务：`POST /first-mile/:id/milestones/import`（权限 `firstmile.write`），浏览器读出 CSV 或制表符文本后提交 `{ version, fileName, content }`。表头中英文都认（头程单号、节点、发生时间、地点、备注），货代的节点叫法按别名归到常用节点（认不出的原样保留）；发生时间不带时区按北京时间（UTC+8）解释，带 `Z` 或偏移的按其所带；头程单号必须等于该运单的运单号，**一行有错整份拒绝**（错误挂在 `fieldErrors.content`，至多 10 条）；与已有记录重复（同节点同时间）的行跳过并计数；每条记录的 `source = FILE_IMPORT`，文件名随响应与审计记录。**目标表只有 `FirstMileMilestone`**：`TrackingEvent` 与 I-21、N-18（Tracking API 与推送）本包没有做（见 CR-034 的“偏离”），文件导入也没有单独的新鲜度键与文件哈希。

---

## 七、汇率与其他内部来源

| 编号 | 来源 | 解析器 | 目标表 | 幂等键 | 频率 | 所需授权 | 流式 | 专属失败码 | 新鲜度键 | 工作包 |
|---|---|---|---|---|---|---|---|---|---|---|
| X-01 | 汇率主源（见决策点 D-01）与备源；美元为基准；Frankfurter v2 接口（`/v2/rate/usd/cny` 与按提供方的 `/v2/providers/cfets/rate/usd/cny`） | `fx.daily` | `FxRate`、`FxSourceConfig` | `(baseCurrency, quoteCurrency, rateDate, source)` | 每日 | 无（公开接口） | S2 | `FX_PRIMARY_DOWN`（主源失败：回退备源并标记"回退"）、`FX_ALL_DOWN`（全部失败：沿用上一个有效日汇率并标记"沿用"，关账检查视为"汇率不齐全"） | `fx.daily` | P1-28、P2b-13 |

---

## 八、禁用清单（已被官方移除，系统不得再使用）

| 报告类型 | 说明 | 代码层处理 |
|---|---|---|
| `GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA` | 旧库存报告 | 连接器常量表不含；创建时报 `REPORT_TYPE_REMOVED` |
| `GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA` | 旧库存调整 | 同上（由台账 R-12、R-13 取代） |
| `GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA` | 旧库存接收 | 同上（由台账与入仓接口取代） |
| `GET_FBA_FULFILLMENT_INVENTORY_SUMMARY_DATA` | 旧库存汇总 | 同上（由台账 R-13 取代） |
| `GET_FBA_FULFILLMENT_MONTHLY_INVENTORY_DATA` | 旧月度库存 | 同上 |
| `GET_FBA_RECONCILIATION_REPORT_DATA` | 旧对账 | 同上 |
| `GET_FBA_INVENTORY_AGED_DATA` | 旧库龄 | 同上（由 R-08 取代） |
| `GET_EXCESS_INVENTORY_DATA` | 旧超额库存 | 同上（由 R-08 取代） |
| `GET_FBA_SNS_FORECAST_DATA`、`GET_FBA_SNS_PERFORMANCE_DATA` | 订阅省旧报告（2025 年 12 月 11 日移除） | 同上（由 I-19 取代） |
| `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE`、`GET_V2_SETTLEMENT_REPORT_DATA_XML` | 另两种结算格式（2026 年 11 月 11 日移除） | 同上（只用 R-28） |

实现要求：连接器的报告类型常量表在编译期只包含上文一至四节的类型；对禁用类型的任何调用在单元测试中必须失败。官方对照表中，旧库存类报告在角色对照表里已无条目，也印证了其已被移除。

---

## 九、与 10.2 的缺口与待你确认

| 编号 | 缺口 | 影响 | 我的处理 |
|---|---|---|---|
| G-01 | 10.2 没有"官方赔付明细"的存放模型。`GET_FBA_REIMBURSEMENTS_DATA` 的每一行是亚马逊已赔付记录，不能直接塞进 `ReimbursementCase`（案件是我方对象，一个案件可对应多行，也可能有无案件的赔付） | 07 章 7.3 要求"实收金额由赔付报告与财务交易自动匹配" | **变更单 CR-002 已于 2026-10-21 确认**：新增模型 `ReimbursementRecord`（官方赔付明细，幂等键 `(reimbursementId, sku, fnsku)`，字段含赔付类型、原因码、数量、金额、币种、赔付日期、关联订单与货件、匹配案件编号）。在你书面确认前，P0-02 与 10.2 保持原样，不改方案 |
| G-02 | 品牌分析 5 张表在 10.2 中只写"5 张表"，未命名 | 无功能影响，仅需命名 | 在 `models.md` 中命名为 `BrandSearchQueryPerformance`、`BrandSearchCatalogPerformance`、`BrandSearchTerm`、`BrandMarketBasket`、`BrandRepeatPurchase`，随 P0-02 一并确认（不属于偏离，属于补全命名） |
| G-03 | 销售税报告类型 `GET_FLAT_FILE_SALES_TAX_DATA` 现已确定，02 章 2.3 与 07 章 7.11 原文为"实施时确定" | 方案原文需回填 | 属于方案预留的"实施时确定"，回填内容见本文 R-33；**回填 02、07 章文字前仍请你确认**（按 14.7，不先做后补） |
| G-04 | `TRANSACTION_UPDATE` 所需角色官方对照表未逐类型列出 | 不影响设计，影响授权核对 | P1-26 用真实订阅实测，结果记入验证台账 |
| G-05 | `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` 是否可由 `createReport` 主动申请 | 影响 R-28 是"创建"还是"检索"模式 | 按"检索新结算"设计，P1-26 实测；若可创建，只改变触发方式，不改变解析器、目标表与幂等键 |
| G-06 | Listings Restrictions（I-11）、Product Type Definitions（I-12）、Product Fees 定价模拟（I-14）、Uploads（I-24）结果不落独立业务表 | 10.2 中没有对应模型 | 已按"不落库或写入既有模型"处理，不新增模型；若你要求留痕保存，需另提变更单 |

---

## 十、覆盖核对

1. **2.1 接口**：表内共 26 行（I-01 至 I-26），与 2.1 表格逐行对应：订单、财务、数据中心（含两个数据集，分列于 I-26 与第二节）、报告（第三节）、入仓、入仓资格、上游仓储、库存、目录、刊登、刊登限制、商品类型定义、定价、费用、客户反馈、请求评价、促销、A+、订阅省、支持、追踪、推送、批量与上传、卖家信息。2.1 中"报告 `Reports API`"对应第三节全部条目与通用流式模式 S1，不单列。
2. **2.3 报告**：42 个条目与方案逐类型核对，销售税已确定类型；12 个旧类型列入第八节禁用清单。
3. **2.4 推送**：18 个条目（N-01 至 N-18）；方案中"`LISTINGS_ITEM_STATUS_CHANGE`、`LISTINGS_ITEM_ISSUES_CHANGE`""`ITEM_PRODUCT_TYPE_CHANGE`、`PRODUCT_TYPE_DEFINITIONS_CHANGE`""`REPORT_PROCESSING_FINISHED`、`FEED_PROCESSING_FINISHED`"三组合并行已拆开，共 18 个类型。
4. **2.5 广告**：A-01 至 A-04，加上不纳入生产的广告智能体服务。
5. **10.3 同步清单 22 个数据域**：订单、财务交易、亚马逊物流库存、库存规划与费用、库存台账、移除、商品与刊登、定价、入仓、上游仓储、业务报告、单品经济、品牌分析、客户反馈、促销、订阅省、A+、支持案件、账户健康、小时级经营、广告实体、广告报表、广告近实时、汇率，每一域在本文有对应来源条目。
6. 所有"所需角色"取自官方对照表；唯一一处官方未逐项列出的是 N-14（`TRANSACTION_UPDATE`），另外受限角色（Tax Remittance、Selling Partner Support、Direct to Consumer Shipping）是否已获亚马逊批准，需在 P1-26 用真实授权核对，核对结果记入验证台账。

> **P4-11 实现说明（CR-086）**：I-13 已实现（`apps/worker/src/importers/pricing/`，任务类型 `PRICING_SYNC`，每 2 小时，专属定时器，来源键 `pricing.api`）：刊登接口取我方报价（`searchListingsItems` 带 `includedData=summaries,offers`）+ 推荐报价预期价格（每批 40 个 SKU）+ 竞争摘要（每批 20 个 ASIN）；每次同步最多 30 批，商品更多时按两小时时间槽确定性轮转，未覆盖的下一槽补上；“定价”角色没批准时失败码 `PRICING_ROLE_MISSING`（不可重试，页面写原因）；批内个别项失败不影响其余项。**N-05（`ANY_OFFER_CHANGED`）、N-06（`PRICING_HEALTH`）处理器已注册**（`importers/pricing/notifications.ts`），但推送接收端按 14.10 暂缓，没有事件进来：N-05 只写一条 `BuyBoxSnapshot`（`source = NOTIFICATION`，只处理美国站全新商品，与上一条相比没变化不重复写；**没有写 `CompetitiveOffer`**，报价明细以每 2 小时的同步为准）；N-06 只在失去资格的原因含“PRICE”时记 `lostReason = PRICE`（没有原因字段按结构错误报告，不猜）；**生成预警实例留给 P4-15**。**两个处理器的字段名只依官方文档整理，没有用真实推送验证。**

> **P4-12 实现说明（CR-087）**：竞品用法已实现（`apps/worker/src/importers/competitors/`，任务类型 `COMPETITOR_SYNC`，每 6 小时，专属定时器，来源键 `competitors.api`，不并入 6 小时全量同步）：商品目录接口（I-09，批量取标题、品牌、图片、销售排名，每批 20 个 ASIN）+ 定价接口竞争摘要（I-13，每批 20 个 ASIN，取价格、推荐报价、配送方式、会员资格）；每次最多 10 批，关注更多时按 6 小时时间槽确定性轮转；两个接口各自可能失败或漏某个 ASIN：这次没取到的字段沿用上一条快照，两边都没返回且没有历史就不写；目录整批 400（ASIN 格式不合法）退化为逐个请求；快照只在可见属性变化、或距上一条超过 24 小时时才写，唯一键加 `skipDuplicates` 幂等。没有任何关注时结果标 `notApplicable`，新鲜度记为“范围不适用”。403（缺商品目录或定价角色）以不可重试的 `ROLE_MISSING` 结束。**N-05 没有用于竞品**（推送接收端按 14.10 暂缓，且 N-05 只覆盖我方有报价的商品），竞品价格完全靠轮询。**字段名与响应结构依据官方文档整理，没有用真实店铺核对。**热门搜索词（R 类品牌分析报告）只用来“推荐候选”与算核心词点击份额，由 `BrandSearchTerm`、`BrandSearchQueryPerformance` 读出，本包不新增报告导入。

> **P4-13 实现说明（CR-088）**：I-15、I-16、F-01 已实现。**I-15 客户反馈**（`apps/worker/src/importers/feedback/`，任务类型 `FEEDBACK_SYNC`，每日一次、启动后 24 分钟补跑，专属定时器，来源键 `feedback.api`）：对每个店铺的美国站，先取 ASIN 所在浏览节点，再取该商品的评论主题（前 10 正面、前 10 负面）、类目评论主题趋势（“类目全部商品”“类目前 25% 商品”，近 6 个月）、类目退货主题趋势；每次最多 40 个 ASIN，**没有快照的 ASIN 最多占一半名额，另一半给快照最旧的**（防止接口一直没数据的 ASIN 永远排第一挤掉其余商品），距上一次快照不足 6 天的跳过；类目趋势一取到就先写、商品主题最后写，所以趋势取数被 429 打断时该商品没有今天的快照、重试会接着做；某一种这次返回空就不动已有数据；趋势里读不出口径（全部/前 25%）的点计入 `skipped`，不猜；百分数除以 100 存小数，超出 0 到 100 的丢弃；缺品牌备案或品牌分析角色（403）以不可重试的 `FBK_NO_BRAND_ACCESS` 结束，页面写原因。**只用了接口七个操作里的四个**（商品所在浏览节点、商品评论主题、类目评论趋势、类目退货趋势），评论主题的原文评论、按评论原因取订单等**未使用**。**I-16 请求评价**（`solicitation.send` 写流程，`connectors/solicitation-dispatch.ts`、`runtime/solicitation-workflow.ts`）：每单先查可用动作，没有 `productReviewAndSellerFeedback` 记 `UNAVAILABLE`（窗口已过则 `WINDOW_CLOSED`），有则发请求记 `REQUESTED`；错误信息含 `already`、`previously`、`duplicate` 的按“已请求过”记 `REQUESTED` 并写 `SOL_ALREADY_SENT`；401/403 把这一单记 `FAILED`（`SP_API_403`）并**立刻终止整批**，其余订单保持 `QUEUED`，由 `markSolicitationFailed` 统一改成 `FAILED` 并计入写入开关的自动关闭；**崩溃发生在“亚马逊已受理、本地还没记为已请求”之间时，重试查到动作已不可用，这一单会记 `UNAVAILABLE` 而不是 `REQUESTED`（亚马逊没有按订单查历史请求的操作，无法对账）**。**F-01 评分文件**走 API 同步解析与写入（`POST /reviews/ratings-import`），不经 worker。**所有字段名与响应路径依据官方文档整理、解析按宽容写，没有用真实店铺响应核对。**

> **P4-14 实现说明（CR-089）**：I-18、I-24 已实现。**I-18 A+ 内容**（`apps/worker/src/importers/aplus/`，`connectors/aplus-api.ts`，任务类型 `APLUS_SYNC`，每日一次、专属定时器，来源键 `aplus.api`）：分页取内容列表（每次最多 100 份，超出记日志）、逐份取详情与关联 ASIN，写 `AplusContent`（`draftJson` 原样保存模块结构，该内容有排队或处理中的写入时本轮不覆盖，同步**不改 `version`**）、`AplusAsinRelation`、`AplusReviewEvent`（状态变化写一条，同一状态不重复）；已批准的内容对其关联 ASIN（每次最多 30 个，优先没有上线时间的）查发布记录，查得上线时间则记 `PUBLISHED`；403（没有品牌备案或没获批 A+ 内容角色）以不可重试的 `APL_ROLE_MISSING` 结束，新鲜度记“未授权”且不触发同步失败预警。**拒绝原文接口不一定返回**，依次尝试 `rejectionReason`、`rejectionMessage`、`rejectReason`、`statusMessage`、`message`、`reason`，取不到就是空，不编；上线时间字段名同样宽容尝试多种写法。**写入**（`APLUS_WRITE`，`runtime/aplus-workflow.ts`、`connectors/aplus-dispatch.ts`）：按 `AplusWriteRun.kind` 创建、更新（整份快照）、关联 ASIN、提交审核；写入开关关闭时以 `APL_SWITCH_OFF` 失败、不发请求；创建时若重试，会先在内容列表前 3 页按名称对账，名称不在前 3 页会漏掉并多建一份同名草稿。**I-24 上传接口**：不独立落库，上传结果（`uploadDestinationId`）写在 `AplusWriteRun`（`kind=UPLOAD`）的 `resultJson`，图片从对象存储读出、算 MD5、取上传地址后直传（不带授权头）。**接口路径、字段名与响应形状依据官方文档整理，没有用真实店铺核对。** `APL_REVIEW_REJECTED`（审核被拒生成待办）**本包没有实现**，被拒只在页面与时间线显示。

> **P4-15 实现说明（CR-090）**：商品类预警已实现（`apps/worker/src/alerts/`），**不是导入器**，没有新增任务类型、数据表或迁移，只读已有数据。六个评估器：`listing-issue-evaluators.ts`（刊登问题新增、被搜索抑制，读 `ListingIssue`）、`listing-change-evaluator.ts`（详情页被他人修改，读 `ListingChangeEvent` 里 `CONTENT_CHANGE`）、`featured-offer-evaluator.ts`（失去推荐报价资格，读 `BuyBoxSnapshot`）、`price-health-evaluator.ts`（价格健康异常，读 `PriceSnapshot`、`FeaturedOfferExpectedPrice`、`CompetitiveSummarySnapshot` 与 `BuyBoxSnapshot`）、`review-topic-evaluator.ts`（负面评论主题上升，读 `ReviewTopic`）。**N-06（`PRICING_HEALTH`）“生成预警实例”由“价格健康异常”预警承接，但它读的是 `BuyBoxSnapshot.lostReason = PRICE` 这一行，不是推送事件本身，且推送接收端按 14.10 暂缓，所以目前不会因推送命中；N-12（`BRANDED_ITEM_CONTENT_CHANGE`）“触发预警”同理由“详情页被他人修改”承接，目前事件来自 I-10 的每日同步比对，修改人多为“未知”。** **已发现的既有缺陷（P4-11，未在本包修复）：`BuyBoxSnapshot_check` 检查约束只允许 `lostReason` 为空或 `PRICE`，而 N-06 处理器会把其他原因写成 `OTHER`，真实推送接入时这类事件会被数据库拒绝；接入前要在“放宽约束”与“处理器只记 PRICE”之间选一个。**
