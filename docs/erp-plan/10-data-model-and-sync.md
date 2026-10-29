# 10 数据模型、同步与接口清单

## 10.1 通用约定

- **同步表统一字段**：`sourceUpdatedAt`（来源更新时间）、`syncedAt`（同步时间）、`sourceReportJobId`（来源报告任务）、`sourceRecordId`（原始来源标识）。
- **幂等**：每张同步表都定义幂等唯一键。分区表的唯一键必须包含分区所用的日期列。
- **按月分区的表**：订单、订单行、订单收入费用明细、财务交易、费用事件、广告日指标、广告词级指标、广告商品指标、营销数据流小时数据、小时级推送事件、库存日快照、业务报告日数据、单品经济日数据、审计日志。
- **日汇总表**：经营日汇总（`StoreDailySummary`，店铺 × 日）、ASIN 日汇总（`AsinDailySummary`，店铺 × ASIN × 日）、利润日表（`ProfitDaily`）、广告日汇总（`AdsDailySummary`）。全部由派生任务增量刷新。
- **乐观锁**：会被多人编辑的对象加版本号，包括采购单、补货策略、预警规则、赔付案件、待办、目标、成本版本、自动规则、分时策略、定价规则、价格护栏、写入开关、财务口径设置。
- **索引**：第一列为租户编号，其后依次为店铺、日期。

## 10.2 数据模型完整清单

| 业务域 | 新增模型 | 修改的现有模型 |
|---|---|---|
| 权限与范围 | `MembershipScope`、`MemberInvitation`、`FieldPermission` | `Role` 升级为"模块.动作"权限格式 |
| 平台能力 | `DataFreshness`、`ExportJob`、`SavedView`、`RawReportFile`、`Notification`、`TenantSetting`、`FinancePolicyVersion` | `SyncJob` 扩展数据域；`AuditEvent` 扩展差异字段并按月分区（CR-009） |
| 租户与认证（12 章） | `PlatformAdmin`、`TenantInvitation`、`TenantOnboarding`（初始化向导进度）、`TenantLifecycleEvent`、`TenantQuota`、`PlatformSupportAccess`（限时支持访问授权）、`MfaFactor`、`StepUpVerification`（高风险操作的再次验证） | `Tenant` 默认数据口径时区改为美国太平洋时区、显示币种改为美元，另设企业本地时区；`Session` 增加刷新令牌轮换链与重用检测字段 |
| 流程可靠性（12 章） | `WorkflowRun`、`WorkflowStep`、`IdempotencyRecord`、`DeadLetterJob`、`DistributedLock` | — |
| 写入开关与汇率 | `IntegrationSwitch`、`IntegrationSwitchLog`、`FxRate`、`FxSourceConfig` | — |
| 协作与事件 | `Comment`、`Watch`、`EntityEvent`（事件标注时间轴的统一事件表）、`OperationLog`（运营日志，含手工记录） | — |
| 目标与订阅 | `BusinessTarget`、`ReportSubscription` | — |
| 商品与刊登 | `ListingSnapshot`、`ListingContentSnapshot`（字段级内容快照）、`ListingIssue`、`ProductVariantRelation`、`PriceSnapshot`、`SalesRankSnapshot`、`ListingChangeEvent` | `FbaProduct` 增加父 ASIN、图片、品牌、类目、负责人、标签 |
| 定价 | `FeaturedOfferExpectedPrice`、`CompetitiveSummarySnapshot`、`CompetitiveOffer`、`BuyBoxSnapshot`、`PriceGuardrail`、`PricingRule`、`PricingRuleRun` | — |
| 竞品 | `WatchedAsin`、`CompetitorSnapshot` | — |
| 评价与内容 | `ReviewMetricSnapshot`（字段级标注来源）、`ReviewTopic`、`BrowseNodeReviewTrend`、`BrowseNodeReturnTrend`、`SolicitationRequest`、`AplusContent`、`AplusAsinRelation`、`AplusReviewEvent` | — |
| 业务报告与品牌分析 | `SalesTrafficDaily`、`SalesTrafficAsinDaily`，以及品牌分析 5 张表（`BrandSearchQueryPerformance`、`BrandSearchCatalogPerformance`、`BrandSearchTerm`、`BrandMarketBasket`、`BrandRepeatPurchase`） | — |
| 近实时 | `HourlySalesEvent`、`HourlyTrafficEvent`、`HourlyInventoryEvent`、`AmazonNotificationEvent`、`NotificationSubscription` | — |
| 促销与订阅省 | `Promotion`、`PromotionItem`、`PromotionMetric`、`CouponMetric`、`SubscribeSaveMetric`、`SubscribeSaveOffer` | — |
| 库存 | `InventoryDailySnapshot`、`InventoryLedgerEntry`、`InventoryLedgerSummary`、`InventoryAgeSnapshot`、`InventoryPlanningSnapshot`（库存规划报告全字段）、`StorageCapacitySnapshot`、`StorageFeeRecord`、`RemovalOrder`、`RemovalShipment`、`RemovalReceipt`、`AmazonRestockRecommendation` | `FbaInventoryRecord` 去掉固定阈值判断 |
| 上游仓储 | `AwdInventory`、`AwdInboundOrder`、`AwdInboundShipment`、`AwdShipmentItem` | — |
| 补货 | `Forecast`、`ReplenishmentPolicy`（企业、品类、SKU 三级）、`ReplenishmentBatch`、`ReplenishmentRecommendation`、`ReplenishmentAction`、`ReplenishmentOutcome`（结果回看） | — |
| 采购与国内仓 | `PurchaseReceipt`、`QualityInspection`、`PurchasePayment`、`PurchaseApproval`、`Attachment`、`StockCount` | `PurchaseOrder` 增加审批、付款、收货进度、版本号；`Supplier` 增加表现指标；`Warehouse` 与 `InventoryMovement` 扩展为国内仓 |
| 成本与头程 | `CostVersion`、`LandedCostAllocation`、`FreightForwarder`、`FirstMileShipment`、`FirstMileCost`、`FirstMileMilestone`、`TransitTimeStat` | — |
| 入仓 | `InboundPlanItem`、`InboundEligibilityCheck`、`PackingOption`、`PackingGroup`、`Box`、`PlacementOption`、`TransportOption`、`DeliveryWindow`、`ShipmentItem`、`TrackingEvent`、`ReceivingDiscrepancy`、`LabelPrintJob`、`InboundOperation`（异步操作状态） | `FbaInboundPlan` 增加状态链；`FbaInboundShipment` 拆出明细 |
| 订单 | `OrderStatusHistory`、`OrderCharge`（收入与费用明细）、`OrderPackage`、`OrderCancellation` | `Order`、`OrderItem` 迁移到订单接口新版字段；`OrderItem` 冗余存放站点 |
| 售后 | `ReimbursementOpportunity`、`ReimbursementCase`、`EvidencePack`、`SupportCase`、`SupportContact`、`ReimbursementRecord`（官方赔付明细，CR-002） | `FbaReturnCase` 关联赔付案件 |
| 财务 | `Reconciliation`、`ReconciliationException`、`FeeAudit`、`AccountBalanceSnapshot`、`Disbursement`、`CashflowForecast`、`SalesTaxSummary`、`AccountingPeriod`、`PeriodSnapshot`、`ProfitDaily`、`AdsAllocationRule`、`EconomicsDaily`（官方单品经济）、`EconomicsPreview`、`EconomicsSimulationRun` | `FbaSettlement` 补列期初余额、打款金额、交易数、对账状态、差异金额（CR-009）；`FbaFinancialTransaction` 增加交易状态（递延、已释放、递延后释放）；`FbaFeeEvent` 增加 9 类费用分类与对账状态 |
| 广告 | `AdsAccount`、`AdsPortfolio`、`AdsAdGroup`、`AdsAd`、`AdsTarget`、`AdsKeyword`、`AdsNegativeTarget`、`AdsCreative`、`AdsPlacementMetric`、`AdsAdvertisedProductMetric`、`AdsConvertedProductDaily`、`AdsPerformanceHourly`、`AdsEntitySnapshot`（用于识别外部变更）、`AdsChangeLog`、`AdsRecommendation`、`AdsForecastRun`、`AdsBudgetRule`、`AdsAutomationRule`、`AdsAutomationRun`、`DaypartingStrategy`、`DaypartingRun` | `AdsProfile` 绑定店铺并兼容广告账户编号；`AdsCampaign` 增加组合、投放方式、竞价策略、投放状态；`AdsTermMetric` 关联关键词与投放对象；`AdsMetric` 按月分区（CR-009） |
| 风险与待办 | `AlertRule`、`AlertRuleVersion`、`AlertInstance`、`WorkItem`、`Assignment`、`AccountHealthSnapshot`、`PolicyIssue` | — |

## 10.3 同步与推送清单

| 数据域 | 来源 | 方式 | 频率（默认值，企业设置中可调） | 写入 |
|---|---|---|---|---|
| 订单 | 订单接口新版、订单报告、推送 `ORDER_CHANGE` | 推送触发增量 + 定时补偿 + 历史回补 | 推送实时；补偿每 15 分钟 | 订单、订单行、收入费用明细、包裹、取消、状态历史 |
| 财务交易 | 财务接口新版、推送 `TRANSACTION_UPDATE`、结算报告 | 推送触发增量 + 每日全量对账 | 推送实时；对账每日 | 财务交易、费用事件、结算、余额 |
| 亚马逊物流库存 | 库存接口、推送 `FBA_INVENTORY_AVAILABILITY_CHANGES` | 推送 + 定时 | 每 30 分钟 | 库存记录、库存日快照 |
| 库存规划与费用 | 库存规划、仓储费、超额费、长期仓储费、预留、滞留、官方补货建议、推荐移除等报告 | 定时报告 | 每日 | 对应快照表 |
| 库存台账 | 台账明细与汇总报告 | 定时报告 | 每日 | 台账表 |
| 移除 | 移除订单与移除货件报告 | 定时报告 | 每日 | 移除表 |
| 商品与刊登 | 目录接口、刊登接口、刊登报告、推送（刊登状态、问题、商品类型、品牌内容变更） | 推送 + 每日全量 | 推送实时；全量每日 | 商品、刊登快照、内容快照、问题 |
| 定价 | 定价接口、推送 `ANY_OFFER_CHANGED`、`PRICING_HEALTH` | 推送 + 定时批量 | 推送实时；批量每 2 小时 | 预期获胜价、竞争摘要、报价、购物车快照 |
| 入仓 | 入仓接口、入仓不合规报告 | 操作驱动 + 定时 | 进行中的计划每 30 分钟 | 入仓全部表 |
| 上游仓储 | 上游仓储接口 | 定时 | 每 2 小时 | 上游仓储表 |
| 业务报告 | 数据中心销售与流量；补充：销售与流量报告 | 定时查询 | 每日 | 业务报告日数据 |
| 单品经济 | 数据中心单品经济；费用预览按需查询 | 定时查询 + 按需 | 每日 | 单品经济日数据、费用预览 |
| 品牌分析 | 品牌分析 5 类报告 | 定时报告 | 按周、月 | 品牌分析表 |
| 客户反馈 | 客户反馈接口 | 定时 | 每周 | 评论主题、类目趋势 |
| 促销 | 促销接口、促销与优惠券表现报告 | 定时 | 每日 | 促销表 |
| 订阅省 | 订阅省接口 | 定时 | 每日 | 订阅省表 |
| A+ 内容 | A+ 内容接口 | 定时 + 操作驱动 | 每日 | A+ 内容表 |
| 支持案件 | 卖家支持接口 | 定时 | 每 2 小时 | 支持案件表 |
| 账户健康 | 卖家表现报告、推送 `ACCOUNT_STATUS_CHANGED` | 推送 + 定时 | 推送实时；报告每日 | 账户健康表 |
| 小时级经营 | 推送：小时级销售、详情页流量、可售数量 | 推送 | 每小时 | 小时事件表 |
| 广告实体 | 广告统一接口 | 定时 + 操作后刷新 | 每 2 小时 | 广告实体表、实体快照 |
| 广告报表 | 新报告接口 | 定时 | 每日；近 3 天每日重拉，以覆盖归因回补 | 广告指标表 |
| 广告近实时 | 营销数据流第二版（接收端为部署专项） | 推送 | 最快每 15 分钟 | 广告小时表、转化商品表 |
| 汇率 | 主源与备源 | 定时 | 每日 | 汇率表 |

**统一要求**：
1. 原始文件先存对象存储，再分批解析。
2. 导入器容忍新字段与未知枚举值。
3. 每个数据域有明确的权限、同步器、解析器、失败码与数据新鲜度记录。
4. 前端不等待报告下载与解析完成。
5. 重复同步不产生重复数据。

## 10.4 我方后端接口清单

所有路径以 `/api/v1` 为前缀。所有列表与分析接口统一接收范围参数（法律主体、店铺、站点、开始时间、结束时间、显示币种）与列表参数（游标、排序、筛选）。

| 模块 | 主要接口 |
|---|---|
| 平台运营后台（与租户接口分离，独立鉴权） | `GET\|POST /platform/tenants`、`POST /platform/tenants/:id/{invite,suspend,resume,deactivate,close}`、`GET /platform/tenants/:id/usage`、`POST /platform/support-access` |
| 租户开通与认证 | `POST /auth/invitations/:token/accept`、`GET\|PATCH /onboarding`、`POST /auth/mfa/{enroll,verify}`、`POST /auth/step-up`、`GET\|DELETE /auth/sessions` |
| 范围与平台 | `GET /scope/options`、`GET /freshness`、`POST /exports`、`GET /exports/:id`、`GET\|POST /views`、`GET\|POST /comments`、`POST /watches`、`GET /events`（事件标注） |
| 首页 | `GET /overview/{kpis,trend,attribution,store-compare,asin-rank,ad-anomalies,inventory-risk,growth-waterfall,cash,source-health}`、`GET /today/{summary,hourly,events}`、`GET\|PATCH /work-items`、`POST /work-items/:id/{assign,ack,ignore,close}`、`GET\|PUT /targets` |
| 运营分析 | `GET /analytics/sales-traffic/{summary,by-date,by-asin,trends}`、`GET /analytics/asins`、`GET /analytics/parents/:parentAsin/{matrix,trend,traffic,ads,reviews,changes}`、`GET /analytics/brand/{search-query,catalog,search-terms,market-basket,repeat-purchase}`、`GET /promotions`、`GET /promotions/:id`、`GET /subscribe-save` |
| 商品 | `GET /products`、`GET /products/:id/{overview,traffic,ads,inventory,economics,returns,listing,reviews,pricing,competitors,content,changes}`、`POST /products/:id/price-simulation`、`GET /listings/performance`、`GET /listings/quality`、`POST /listings/:sku/validate`、`PATCH /listings/:sku`、`GET /pricing`、`GET /pricing/:sku`、`PATCH /pricing/:sku`、`GET\|PUT /pricing/guardrails`、`GET\|POST /pricing/rules`、`GET\|POST /competitors`、`GET /reviews`、`POST /reviews/solicitations`、`GET\|POST\|PATCH /aplus`、`POST /aplus/:id/submit`、`GET\|POST /costs` |
| 库存 | `GET /inventory`、`GET /inventory/:id/{structure,snapshots,ledger,inbound,awd,replenishment,age-fees,disposition,forecast}`、`GET /inventory/ledger`、`GET /inventory/removals`、`GET /inventory/removals/:id`、`POST /inventory/removals/:id/receipt`、`GET /inventory/capacity` |
| 补货 | `GET\|PUT /replenishment/policies`、`POST /replenishment/recompute`、`GET /replenishment/recommendations`、`POST /replenishment/simulate`、`POST /replenishment/{to-purchase-draft,to-inbound-draft,to-awd-draft}`、`GET /replenishment/batches/:id` |
| 上游仓储 | `GET /awd/inventory`、`GET\|POST\|PATCH /awd/orders`、`POST /awd/orders/:id/{confirm,cancel}`、`GET /awd/shipments`、`GET /awd/shipments/:id/labels` |
| 采购与国内仓 | 供应商增删改查、`GET\|POST /purchase-orders`、`POST /purchase-orders/:id/{submit,approve,receive,inspect,pay,attachments}`、`GET /domestic-warehouse`、`POST /stock-counts` |
| 头程 | `GET\|POST /first-mile`、`POST /first-mile/:id/{milestones,costs,allocate}`、`GET /first-mile/transit-stats` |
| 入仓 | `GET\|POST /inbound/plans`、`POST /inbound/plans/:id/{eligibility,packing-options,packing-info,placement-options,transport-options,delivery-windows,confirm,cancel}`、`GET /inbound/plans/:id/{operations,boxes,labels}`、`GET /inbound/shipments`、`GET /inbound/shipments/:id/{discrepancies,timeline}` |
| 订单与售后 | `GET /orders`、`GET /orders/:id`、`POST /pii/reveal`（P6-14，原 `POST /orders/:id/pii-access`）、`GET /returns`、`GET /returns/:id`、`GET /reimbursements/opportunities`、`GET\|POST\|PATCH /reimbursements`、`POST /reimbursements/:id/evidence-pack`、`GET /support-cases`、`GET /support-cases/:id` |
| 财务 | `GET /finance/events`、`PATCH /finance/events/:id/reconciliation`、`GET /finance/fee-audit`、`GET /settlements`、`GET /settlements/:id/{summary,transactions,reconciliation}`、`GET /finance/cashflow`、`GET /profit/{overview,stores,asins,ads,cost-coverage,bridge}`、`GET /finance/economics/{compare,preview}`、`POST /finance/economics/simulate`、`GET /finance/sales-tax`、`GET\|POST /finance/periods`、`POST /finance/periods/:id/{check,approve,close,reopen}` |
| 广告 | `GET /ads/overview`、`GET /ads/today`、`GET\|PATCH /ads/campaigns`、`GET /ads/campaigns/:id/{trend,hourly,ad-groups,targets,search-terms,products,placements,creatives,audiences,history,forecast,recommendations}`、`GET\|PATCH /ads/ad-groups/:id`、`GET\|PATCH /ads/targets/:id`、`POST /ads/negatives`、`POST /ads/keywords`、`POST /ads/preview`（统一的写前影响预览）、`GET /ads/products`、`GET /ads/terms`、`GET /ads/terms/detail`、`GET\|POST /ads/portfolios`、`GET\|POST\|PATCH /ads/dayparting`、`GET\|POST\|PATCH /ads/rules`、`POST /ads/rules/:id/dry-run`、`GET /ads/changes`、`GET\|POST /ads/reports`、`GET /ads/metrics` |
| 风险 | `GET\|POST\|PATCH /alerts/rules`、`GET /alerts`、`GET /alerts/:id`、`POST /alerts/:id/{ack,ignore,assign,close}`、`GET /account-health` |
| 数据与报表 | `GET /reports`、`GET /reports/:id`、`POST /reports`、`POST /reports/:id/{cancel,retry}`、`GET /reports/:id/download`、`GET /metrics/definitions` |
| 治理 | `GET /connections`、`POST /connections/:id/{health-check,reauthorize,disconnect}`、`POST /connections/ads-accounts/:id/bind`、`GET\|POST\|DELETE /notifications/subscriptions`、`GET /sync/jobs`、`GET /sync/jobs/:id`、`POST /sync/jobs/:id/retry`、`GET /sync/queues`、`GET /sync/rate-limits`、主体增删改查、`POST /members/invite`、`POST /members/:id/{disable,role,scopes}`、`GET\|POST\|PATCH /roles`、`GET /audit`、`GET /audit/:id`、`GET\|PATCH /settings`、`GET\|PATCH /settings/integrations`、`POST /settings/integrations/{readonly-all,:key/enable,:key/disable}`、`GET\|POST /settings/fx` |

所有写接口统一经过审计拦截器与动作守卫（权限、连接、写入开关、数据条件）。所有涉及亚马逊写入的接口，都先提供预览或校验步骤。
