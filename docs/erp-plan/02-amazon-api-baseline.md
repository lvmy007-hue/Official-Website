# 02 亚马逊接口基线（2026 年 10 月 21 日核实）

本章是所有板块设计的数据依据。每个板块的数据来源只能取自本章列出的接口、报告与推送；没有官方来源的数据，只能来自我方录入、我方计算或卖家授权的文件导入，并在界面标注来源。实施前，每个接口按官方当期文档再复核一次。

## 2.1 卖家接口（纳入本次范围）

| 能力 | 接口与版本 | 主要操作 | 在本系统中的用途 | 备注 |
|---|---|---|---|---|
| 订单 | `Orders API v2026-01-01` | `searchOrders`、`getOrder`，按 `includedData` 取买家、收货、履约、收入明细、费用、促销、取消、包裹、税、付款 | 订单列表与详情、收入与费用明细、取消执行方与原因、包裹追踪、促销折扣 | 取代旧版 10 个操作；买家个人信息按角色访问，不再需要受限数据令牌；分页令牌 24 小时过期 |
| 财务 | `Finances API v2024-06-19` | `listTransactions`、`listBalances`、`listSummary` | 交易流水、递延与释放状态、账户余额、汇总 | 交易状态含递延、已释放、递延后释放；旧版财务事件三个操作计划于 2027 年 8 月 27 日移除；最近 48 小时订单可能尚未出现 |
| 数据中心 | `Data Kiosk API v2023-11-15` | 提交查询、查询状态、取结果文档 | 见下两行数据集 | 异步查询，结果保留 30 天，必须落库 |
| 数据中心 · 销售与流量 | `analytics_salesAndTraffic_2024_04_24` | `salesAndTrafficByAsin`（父体、子体、SKU 粒度）、`salesAndTrafficByDate`（日、周、月）、`salesAndTrafficTrends`（ASIN 级趋势） | 业务报告、ASIN 流量转化、购物车获得率 | 必须传站点；2023 版数据集已于 2026 年 3 月 26 日移除 |
| 数据中心 · 单品经济 | `analytics_economics_2024_03_15` | `economics`（销售、费用分项、广告、卖家提供的单位成本、净收益）、`economicsPreview`（未来最多 120 天的费用预估）、`economicsSimulation`（按动作类型模拟，每次最多 100 个商品，最远 90 天） | 利润官方对照、费用变化预估、补货与发往上游仓储的情景模拟 | "净收益"不等于利润，系统需另行扣除采购、头程等成本 |
| 报告 | `Reports API v2021-06-30` | 创建、查询、下载、定时 | 各类报告（见 2.3） | 未注明保留期的报告保留 90 天 |
| 入仓 | `Fulfillment Inbound API v2024-03-20` | 创建计划；生成、列出、确认装箱方案；提交箱内物品信息；生成、列出、确认分仓方案（含费用、折扣、过期时间）；查看货件与货件明细；列出箱子；生成、列出、确认运输方案；送达时间窗；更新追踪信息；取消计划；查询异步操作状态 | 入仓计划全流程 | 所有写操作异步，需轮询操作状态；取消计划的作废窗口：小包裹确认后 24 小时、零担与整车确认后 1 小时 |
| 入仓资格 | `FBA Inbound Eligibility API` | 发货前资格预检 | 入仓前检查 SKU 是否可入仓 | — |
| 亚马逊仓储分销 | `Amazon Warehousing and Distribution API v2024-05-09` | 入库订单创建、更新、取消、确认；入库货件查询（含 SKU 预期与接收、有效期、预处理信息）；箱标签；更新运输信息；库存（含有效期、补货订单预留、发往上游仓储在途、上游仓储发往亚马逊物流在途） | 上游仓储板块、补货计算中的上游库存 | 仅美国站 |
| 亚马逊物流库存 | `FBA Inventory API v1` | 库存汇总 | 可售、在途、预留、不可售、调查中的实时数量 | 实时数量以此接口为准，报告用于历史与分析 |
| 商品目录 | `Catalog Items API v2022-04-01` | 查询、获取商品 | 属性、图片、父子关系、销售排名、类目 | — |
| 刊登 | `Listings Items API v2021-08-01` | 获取、修改、局部修改、删除 | 刊登状态、问题项、报价、价格修改（含价格校验） | 写操作受写入开关控制 |
| 刊登限制 | `Listings Restrictions API v2021-08-01` | 查询限制 | 刊登前限制与审批要求 | — |
| 商品类型定义 | `Product Type Definitions API v2020-09-01` | 查询定义 | 属性必填项、刊登质量检查 | — |
| 定价 | `Product Pricing API v2022-05-01` | `getFeaturedOfferExpectedPriceBatch`（每批最多 40 个 SKU，返回获得推荐报价的预期价格）、`getCompetitiveSummary`（每批最多 20 个 ASIN，返回推荐购买选项、按会员与非会员分段的浏览权重、参考价、最低报价） | 购物车与定价、竞品价格 | 参考价类型 `CompetitivePriceThreshold` 已于 2025 年 9 月 30 日移除 |
| 商品费用 | `Product Fees API v0` | 费用预估 | 费用核查、定价模拟 | 预估不保证与实际一致 |
| 客户反馈 | `Customer Feedback API v2024-06-01` | 商品评论主题（前 10 正面、前 10 负面）、类目评论主题与 6 个月趋势（全部商品与前 25% 商品对比）、类目退货主题与趋势 | 评价与反馈、退货原因洞察 | 不提供平均星级与评分数；退货洞察只到类目级 |
| 请求评价 | `Solicitations API v1` | 查询可用动作、发起请求 | 请求评价 | 订单送达后第 5 至 30 天内；受写入开关控制 |
| 促销 | `Promotions API v2025-12-01` | `searchPromotions`、`getPromotion`、`getSelection` | 秒杀、优惠券、价格折扣、满减的状态、商品与校验问题 | 与促销、优惠券表现报告通过映射编号关联 |
| A+ 内容 | `A+ Content Management API v2020-11-01` | 内容查询、创建、更新、关联 ASIN、提交审核、查询审核状态 | A+ 内容板块 | 写操作受写入开关控制；图片经 `Uploads API` 上传 |
| 订阅省 | `Replenishment API v2022-11-07` | 卖家指标、报价列表 | 订阅省板块 | 订阅省两份旧报告已于 2025 年 12 月 11 日移除，改用本接口 |
| 卖家支持案件 | `Support API v2025-02-01` | `listCases`、`getCase`、`listContacts` | 支持案件只读同步，关联赔付案件 | 需受限角色"卖家支持" |
| 物流追踪 | `Tracking API v2026-01-30` | `getShipmentTracking` | 亚马逊供应链内货件节点 | 仅美国、免授权；对入仓货件的适用范围实施时验证 |
| 消息推送 | `Notifications API v1` | 目的地、订阅、过滤表达式 | 近实时事件（见 2.4） | 接收端（亚马逊消息队列）属部署专项 |
| 批量与上传 | `Feeds API v2021-06-30`、`Uploads API v2020-11-01` | 批量刊登、文件上传 | 批量价格与刊登修改、A+ 图片 | — |
| 卖家信息 | `Sellers API v1` | 参与的站点与账户信息 | 连接中心 | — |

## 2.2 卖家接口（不纳入本次范围）

多渠道配送（`Fulfillment Outbound`）、买家消息（`Messaging`）、自发货相关（`Merchant Fulfillment`、`Shipping`、`Easy Ship`）、外部履约、供应商中心全部接口、巴西发票、车辆、服务订单、卖家钱包与转账、在卖家后台显示通知（`App Integrations`）。

## 2.3 报告类型（纳入本次范围）

| 业务域 | 报告类型 | 用途 |
|---|---|---|
| 订单 | `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`、`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` | 订单历史回补与增量 |
| 订单 | `GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL`、`GET_AMAZON_FULFILLED_SHIPMENTS_DATA_TAX` | 承运商、追踪号、发货时间、税 |
| 订单 | `GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA` | 替换订单 |
| 订单 | `GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_PROMOTION_DATA`、`GET_FBA_FULFILLMENT_CUSTOMER_TAXES_DATA` | 促销与税明细 |
| 库存 | `GET_FBA_INVENTORY_PLANNING_DATA` | 库存健康：库龄分段、超额、7/30/60/90 天销量、建议动作、建议售价与促销天数、建议移除量、低库存水平费、最低库存水平、历史可售天数、季节性、建议发货量与日期、库龄附加费分段预估、长期仓储费、预留拆分 |
| 库存 | `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`、`GET_FBA_MYI_ALL_INVENTORY_DATA`、`GET_AFN_INVENTORY_DATA` | 库存快照 |
| 库存 | `GET_LEDGER_DETAIL_VIEW_DATA`、`GET_LEDGER_SUMMARY_VIEW_DATA` | 库存台账（明细与汇总） |
| 库存 | `GET_RESERVED_INVENTORY_DATA` | 预留拆分 |
| 库存 | `GET_STRANDED_INVENTORY_UI_DATA` | 滞留库存 |
| 库存 | `GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT` | 亚马逊官方补货建议（与我方补货建议双源核对） |
| 库存 | `GET_FBA_RECOMMENDED_REMOVAL_DATA` | 亚马逊推荐移除 |
| 库存 | `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA`、`GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` | 移除订单与移除货件 |
| 费用 | `GET_FBA_STORAGE_FEE_CHARGES_DATA` | 月度仓储费，含仓储利用率与利用率附加费 |
| 费用 | `GET_FBA_OVERAGE_FEE_CHARGES_DATA` | 超出仓储限额费 |
| 费用 | `GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA` | 长期仓储费 |
| 费用 | `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` | 预估配送费（费用核查基准） |
| 费用 | `GET_REFERRAL_FEE_PREVIEW_REPORT` | 佣金预览 |
| 入仓 | `GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA` | 入仓不合规问题 |
| 售后 | `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | 退货明细 |
| 售后 | `GET_FBA_REIMBURSEMENTS_DATA` | 赔付明细 |
| 结算 | `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | 结算报告（另两种结算格式于 2026 年 11 月 11 日移除，不再使用） |
| 刊登 | `GET_MERCHANT_LISTINGS_ALL_DATA`、`GET_MERCHANT_LISTINGS_INACTIVE_DATA`、`GET_MERCHANT_CANCELLED_LISTINGS_DATA` | 刊登全量与非活跃 |
| 刊登 | `GET_MERCHANTS_LISTINGS_FYP_REPORT` | 被搜索抑制的商品 |
| 业务报告 | `GET_SALES_AND_TRAFFIC_REPORT` | 数据中心的补充来源 |
| 品牌分析 | `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`、`GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT`、`GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`、`GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT`、`GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT` | 品牌分析 5 页 |
| 促销 | `GET_PROMOTION_PERFORMANCE_REPORT`、`GET_COUPON_PERFORMANCE_REPORT` | 促销与优惠券效果，含促销接口映射编号 |
| 账户 | `GET_V2_SELLER_PERFORMANCE_REPORT` | 账户健康各项指标 |
| 税务 | `GET_FLAT_FILE_SALES_TAX_DATA`（仅美国站、仅卖家；不能通过 `createReport` 申请或排程，必须由卖家在卖家后台税务文档库生成后，用 `getReports` 按类型检索；所需角色为税务汇缴（受限）；保留期最长 90 天） | 销售税 |

已移除、禁止使用的旧报告：`GET_FBA_FULFILLMENT_CURRENT_INVENTORY_DATA`、`GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA`、`GET_FBA_FULFILLMENT_INVENTORY_RECEIPTS_DATA`、`GET_FBA_FULFILLMENT_INVENTORY_SUMMARY_DATA`、`GET_FBA_FULFILLMENT_MONTHLY_INVENTORY_DATA`、`GET_FBA_RECONCILIATION_REPORT_DATA`、`GET_FBA_INVENTORY_AGED_DATA`、`GET_EXCESS_INVENTORY_DATA`、`GET_FBA_SNS_FORECAST_DATA`、`GET_FBA_SNS_PERFORMANCE_DATA`、`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE`、`GET_V2_SETTLEMENT_REPORT_DATA_XML`。

## 2.4 消息推送类型（纳入本次范围）

| 推送类型 | 内容 | 用途 |
|---|---|---|
| `ITEM_SALES_EVENT_CHANGE` | 每小时 ASIN 级销售（含延迟最长 24 小时的补发） | 今日实时、小时级异常 |
| `DETAIL_PAGE_TRAFFIC_EVENT` | 每小时 ASIN 级详情页流量 | 今日实时、流量骤降预警 |
| `ITEM_INVENTORY_EVENT_CHANGE` | 每小时 ASIN 级可售数量 | 实时断货预警 |
| `FBA_INVENTORY_AVAILABILITY_CHANGES` | 亚马逊物流库存变化快照 | 库存实时刷新 |
| `ANY_OFFER_CHANGED` | 前 20 个报价变化、外部价格变化 | 购物车与竞品价格 |
| `PRICING_HEALTH` | 因价格不具竞争力失去推荐报价资格 | 购物车风险预警 |
| `FEE_PROMOTION` | 费用促销生效 | 费用变化提醒 |
| `LISTINGS_ITEM_STATUS_CHANGE`、`LISTINGS_ITEM_ISSUES_CHANGE` | 刊登状态与问题变化 | 刊登质量与合规 |
| `ITEM_PRODUCT_TYPE_CHANGE`、`PRODUCT_TYPE_DEFINITIONS_CHANGE` | 商品类型与类型定义变化 | 刊登合规 |
| `BRANDED_ITEM_CONTENT_CHANGE` | 品牌商品详情页内容被修改 | 品牌内容守护（含他人修改） |
| `ORDER_CHANGE` | 订单重要变化（状态、买家取消请求） | 订单增量同步 |
| `TRANSACTION_UPDATE` | 新交易入账 | 财务增量同步 |
| `REPORT_PROCESSING_FINISHED`、`FEED_PROCESSING_FINISHED` | 报告、批量任务完成 | 替代轮询 |
| `ACCOUNT_STATUS_CHANGED` | 账户状态在正常、有风险、停用之间变化 | 账户健康即时告警 |
| `SHIPMENT_TRACKING_MILESTONE_CHANGED` | 订阅的货件追踪节点变化 | 货件节点追踪 |

多数推送支持过滤表达式，可按站点与 ASIN 过滤以减少噪音。

## 2.5 广告接口

| 能力 | 接口与版本 | 要点 | 在本系统中的用途 |
|---|---|---|---|
| 统一接口 | `Amazon Ads API v1`（路径 `/adsApi/v1`） | 所有广告产品共用一套模型：广告活动、广告组、广告、投放对象、广告关联、广告扩展、品牌旗舰店、活动预测、推荐与推荐类型、品牌关键词定价；测试中：事件、规则、标签、账户。以广告账户编号为作用域 | 新集成全部基于统一接口：活动管理、预测、推荐 |
| 新报告接口 | `Reporting API v1`（`/adsApi/v1/create/reports`、`/adsApi/v1/retrieve/reports`） | 2026 年 9 月 30 日正式发布；不再按报告类型，而是自由组合维度与指标，可跨广告产品；按小时数据保留 14 天（单报告最多 14 天），按日保留 15 至 24 个月，以接口实测为准（单报告最多 120 天），按月保留 6 年（单报告最多 25 个月）；按流量日期归因；返回警告信号 | 全部广告报表 |
| 营销数据流 | `Amazon Marketing Stream v2` | 2026 年 9 月 30 日正式发布；`ads-performance-v1`（小时级，最快每 15 分钟更新，约 400 项指标、50 余个维度，覆盖全部广告产品）；`ads-converted-product-v1`（日级，ASIN 级转化，含光环销售）；订阅后回补 70 天；投递到我方存储桶并发队列通知；不含预算消耗与实体变更数据集；投放对象只带编号；低于阈值的搜索词归为"其他" | 今日广告、分时分析、日内预算监控 |
| 旧版 | 商品推广第三版、品牌推广第四版、展示型推广、报告第三版（`/reporting/reports`）、营销数据流第一版 | 据亚马逊 2026 年 9 月弃用通知，报告第三版、营销数据流第一版与商品推广第二版报告于 2027 年 6 月 30 日停止 | 仅作迁移期并行核对，不再新增依赖 |
| 广告智能体服务 | 亚马逊广告 MCP 服务（开放测试） | 面向智能体的广告操作与查询 | 不纳入生产，后续评估 |

## 2.6 对现有代码的迁移影响

| 现有实现 | 迁移到 | 截止约束 |
|---|---|---|
| 订单接口旧版 | `Orders API v2026-01-01` | 新版已是当前版本，迁移即可获得收入明细、包裹、取消原因等字段 |
| 财务接口旧版事件 | `Finances API v2024-06-19` | 旧版 2027 年 8 月 27 日移除 |
| 业务报告依赖报告 | 数据中心销售与流量数据集为主 | — |
| 广告商品推广第三版列表接口、报告第三版 | 广告统一接口 + 新报告接口 | 2027 年 6 月 30 日停止 |
| 结算报告 | 只用 `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | 另两种格式 2026 年 11 月 11 日移除 |
| 入仓预处理与贴标选项 | 固定为卖家 | 美国站 2026 年 1 月 1 日起生效 |

迁移期间新旧并行：同一时间范围的数据双跑核对，差异按"时间口径、归因口径、范围、未解释"四类记录，核对通过后关闭旧通道。

## 2.7 待实施时验证的事项

1. 物流追踪接口是否覆盖入仓货件（目前文档描述为"外部渠道货件"）。
2. 平均星级与评分数是否存在官方接口来源；无则采用文件导入。
3. 亚马逊销售税报告的确切类型。（已验证：`GET_FLAT_FILE_SALES_TAX_DATA`，见 2.3；验证结论见 `freeze/verification-log.md`。）
4. 广告统一接口中预算规则、分时能力、提示词广告报告的可用性与正式状态。
5. 广告统一接口请求头的最终要求（广告账户编号与旧作用域的兼容方式）。
6. 汇率主源（官方人民币汇率中间价）的程序化获取方式与使用条款。
7. 各接口实际速率限额（以响应头为准，按店铺动态调整）。
