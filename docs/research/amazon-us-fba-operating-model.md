# Amazon.com 美国站 FBA 业务口径

本项目的 ERP 前端以 Amazon.com / United States / FBA 为默认经营范围，不再用 UK、DE、CA 的混合示例替代美国站业务对象。

## 页面与 FBA 对象映射

| ERP 模块 | 美国站 FBA 对象 | 主要可执行动作 |
| --- | --- | --- |
| FBA 运营控制台 | FBA Inventory、Inbound Shipment、FC Receiving、Settlement | 处理补货、货件差异、滞留库存、费用核对 |
| ASIN / SKU 主数据 | ASIN、Seller SKU、FNSKU、尺寸段、包装尺寸、重量、刊登 | 维护目录、库存执行标识、尺寸和合规状态 |
| FBA 库存健康 | Sellable、Reserved、Inbound、Unfulfillable、Days of Supply、Excess、Aged、Stranded | 补货、移除、弃置、恢复刊登、库龄处置 |
| 采购与 FBA 入库 | Restock recommendation、Shipping Plan、Shipment ID、Placement、Carrier、Receiving | 生成货件、选择入仓配置、跟踪接收、创建差异/赔付任务 |
| FBA 货件与仓库 | Fulfillment Center、容量使用、Receiving、Shipment discrepancy | 跟踪 ONT8、PHX7、ABE8 等 FC 和接收差异 |
| FBA 订单 | Amazon Order ID、FBA fulfillment、承运商、追踪、交付承诺 | 追踪 Amazon 接单、FBA 处理、配送和客户签收 |
| FBA 退货与赔付 | Customer Return、Disposition、Unfulfillable、Reimbursement case | 核对退款、退货库存状态、移除/弃置和赔付 |
| FBA 费用与结算 | Fulfillment fee、Storage、Storage utilization surcharge、Aged inventory、Low-inventory-level、Inbound placement、Removal | 按 settlement / Fee Preview 对账和归因 |

## 设计约束

- 默认站点为 Amazon.com，币种 USD，时间口径 US Eastern Time。
- FBA 订单不走自发货分配；FBA 订单页面显示 Amazon 处理、履约中心、承运商和交付事件。
- 库存不能只显示“可售/在途”，必须拆分 Sellable、Reserved、Inbound、Unfulfillable，并显示 Days of Supply、库龄、冗余和滞留。
- 产品不能只显示内部 SKU，必须同时显示 ASIN、Seller SKU、FNSKU、尺寸段、包装尺寸和重量，因为尺寸段会影响履约费与仓储费。
- 入库不能只显示采购单，必须显示 Shipping Plan、Shipment ID、目的 FC、placement 方案、运输、Receiving 和数量差异。
- 财务必须区分 FBA 履约费、月度仓储费、储存利用率附加费、库龄附加费、低库存费、入仓配置费、移除/弃置和赔付，广告费不混入 FBA 费用。

## 官方依据

- [Amazon FBA overview](https://sell.amazon.com/fulfill.html)
- [Amazon FBA inventory management](https://sell.amazon.com/fulfill.html#inventory-management)
- [Amazon Global Logistics and placement](https://sell.amazon.com/programs/amazon-global-logistics)
- [Amazon Warehousing and Distribution](https://sell.amazon.com/programs/warehousing)
- [Amazon FBA fee guide](https://sell.amazon.com/blog/fba-fees-guide)

## SP-API 数据域与系统接口映射

本项目的生产数据入口按 Amazon 官方 API 域拆分，不能用一个“同步 Amazon”接口混合所有数据：

| 系统数据域 | Amazon 官方 API / 报告 | NOVA 落库对象 | 页面动作 |
| --- | --- | --- | --- |
| Catalog / Listing | Catalog Items API、Listings Items API、Listings Restrictions API | `FbaProduct` | 查 ASIN、Seller SKU、FNSKU、刊登状态、尺寸和合规 |
| FBA Inventory | FBA Inventory API、FBA inventory reports | `FbaInventoryRecord` | 拆分可售、预留、入仓、不可售、库龄、Days of Supply、滞留 |
| Inbound | Fulfillment Inbound API v2024-03-20 | `FbaInboundPlan`、`FbaInboundShipment` | 创建入库计划、生成/确认 Placement、运输选项、Receiving、差异 |
| Orders | Orders API、Reports API | `Order`、订单明细 | Amazon Order ID、FBA 履约状态、配送承诺、退货关联 |
| Finance | Finances API、Reports API | `FbaFeeEvent` | 按结算事件、ASIN、SKU、Shipment、费用类型对账 |
| Returns | Orders API、FBA reports、Finances API | `FbaReturnCase` | 退款、Disposition、不可售处置、赔付核对 |
| Async / evidence | Reports API、Notifications API、Worker | `SyncJob`、`AuditEvent` | 排队、生成、下载、失败、重试、Request ID、审计 |

美国站生产连接使用 North America SP-API endpoint `sellingpartnerapi-na.amazon.com`（AWS 区域 `us-east-1`），通过 LWA access token 调用；Inbound v2024-03-20 的流程必须将 plan、placement、transportation、shipment 和 receiving 分阶段持久化，不能用一个假“已完成”状态代替官方流程。

## 已落地的后端边界

- `GET /api/v1/fba/products`：Catalog / Listing 视图。
- `GET /api/v1/fba/inventory`：FBA Inventory 健康视图。
- `GET /api/v1/fba/inbound-plans`：Inbound Plan 与 Shipment 视图。
- `GET /api/v1/fba/fees`：Finances / settlement 费用事件视图。
- `GET /api/v1/fba/returns`：退货和赔付核对视图。
- `POST /api/v1/fba/inbound-plans`：创建本地入库计划意图并进入 Worker 队列，生产 Worker 再调用官方 Inbound API。
- `POST /api/v1/fba/sync/jobs`：按数据域创建可追踪同步任务。
- `GET/POST /api/v1/reports/jobs`：创建并跟踪 Amazon Reports API 报表任务。
- `POST /api/v1/sync/jobs/:id/retry`：对失败同步执行权限校验后重新入队。
- `GET /api/v1/sp-api/oauth/callback`：校验一次性 state，调用 LWA authorization-code exchange，并使用 AES-256-GCM 加密保存 Refresh Token。

真实 API 的请求签名、各数据域 importer、Amazon 应用审批和生产数据权限仍必须在部署环境配置；OAuth 回调的 state 校验、LWA token exchange 和 Refresh Token 加密保存已经落地。Worker 在连接器未完整配置时会 fail-closed，不会把样例数据标成 Amazon 实时数据。

页面中的金额和 SKU 是本地演示数据；接入生产环境时，必须以 Seller Central / SP-API 返回的实时报告和事件为准，不能把示例值当作 Amazon 真实账单。
