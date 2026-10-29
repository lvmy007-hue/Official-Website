# P0-01 路由清单

> 依据：03 章 3.5；01 章 1.7 第 10、12 条；执行计划 P0-01。
> 与 03 章 3.5 逐行一致。所有原有 `/app/...` 路径保持不变。

## 一、约定

**路由格式**：`:参数` 表示动态段。所有页面路由前缀 `/app`。

**页面组件命名**：`PascalCase` + `Page`，放在 `src/pages/<业务域>/`；详情页用 `DetailPage` 后缀。每个路由一个独立组件，不用通用页面承载多个业务域。

**权限列**：引用 `permissions.md` 中定义的权限点。列出的是进入页面所需的最小读权限；页面内的写动作另有权限与写入开关，见 `api.md`。
- 字段级权限（`field.cost`、`field.profit`、`field.buyer`）不在此列，规则见 `permissions.md` 第三节；
- "基础"表示所有登录成员具备（`my.*`、`profile.manage`、`metrics.read`）。

**接口列**：读取的后端接口前缀（均以 `/api/v1` 开头），完整清单见 `api.md`。

**特有数据状态**：每个页面都具备 9 种通用状态中的"骨架、无数据、延迟、局部失败、服务端错误、无权限"。下表只列该页面额外会出现的状态：
- **A** 未授权：需先授权卖家接口或广告接口，页面显示授权引导；
- **Q** 资格不足：缺少亚马逊品牌资格或受限角色，页面说明所需资格与影响；
- **P** 部分可用：多个数据源，其中部分不可用时其余照常展示；
- **N** 未接入：依赖推送接收端或营销数据流（部署专项暂缓期间显示），退化展示日终数据。

**阶段**：1、2a、2b、3、4、5、6 对应执行计划各阶段；括号内是工作包编号。**未到上线阶段的页面不注册导航项，直接访问显示正式的"页面不存在"页。**

## 二、导航分组与路由

导航分组按 16 章第 0 节调整为 12 组（CR-107，P6-00）：首页、统计分析、商品与 Listing、库存与补货、FBA 发货、订单与售后、财务与利润、广告、预警、工具、数据与报表、设置。

路径一律不变，只改分组与顺序；原“账户”并入“设置”，“供应链”并入“FBA 发货”（采购订单、供应商、国内仓保留现状，放在本组末尾），“竞品监控”移到“工具”，“商品成本”移到“财务与利润”，“促销与优惠券”“订阅省”移到“商品与 Listing”，“账户健康”移到“预警”。

阶段列写“6（P6-xx，未上线）”的是 16 章标【新】的路由：**在对应工作包交付、并在 `live-pages.ts` 登记之前，不进导航，直接访问显示“页面不存在”**（与第三节“未上线页面”一致）。

### 2.1 首页（5 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/overview` | 经营控制台 | `OverviewPage` | `overview.read` | `/overview/*`、`/freshness` | 无（视图模板：经营者、运营、财务、供应链） | A、P | 阶段 1 过渡为"企业初始化与数据源健康"（P1-07）；2a 正式上线（P2a-02） |
| `/app/today` | 今日实时 | `TodayPage` | `overview.read` | `/today/*` | 无 | A、N | 2a（P2a-03） |
| `/app/my/work-items` | 我的待办 | `MyWorkItemsPage` | 基础 | `/work-items` | 待我处理、我指派的、我关注的、已完成、已忽略 | — | 1（P1-28） |
| `/app/targets` | 目标与预算 | `TargetsPage` | `targets.read` | `/targets` | 无（目标网格、达成进度、预测达成、变更历史为同页分区） | — | 2a（P2a-04） |
| `/app/approvals` | 审批收件箱 | `ApprovalsPage` | 基础 | `/approvals` | 无（左侧“我审批的、我发起的、抄送我的”，顶部“待处理、已处理”，抽屉内直接审批） | — | 6（P6-27，已上线） |

### 2.2 统计分析（14 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/analytics/product-performance` | 商品表现 | `ProductPerformancePage` | `analytics.read` | `/analytics/product-performance/*` | 无（七个维度切换，七组列，父 ASIN 可展开子体） | A、P | 6（P6-22，已上线） |
| `/app/analytics/business-reports` | 业务报告 | `BusinessReportsPage` | `analytics.read` | `/analytics/sales-traffic/*` | 销售仪表盘、按日期、销售与流量、详情页销售与流量、父体详情页销售与流量、月度销售与订单 | A | 4（P4-02） |
| `/app/analytics/asins` | ASIN 与父体分析 | `AsinAnalyticsPage` | `analytics.read` | `/analytics/asins` | 无（父体树、趋势、对比模式） | A | 4（P4-03） |
| `/app/analytics/parents/:parentAsin` | 父体详情 | `ParentAsinDetailPage` | `analytics.read` | `/analytics/parents/:parentAsin/*` | 子体贡献矩阵、子体趋势、流量分布、库存与补货、广告覆盖、评论主题、变体结构变更历史 | A、P | 4（P4-03） |
| `/app/analytics/brand/search-query` | 品牌分析·搜索查询表现 | `BrandSearchQueryPage` | `analytics.brand.read` | `/analytics/brand/search-query` | 无 | A、Q | 4（P4-04） |
| `/app/analytics/brand/catalog-performance` | 品牌分析·目录表现 | `BrandCatalogPerformancePage` | `analytics.brand.read` | `/analytics/brand/catalog` | 无 | A、Q | 4（P4-04） |
| `/app/analytics/brand/search-terms` | 品牌分析·热门搜索词 | `BrandSearchTermsPage` | `analytics.brand.read` | `/analytics/brand/search-terms` | 无 | A、Q | 4（P4-04） |
| `/app/analytics/brand/market-basket` | 品牌分析·购物篮分析 | `BrandMarketBasketPage` | `analytics.brand.read` | `/analytics/brand/market-basket` | 无 | A、Q | 4（P4-04） |
| `/app/analytics/brand/repeat-purchase` | 品牌分析·重复购买 | `BrandRepeatPurchasePage` | `analytics.brand.read` | `/analytics/brand/repeat-purchase` | 无 | A、Q | 4（P4-04） |
| `/app/analytics/sales-stat` | 销量统计 | `SalesStatPage` | `analytics.read` | `/analytics/sales-stat` | 无（日、周、月三种粒度，每个日期一列） | A | 6（P6-25） |
| `/app/dashboards` | 自定义仪表盘 | `DashboardsPage` | 基础 | `/dashboards/*` | 无（左侧文件夹树，右侧页码表格；画布在详情页） | — | 6（P6-33，已上线） |
| `/app/dashboards/:id` | 仪表盘详情 | `DashboardDetailPage` | 基础 | `/dashboards/:id`、`/dashboards/:id/widgets` | 无 | — | 6（P6-33，已上线） |
| `/app/reports/custom` | 我的报表 | `CustomReportsPage` | `reports.read` | `/custom-reports`、`/report-sources` | 无（列表，选数据源、维度、指标后保存） | — | 6（P6-32，已上线） |
| `/app/reports/custom-metrics` | 自定义指标 | `CustomMetricsPage` | `reports.read` | `/custom-metrics`、`/report-sources` | 无（配置，保存时校验公式与字段权限） | — | 6（P6-32，已上线） |

### 2.3 商品与 Listing（12 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/products` | 商品主数据 | `ProductsPage` | `products.read` | `/products` | 无 | A | 4（P4-07） |
| `/app/products/:id` | ASIN 360 | `Asin360Page` | `products.read` | `/products/:id/*` | 12 个：经营表现、流量转化、广告、库存补货、利润与成本、退货、刊登与问题、评价、定价与购物车、竞品、内容与 A+、变更与审计 | A、P、Q | 分阶段上线（见 2.3.1） |
| `/app/listings` | 刊登表现 | `ListingPerformancePage` | `listing.read` | `/listings/performance` | 无 | A | 4（P4-09） |
| `/app/listings/quality` | 刊登质量与合规 | `ListingQualityPage` | `listing.read` | `/listings/quality` | 问题项、被搜索抑制、刊登限制、属性缺失、商品类型变更、他人内容修改、非活跃刊登 | A | 4（P4-10） |
| `/app/pricing` | 定价与购物车 | `PricingPage` | `pricing.read` | `/pricing`、`/pricing/guardrails`、`/pricing/rules` | 无（列表、价格护栏、定价规则为同页分区） | A | 4（P4-11） |
| `/app/pricing/:sku` | SKU 定价详情 | `PricingSkuDetailPage` | `pricing.read` | `/pricing/:sku` | 无（价格历史、竞争报价快照、事件、调价模拟器、调价历史为同页分区） | A | 4（P4-11） |
| `/app/aplus` | A+ 内容 | `AplusListPage` | `aplus.read` | `/aplus` | 无 | A、Q | 4（P4-14） |
| `/app/aplus/:id` | A+ 内容详情 | `AplusDetailPage` | `aplus.read` | `/aplus/:id` | 无（模块预览、关联 ASIN、审核时间线、拒绝原因、前后对比为同页分区） | A、Q | 4（P4-14） |
| `/app/promotions` | 促销与优惠券 | `PromotionsPage` | `analytics.read` | `/promotions` | 无 | A | 4（P4-05） |
| `/app/promotions/:id` | 促销详情 | `PromotionDetailPage` | `analytics.read` | `/promotions/:id` | 效果、商品明细、成本、利润影响、校验问题、关联广告 | A | 4（P4-05） |
| `/app/subscribe-save` | 订阅省 | `SubscribeSavePage` | `analytics.read` | `/subscribe-save` | 无 | A | 4（P4-06） |
| `/app/reviews` | 评价与反馈 | `ReviewsPage` | `reviews.read` | `/reviews` | 评分概况、评论主题、退货主题、请求评价 | A、Q | 4（P4-13） |

#### 2.3.1 ASIN 360 页签上线阶段

| 页签 | 阶段（工作包） |
| --- | --- |
| 经营表现、库存补货、变更与审计 | 2a（P2a-14） |
| 利润与成本、退货 | 2b（P2b-17） |
| 广告 | 3（P3-19） |
| 流量转化、刊登与问题、评价、定价与购物车、竞品、内容与 A+ | 4（P4-08），同时上线建议动作区全部规则 |

未上线的页签不显示，不出现空页签与"规划中"字样。

### 2.4 库存与补货（12 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/inventory` | 库存健康 | `InventoryHealthPage` | `inventory.read` | `/inventory` | 全部库存、低库存、冗余、库龄风险、滞留、不可售、在途 | A、P | 2a（P2a-06） |
| `/app/inventory/:id` | 库存详情 | `InventoryDetailPage` | `inventory.read` | `/inventory/:id/*` | 10 个：库存结构趋势、历史快照、库存台账、入仓与在途、上游仓储、补货建议、库龄与费用、处置建议、预测、变更与审计 | A、P | 2a（P2a-06） |
| `/app/replenishment` | 补货建议 | `ReplenishmentPage` | `replenishment.read` | `/replenishment/*` | 无（批次列表、策略编辑、模拟为同页分区） | P | 2a（P2a-07） |
| `/app/replenishment/batches/:id` | 补货批次详情 | `ReplenishmentBatchDetailPage` | `replenishment.read` | `/replenishment/batches/:id` | 无（批次内 SKU、计算快照、执行情况、结果回看为同页分区） | — | 2a（P2a-07） |
| `/app/inventory/all-warehouses` | 跨仓总览 | `AllWarehousesPage` | `inventory.read` | `/inventory/all-warehouses` | 无（按 SKU 聚合，可展开到每个仓） | A、P | 6（P6-25） |
| `/app/inventory/movement` | 进销存报表 | `InventoryMovementPage` | `inventory.read` | `/inventory/movement` | 无（按 SKU 与月份，期初加变动等于期末） | A | 6（P6-25） |
| `/app/inventory/ledger` | 库存台账 | `InventoryLedgerPage` | `inventory.read` | `/inventory/ledger` | 汇总、明细（两种视图） | A | 2a（P2a-09） |
| `/app/inventory/removals` | 移除与弃置 | `RemovalsPage` | `inventory.read` | `/inventory/removals` | 移除订单、亚马逊推荐移除清单 | A | 2a（P2a-09） |
| `/app/inventory/removals/:id` | 移除订单详情 | `RemovalDetailPage` | `inventory.read` | `/inventory/removals/:id` | 无 | A | 2a（P2a-09） |
| `/app/inventory/capacity` | 仓储容量与费用 | `StorageCapacityPage` | `inventory.read` | `/inventory/capacity` | 无 | A、P | 2a（P2a-09） |
| `/app/awd` | 亚马逊仓储分销 | `AwdPage` | `awd.read` | `/awd/*` | 库存、入库订单、入库货件 | A | 2a（P2a-08） |
| `/app/awd/orders/:id` | 入库订单详情 | `AwdOrderDetailPage` | `awd.read` | `/awd/orders/:id` | 无 | A | 2a（P2a-08） |

### 2.5 FBA 发货（14 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/supply-chain` | 入仓计划 | `InboundPlansPage` | `inbound.read` | `/inbound/plans` | 无（计划列表、状态看板、异常队列） | A | 2a（P2a-12） |
| `/app/supply-chain/:id` | 入仓计划详情 | `InboundPlanDetailPage` | `inbound.read` | `/inbound/plans/:id/*` | 11 个：概览、商品、装箱方案、箱内物品、分仓方案、运输方案、货件、标签、时间线、接收与差异、费用 | A | 2a（P2a-12） |
| `/app/warehouse` | 货件接收与差异 | `ShipmentReceivingPage` | `inbound.read` | `/inbound/shipments` | 无 | A | 2a（P2a-13） |
| `/app/warehouse/:shipmentId` | 货件接收详情 | `ShipmentReceivingDetailPage` | `inbound.read` | `/inbound/shipments/:id/*` | 无（接收时间线、SKU 差异表、不合规问题、证据附件、赔付任务、审计为同页分区） | A | 2a（P2a-13） |
| `/app/first-mile` | 头程物流 | `FirstMilePage` | `firstmile.read` | `/first-mile` | 无 | — | 2a（P2a-11） |
| `/app/first-mile/:id` | 头程详情 | `FirstMileDetailPage` | `firstmile.read` | `/first-mile/:id` | 无（节点时间线、费用明细、费用分摊、附件、关联货件与 SKU 为同页分区） | — | 2a（P2a-11） |
| `/app/first-mile/carriers` | 物流渠道与报价 | `FirstMileCarriersPage` | `firstmile.read` | `/first-mile/carriers` | 无（物流商、渠道、阶梯报价） | — | 6（P6-26，已上线，CR-136：物流商 → 渠道树形 PagedGrid、阶梯报价抽屉 PagedGrid；头程详情增缺失字段提示与预估对比，货件接收与差异页增三种差异表） |
| `/app/settings/ship-from` | 发货地址 | `ShipFromAddressesPage` | `inbound.read` | `/ship-from-addresses` | 无（列表加抽屉，按店铺设默认地址） | A | 6（P6-08，已上线） |
| `/app/settings/label-templates` | 标签模板 | `LabelTemplatesPage` | `inbound.read` | `/label-templates` | 无（配置：勾选项、排序、纸张规格、箱号规则） | A | 6（P6-12，已上线） |
| `/app/purchase-orders` | 采购订单 | `PurchaseOrdersPage` | `purchase.read` | `/purchase-orders` | 无 | — | 2a（P2a-10） |
| `/app/purchase-orders/:id` | 采购订单详情 | `PurchaseOrderDetailPage` | `purchase.read` | `/purchase-orders/:id` | 9 个：基本信息、商品行、审批、付款、收货进度、质检、附件、关联、操作记录 | — | 2a（P2a-10） |
| `/app/suppliers` | 供应商 | `SuppliersPage` | `supplier.read` | `/suppliers` | 无 | — | 2a（P2a-10） |
| `/app/suppliers/:id` | 供应商详情 | `SupplierDetailPage` | `supplier.read` | `/suppliers/:id` | 无（资料、合作商品与报价、采购历史、交付表现、质检记录、附件为同页分区） | — | 2a（P2a-10） |
| `/app/domestic-warehouse` | 国内仓库存 | `DomesticWarehousePage` | `warehouse.read` | `/domestic-warehouse`、`/stock-counts` | 库存、流水、盘点 | — | 2a（P2a-10） |

### 2.6 订单与售后（8 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/orders` | 订单 | `OrdersPage` | `orders.read` | `/orders` | 无 | A | 2b（P2b-01） |
| `/app/orders/:id` | 订单详情 | `OrderDetailPage` | `orders.read` | `/orders/:id` | 9 个：概览、订单行、收入与费用、履约与包裹、退款与退货、财务交易、买家信息（需 `field.buyer`）、时间线、风险标记 | A、P | 2b（P2b-01） |
| `/app/returns` | 退货 | `ReturnsPage` | `returns.read` | `/returns` | 无（列表与分析视图） | A | 2b（P2b-02） |
| `/app/returns/:id` | 退货详情 | `ReturnDetailPage` | `returns.read` | `/returns/:id` | 无 | A | 2b（P2b-02） |
| `/app/reimbursements` | 赔付中心 | `ReimbursementsPage` | `reimbursements.read` | `/reimbursements/*` | 赔付机会、待提交、处理中、已到账、已拒绝、全部案件 | A | 2b（P2b-03） |
| `/app/reimbursements/:id` | 赔付案件详情 | `ReimbursementDetailPage` | `reimbursements.read` | `/reimbursements/:id` | 无 | A | 2b（P2b-03） |
| `/app/support-cases` | 支持案件 | `SupportCasesPage` | `support.read` | `/support-cases` | 无 | A、Q | 2b（P2b-04） |
| `/app/support-cases/:id` | 支持案件详情 | `SupportCaseDetailPage` | `support.read` | `/support-cases/:id` | 无 | A、Q | 2b（P2b-04） |

### 2.7 财务与利润（15 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/profit` | 利润分析 | `ProfitPage` | `profit.read` | `/profit/*` | 总览、店铺利润、ASIN 利润、广告利润、成本覆盖、利润桥对比、期间关账 | A、P | 2b（P2b-10；利润日表派生 P2b-09）；旧页在阶段 1 下线 |
| `/app/finance/profit-items` | 利润项目字典 | `ProfitItemsPage` | `finance.read` | `/finance/profit-items*` | 无（配置：左侧项目树，右侧交易类型映射） | — | 6（P6-18，已上线：项目树、交易类型映射、未映射三个页签，PagedGrid；改动先暂存，保存时带版本号） |
| `/app/finance/profit-formula` | 利润公式 | `ProfitFormulaPage` | `finance.read` | `/finance/profit-formula`、`/metric-versions` | 无（勾选表，修改走审批并形成新口径版本） | — | 6（P6-31，已上线，CR-130：公式项目勾选表 PagedGrid、待审批提示与通过/驳回/撤回、版本历史、差异报告） |
| `/app/finance/allocation-rules` | 费用分摊规则 | `AllocationRulesPage` | `finance.read` | `/finance/allocation-rules*` | 无（配置：按费用项选分摊依据，按月版本化） | — | 6（P6-19，已上线，CR-128） |
| `/app/finance/estimated-fees` | 预估与自定义费用 | `EstimatedFeesPage` | `finance.read` | `/finance/estimated-fees*` | 无（列表加抽屉） | — | 6（P6-20，已上线，CR-129：规则表 PagedGrid、新建与修改抽屉、文件导入与导出；回款率与预留金在回款与现金流页） |
| `/app/finance` | 费用事件 | `FeeEventsPage` | `finance.read` | `/finance/events` | 配送费、佣金、仓储费、库龄附加费、入仓配置费、移除与弃置费、退款、赔付、其他调整 | A | 2b（P2b-05） |
| `/app/finance/fee-audit` | 费用核查 | `FeeAuditPage` | `finance.read` | `/finance/fee-audit` | 配送费、佣金、仓储费、入仓配置费 | A | 2b（P2b-06） |
| `/app/settlements` | 结算交易 | `SettlementsPage` | `finance.read` | `/settlements` | 无 | A | 2b（P2b-07） |
| `/app/settlements/:id` | 结算详情 | `SettlementDetailPage` | `finance.read` | `/settlements/:id/*` | 无（汇总、交易明细、三方核对、异常清单、打款记录为同页分区） | A | 2b（P2b-07） |
| `/app/finance/cashflow` | 回款与现金流 | `CashflowPage` | `finance.read` | `/finance/cashflow` | 无 | A | 2b（P2b-08） |
| `/app/finance/economics` | 官方经济数据对账 | `EconomicsReconciliationPage` | `finance.read` | `/finance/economics/*` | 双源核对、费用预览、情景模拟 | A | 2b（P2b-11） |
| `/app/finance/sales-tax` | 销售税 | `SalesTaxPage` | `finance.tax.read` | `/finance/sales-tax` | 无 | A、Q | 2b（P2b-12） |
| `/app/finance/periods` | 期间关账 | `AccountingPeriodsPage` | `finance.read` | `/finance/periods` | 无 | — | 2b（P2b-13） |
| `/app/finance/periods/:id` | 关账详情 | `AccountingPeriodDetailPage` | `finance.read` | `/finance/periods/:id` | 无（完整性检查清单、预览报表、审批、锁定为同页步骤） | — | 2b（P2b-13） |
| `/app/costs` | 商品成本 | `CostsPage` | `costs.read` | `/costs` | 无（列表与详情抽屉：版本时间线、来源、构成、计价） | — | 2b（P2b-14） |

### 2.8 广告（20 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/advertising` | 广告控制台 | `AdsConsolePage` | `ads.read` | `/ads/overview` | 无 | A、P | 3（P3-05） |
| `/app/advertising/today` | 今日广告 | `AdsTodayPage` | `ads.read` | `/ads/today` | 无 | A、N | 3（P3-06） |
| `/app/advertising/campaigns` | 广告活动 | `AdsCampaignsPage` | `ads.read` | `/ads/campaigns` | 无 | A | 3（P3-07） |
| `/app/advertising/ad-groups` | 广告组 | `AdsAdGroupsPage` | `ads.read` | `/ads/ad-groups` | 无（广告层级统一骨架：广告组合树、指标区间、分类计数、汇总行、分析小窗） | A | 6（P6-23，已上线） |
| `/app/advertising/targets` | 投放 | `AdsTargetsPage` | `ads.read` | `/ads/terms?tab=targets` | 无（广告层级统一骨架：分类计数、指标区间、汇总行、分析小窗） | A | 6（P6-23，已上线） |
| `/app/advertising/search-terms` | 搜索词 | `AdsSearchTermsPage` | `ads.read` | `/ads/terms?tab=search-terms` | 无（广告层级统一骨架；分析列指向词级分析页） | A | 6（P6-23，已上线） |
| `/app/advertising/campaigns/:id` | 广告活动详情 | `AdsCampaignDetailPage` | `ads.read` | `/ads/campaigns/:id/*` | 12 个：表现趋势、分时表现、广告组、投放对象、搜索词、广告商品、广告位、创意与着陆页（仅品牌推广与展示型推广）、受众（仅展示型推广）、预算与竞价历史、预测与推荐、操作记录；提示词广告可用时增加对应页签 | A、N | 3（P3-07） |
| `/app/advertising/ad-groups/:id` | 广告组详情 | `AdsAdGroupDetailPage` | `ads.read` | `/ads/ad-groups/:id` | 7 个：表现趋势、投放对象、搜索词、广告商品、否定投放、分时表现、操作记录 | A | 3（P3-08） |
| `/app/advertising/targets/:id` | 投放对象详情 | `AdsTargetDetailPage` | `ads.read` | `/ads/targets/:id` | 6 个：趋势、带来的搜索词、广告位、分时表现、竞价历史与效果、品牌分析（仅关键词类） | A | 3（P3-08） |
| `/app/advertising/products` | 广告商品 | `AdsProductsPage` | `ads.read` | `/ads/products` | 无 | A | 3（P3-09） |
| `/app/ad-terms` | 词级中心 | `AdTermsPage` | `ads.read` | `/ads/terms` | 投放对象、搜索词、否定词库、四象限、词根分析 | A | 3（P3-10）；旧页在阶段 1 下线 |
| `/app/ad-terms/detail` | 词级分析 | `AdTermDetailPage` | `ads.read` | `/ads/terms/detail` | 无 | A | 3（P3-10） |
| `/app/advertising/portfolios` | 广告组合与预算 | `AdsPortfoliosPage` | `ads.read` | `/ads/portfolios` | 无 | A | 3（P3-11） |
| `/app/advertising/portfolios/:id` | 广告组合详情 | `AdsPortfolioDetailPage` | `ads.read` | `/ads/portfolios/:id` | 无 | A | 3（P3-11） |
| `/app/advertising/dayparting` | 分时策略 | `AdsDaypartingPage` | `ads.read` | `/ads/dayparting` | 无 | A、N | 3（P3-12） |
| `/app/advertising/rules` | 自动规则 | `AdsRulesPage` | `ads.read` | `/ads/rules` | 无 | A | 3（P3-13） |
| `/app/advertising/rules/:id` | 自动规则详情 | `AdsRuleDetailPage` | `ads.read` | `/ads/rules/:id` | 无（试运行、执行记录、规则质量为同页分区） | A | 3（P3-13） |
| `/app/advertising/changes` | 变更记录 | `AdsChangesPage` | `ads.read` | `/ads/changes` | 无 | A | 3（P3-14） |
| `/app/advertising/reports` | 广告报表 | `AdsReportsPage` | `ads.read` | `/ads/reports` | 无（报告任务、模板库、迁移期对照） | A | 3（P3-15） |
| `/app/advertising/metrics` | 广告指标 | `AdsMetricsPage` | `ads.read` | `/ads/metrics` | 无 | A | 3（P3-15） |

### 2.9 预警（5 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/alerts` | 风险预警中心 | `AlertsPage` | `alerts.read` | `/alerts` | 无（按 6 个业务域分组筛选） | P | 5（P5-01）；基础框架 1（P1-28） |
| `/app/alerts/:id` | 预警详情 | `AlertDetailPage` | `alerts.read` | `/alerts/:id` | 无 | — | 5（P5-01） |
| `/app/alerts/rules` | 预警规则配置 | `AlertRulesPage` | `alerts.manage` | `/alerts/rules` | 无 | — | 5（P5-01） |
| `/app/alerts/templates` | 规则模板 | `AlertTemplatesPage` | `alerts.read` | `/alerts/templates` | 无（按库存、广告、销售、流量、店铺分组，可从模板新建） | — | 6（P6-15，未上线） |
| `/app/account-health` | 账户健康 | `AccountHealthPage` | `account.health.read` | `/account-health` | 无 | A、Q、N | 5（P5-02） |

### 2.10 工具（4 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/competitors` | 竞品监控 | `CompetitorsPage` | `competitors.read` | `/competitors` | 无 | A | 4（P4-12） |
| `/app/competitors/:asin` | 竞品详情 | `CompetitorDetailPage` | `competitors.read` | `/competitors/:asin` | 无 | A | 4（P4-12） |
| `/app/tools/hijack` | 跟卖监控 | `HijackMonitorPage` | `tools.read` | `/tools/hijack*` | 无（列表加白名单管理） | A | 6（P6-17，未上线） |
| `/app/tools/pricing-calculator` | 新品定价试算 | `PricingCalculatorPage` | `tools.read` | `/tools/pricing-calculator/*` | 无（试算与试算记录） | A | 6（P6-29，已上线） |

### 2.11 数据与报表（4 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/reports` | 报表中心 | `ReportCenterPage` | `reports.read` | `/reports` | 按业务域分组：亚马逊物流、业务报告、品牌分析、财务、广告、数据中心 | A、Q | 5（P5-03） |
| `/app/reports/:id` | 报告任务详情 | `ReportJobDetailPage` | `reports.read` | `/reports/:id` | 无 | A | 5（P5-03） |
| `/app/my/exports` | 导出中心 | `ExportCenterPage` | 基础 | `/exports` | 无 | — | 1（P1-28） |
| `/app/help/metrics` | 指标口径 | `MetricDefinitionsPage` | 基础 | `/metrics/definitions` | 无 | — | 1（P1-28） |

### 2.12 设置（18 个路由）

| 路由 | 页面 | 组件 | 权限 | 接口 | 页签 | 特有状态 | 阶段（工作包） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/app/connections` | 连接中心 | `ConnectionsPage` | `connection.read` | `/connections` | 卖家接口、广告接口、报告权限、品牌分析资格（4 类连接） | A、Q | 5（P5-04）；广告账户与店铺绑定提前到 3（P3-03） |
| `/app/connections/notifications` | 消息推送订阅 | `NotificationSubscriptionsPage` | `connection.read` | `/notifications/subscriptions` | 无 | N | 5（P5-05）；订阅管理能力 1（P1-28） |
| `/app/sync` | 同步中心 | `SyncCenterPage` | `sync.read` | `/sync/*` | 任务、队列监控、限速状态 | — | 5（P5-06） |
| `/app/sync/:id` | 同步任务详情 | `SyncJobDetailPage` | `sync.read` | `/sync/jobs/:id` | 无 | — | 5（P5-06） |
| `/app/entities` | 法律主体 | `EntitiesPage` | `entity.read` | `/entities` | 无 | — | 5（P5-07） |
| `/app/entities/:id` | 法律主体详情 | `EntityDetailPage` | `entity.read` | `/entities/:id` | 无 | — | 5（P5-07） |
| `/app/members` | 成员 | `MembersPage` | `member.read` | `/members` | 无 | — | 5（P5-08） |
| `/app/members/:id` | 成员详情 | `MemberDetailPage` | `member.read` | `/members/:id` | 无（角色与权限、数据范围、登录与会话记录、操作审计为同页分区） | — | 5（P5-08） |
| `/app/roles` | 角色编辑器 | `RolesPage` | `role.manage` | `/roles` | 无（"模块 × 动作"矩阵；字段级权限单独区） | — | 5（P5-08） |
| `/app/audit` | 审计中心 | `AuditPage` | `audit.read` | `/audit` | 无 | — | 5（P5-09） |
| `/app/audit/:id` | 审计详情 | `AuditDetailPage` | `audit.read` | `/audit/:id` | 无 | — | 5（P5-09） |
| `/app/settings` | 企业设置 | `SettingsPage` | `settings.read` | `/settings` | 基本信息、财务口径、数据保留、刷新策略、风险规则版本、内部访问模式、接口与写入开关、汇率（后两个页签跳转子路由） | — | 5（P5-10）；财务口径页签提前到 2b（P2b-15） |
| `/app/settings/business-rules` | 业务口径 | `BusinessRulesPage` | `settings.read` | `/settings/business-rules`、`/metric-versions` | 无（每项一张卡片：当前值、影响范围、编辑） | — | 6（P6-31，已上线，CR-130：四张卡片、待审批提示、版本历史 PagedGrid） |
| `/app/settings/integrations` | 接口与写入开关 | `IntegrationSwitchesPage` | `settings.read` | `/settings/integrations` | 无 | — | 1（P1-28） |
| `/app/settings/fx` | 汇率 | `FxSettingsPage` | `settings.read` | `/settings/fx` | 无 | — | 1（P1-28） |
| `/app/settings/sku-aliases` | 外部货号映射 | `SkuAliasesPage` | `inbound.read` | `/sku-aliases`、`/packing-list-mappings` | 外部货号映射、装箱单列映射 | A | 6（P6-11，已上线） |
| `/app/profile` | 个人账号 | `ProfilePage` | 基础 | `/auth/me`、`/auth/sessions` | 个人资料、登录安全（含多因素验证）、会话管理、通知偏好 | — | 5（P5-11）；多因素与会话列表 1（P1-17） |
| `/app/my/notifications` | 消息中心 | `NotificationCenterPage` | 基础 | `/notifications` | 无 | — | 1（P1-28） |

## 三、特殊路由规则

| 路由 | 规则 |
| --- | --- |
| `/app/contact-requests` | 路由保留，**直接跳转到经营控制台** `/app/overview`；后端 `contact-requests` 接口保留；从导航移除（01 章 1.7 第 12 条） |
| `/app/bi` | **移除**；不保留跳转，直接访问显示"页面不存在"。旧的“自定义 BI”不恢复；自定义报表与仪表盘已由 CR-096 放开，改用新路由 `/app/reports/custom`、`/app/reports/custom-metrics`、`/app/dashboards`（阶段 6，P6-32、P6-33） |
| 未上线页面 | 不进导航，直接访问显示"页面不存在"，不出现"规划中" |
| 无权限页面 | 导航项隐藏；直接访问显示"无权限"页，并说明所需权限点 |
| `/app` | 重定向到 `/app/overview` |
| 未知路径 `/app/*` | "页面不存在"页 |

## 四、导航名称调整（来自 3.5）

| 原名称 | 新名称 |
| --- | --- |
| 仓库（`/app/warehouse`） | 货件接收与差异 |
| 经营报表（`/app/reports`） | 报表中心 |
| 利润分析 | 从"经营"分组移到"财务"分组（现为“财务与利润”） |
| 供应链（分组） | 并入“FBA 发货”分组，采购订单、供应商、国内仓放在该分组末尾（保留现状） |
| 运营分析（分组） | 改名“统计分析”；促销与优惠券、订阅省移到“商品与 Listing” |
| 商品（分组） | 改名“商品与 Listing”；竞品监控移到“工具”，商品成本移到“财务与利润” |
| 库存（分组） | 改名“库存与补货” |
| 财务（分组） | 改名“财务与利润” |
| 风险（分组） | 改名“预警”，并收入账户健康 |
| 连接与治理、账户（两个分组） | 合并为“设置” |

## 五、原有 `/app` 路径保留核对

原导航中的 28 个路径，处理如下：

| 原路径 | 处理 |
| --- | --- |
| `/app/overview` | 保留（内容重做） |
| `/app/profit` | 保留（移到财务分组，内容重做） |
| `/app/reports` | 保留（改名为报表中心，内容重做） |
| `/app/products` | 保留 |
| `/app/listings` | 保留 |
| `/app/purchase-orders` | 保留 |
| `/app/replenishment` | 保留 |
| `/app/supply-chain` | 保留（改为入仓计划） |
| `/app/inventory` | 保留 |
| `/app/warehouse` | 保留（改名为货件接收与差异） |
| `/app/orders` | 保留 |
| `/app/returns` | 保留 |
| `/app/finance` | 保留 |
| `/app/settlements` | 保留 |
| `/app/advertising` | 保留 |
| `/app/advertising/reports` | 保留 |
| `/app/advertising/metrics` | 保留 |
| `/app/ad-terms` | 保留 |
| `/app/bi` | **移除** |
| `/app/alerts` | 保留 |
| `/app/connections` | 保留 |
| `/app/sync` | 保留 |
| `/app/entities` | 保留 |
| `/app/members` | 保留 |
| `/app/audit` | 保留 |
| `/app/contact-requests` | 保留路由，跳转到经营控制台，不在导航显示 |
| `/app/settings` | 保留 |
| `/app/profile` | 保留 |

## 六、补充路由（来自 12 章、14 章，不在 3.5 表内）

以下页面由 12 章租户注册与 14 章 P1-19 要求，但 3.5 表没有给出路由，在此命名。**这些命名是 P0-01 新增的内容，需你确认。**

| 路由 | 页面 | 组件 | 权限 | 阶段（工作包） |
| --- | --- | --- | --- | --- |
| `/invite/:token` | 邀请激活（设置密码、开启多因素） | `InviteAcceptPage` | 公开（一次性令牌） | 1（P1-19） |
| `/app/login` | 登录（沿用现有登录页，改用新外壳样式） | `LoginPage` | 公开 | 1（P1-06） |
| `/app/onboarding` | 初始化向导（8 步，进度可保存） | `OnboardingPage` | 所有者、管理员 | 1（P1-19） |
| `/platform/login` | 平台运营后台登录 | `PlatformLoginPage` | 公开（平台账号） | 1（P1-19） |
| `/platform/tenants` | 租户列表与开通 | `PlatformTenantsPage` | `platform.tenant.read` | 1（P1-19） |
| `/platform/tenants/:id` | 租户详情（邀请、暂停、恢复、停用、注销、用量、配额） | `PlatformTenantDetailPage` | `platform.tenant.manage` | 1（P1-19） |
| `/platform/support-access` | 限时支持访问授权 | `PlatformSupportAccessPage` | `platform.support.access` | 1（P1-19） |

说明：
- `/platform/*` 与 `/app/*` 在前端分属两个入口，与租户页面共用 UI 规范但不共用会话；
- 官网路由（`src/home` 及预渲染页面）不在本清单内，保持零改动。

## 七、统计与核对

| 分组 | 路由数 |
| --- | --- |
| 首页 | 5 |
| 统计分析 | 14 |
| 商品与 Listing | 12 |
| 库存与补货 | 12 |
| FBA 发货 | 14 |
| 订单与售后 | 8 |
| 财务与利润 | 15 |
| 广告 | 20 |
| 预警 | 5 |
| 工具 | 4 |
| 数据与报表 | 4 |
| 设置 | 18 |
| **合计（3.5 表展开后 107 个，加阶段 6 新增 24 个）** | **131** |
| 补充路由（第六节） | 7 |
| **清单总数** | **138** |

核对方法：用脚本把 03 章 3.5 表中所有反引号内的路由展开（含花括号写法的 `brand/{...}`），与本文件第二节（P6-00 之前）的路由集合逐项比对，两边都是 107 个，**无多无少**；P6-00 在此基础上只做两件事：把 107 个路由重新归入 12 个新分组（路径不变），再按 16 章登记 20 个【新】路由（阶段 6，未上线）。组件名全部唯一，每个路由对应一个独立组件。`/app/contact-requests` 与 `/app/bi` 不在 3.5 表内，属第三节特殊规则，不计入。

## 八、阶段 6 对既有页面的改版登记（路径不变，仅登记，不改变上线状态）

下表的页面在 16 章标【改】或要求改版，路径与组件名不变；改版随对应工作包交付，交付前仍按现有页面运行。

| 页面 | 路径 | 改版内容 | 阶段（工作包） |
| --- | --- | --- | --- |
| ASIN 360 | `/app/products/:id` 等 | 12 个页签改成锚点长页；新增竞品对比、预警日志、退货周期区块 | 6（P6-21） |
| 退货 | `/app/returns` | 分析视图独立成页签组：概览、按 ASIN、按原因、按处置结果、退货周期、跨月退货 | 6（P6-13） |
| 入仓计划详情 | `/app/supply-chain/:id` | 改成五步流程骨架（选品、装箱、分仓、运输、标签与发货），装箱可视编辑器 | 6（P6-10、P6-11、P6-12） |
| 补货建议 | `/app/replenishment` | 一键转入仓计划草稿；计算链拆开；必断货量；人工预测规则 | 6（P6-08、P6-09） |
| 预警中心与规则配置 | `/app/alerts`、`/app/alerts/rules` | 两套状态与合并；条件构造器、通知频率、静默汇总、多级升级 | 6（P6-15、P6-16） |
| 定价与购物车 | `/app/pricing` | 定价规则增加“情形 × 动作”模板 | 6（P6-17） |
| 促销与优惠券 | `/app/promotions` | 快捷筛选卡与促销叠加预警 | 6（P6-17） |
| 竞品监控 | `/app/competitors` | 记录初始值与变动事件，A 到 D 分级，接入 ASIN 360 竞品对比 | 6（P6-21） |
| 利润分析 | `/app/profit` | 列与明细浮层按利润项目字典渲染，关税进利润桥 | 6（P6-18） |
| 广告层级页 | `/app/advertising/campaigns` 等 | 活动、广告组、投放、搜索词、广告商品共用宽表骨架，下钻改弹窗 | 6（P6-23、P6-24） |
| 经营控制台 | `/app/overview` | 新增“波动异常”区块（本期、上期、上上期） | 6（P6-28） |
| 其余存量列表页 | 各自现有路径 | 迁移到列表或宽表骨架，不改业务逻辑与接口语义 | 6（P6-28） |
