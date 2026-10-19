# NOVA ERP 当前版本完整缺口审计

审计日期：2026-10-19

## 结论

当前版本已经有企业壳层、浅色视觉基线和部分 FBA 数据对象，但还不能称为可商用 ERP。主要原因不是页面数量不足，而是“业务对象—状态—动作—结果—审计”没有形成闭环。页面大部分仍是静态示例，真实服务端数据没有进入工作台，任务执行器也没有连接 Amazon。

## 一、现有实现盘点

### 前端

当前路由已经覆盖经营概览、订单、退货、商品、供应链、库存、仓库、财务、广告、报表、连接、同步和治理页面。但活跃 FBA 页面主要在 `src/App.tsx` 中使用硬编码数组渲染：

- `FbaOverviewPage`、`FbaProductsPage`、`FbaSupplyChainPage`、`FbaInventoryPage`、`FbaWarehousePage`、`FbaFinancePage`、`FbaReturnsPage`、`FbaConnectionsPage`、`FbaSyncPage` 没有读取对应的 `/api/v1/fba/*` 数据。
- 已审计到 60 处以上的按钮只调用 `Message.info/success/error`，没有创建业务记录、提交任务、打开真实对象详情或生成文件。
- 查询栏、状态筛选、分页、列配置和批量操作大多只改变本地 UI 或弹提示；生产模式没有统一的 loading、empty、error、permission denied 状态。
- 页面仍保留旧的通用经营页面和英国/德国示例数据，虽然当前默认范围已经改为 Amazon.com，但代码中仍存在容易误路由的旧实现。

### API

当前 API 已有认证、订单、通用库存、连接、同步和部分 FBA CRUD：

- 已有：`/fba/summary`、`/fba/products`、`/fba/inventory`、`/fba/inbound-plans`、`/fba/fees`、`/fba/returns`、创建入仓计划、创建 FBA 同步任务。
- 缺少：订单行与配送事件、采购/供应商/采购收货、货件箱与标签、运输选项、FC 接收证据、报表任务、settlement 对账批次、赔付案件、广告对象层级、Notifications、文件导出和下载权限。
- `GET /sp-api/oauth/callback` 仍然主动抛出 `LWA_TOKEN_EXCHANGE_NOT_CONFIGURED`。
- `POST /sp-api/oauth/start` 只创建授权状态和 URL，没有完整的回调换 token、refresh token 加密保存、Seller Account 绑定和健康检查闭环。

### 数据库

当前 schema 有 `Tenant`、`LegalEntity`、`SellerAccount`、`PlatformConnection`、`SyncJob`、`Order`、`InventorySnapshot` 和若干 FBA 基础对象。缺失的生产级对象包括：

| 领域 | 必须持久化的对象 | 当前状态 |
| --- | --- | --- |
| 商品 | Catalog、Listing、变体、合规、图片、价格 | 仅有简化 `FbaProduct` |
| 订单 | Order Item、地址/配送承诺、Shipment、Tracking、取消/退款事件 | 仅有订单头 |
| 采购 | Supplier、Purchase Plan、Purchase Order、PO Line、到货/质检 | 缺失 |
| FBA 入仓 | Plan Item、Packing Group、Box、Label、Placement、Transportation、Receiving | 只有计划和货件简表 |
| 库存 | 库龄分桶、库存流水、滞留原因、处置/移除、补货规则 | 只有库存快照和少量健康字段 |
| 财务 | Settlement、Transaction、Fee Attribution、Reconciliation、Reimbursement Case | 只有费用事件 |
| 广告 | Profile、Campaign、Ad Group、Target、Search Term、Budget Rule、Report | 没有持久化模型 |
| 报表 | Report Request、生成状态、下载地址、到期时间、失败原因 | 页面为硬编码列表 |

### Worker / 外部连接

当前 Worker 的行为是：找到 `SyncJob` 后将其设置为 `RUNNING`；非 mock 环境直接设置为 `FAILED_PERMANENT/EXTERNAL_NOT_CONFIGURED`；mock 环境等待 300ms 后标记成功。也就是说，当前还没有：

- LWA access token 获取与缓存；
- North America SP-API endpoint `sellingpartnerapi-na.amazon.com` / `us-east-1` 配置；
- AWS SigV4 请求签名、限流、重试、退避和 request ID 记录；
- Catalog、Listings、Orders、Inventory、Inbound、Finances、Reports、Returns 的独立同步器；
- 报告生成、下载、解压、校验、导入和幂等 upsert；
- 真实错误分类、人工重试和死信处理。

## 二、按 Amazon 美国站 FBA 业务链路重建范围

本项目默认范围为 `Amazon.com / United States / FBA / USD / US Eastern Time`。正式工作台应围绕以下链路组织，而不是以图表为主：

1. **Catalog / Listing**：ASIN、Seller SKU、FNSKU、产品类型、变体、价格、刊登状态、合规限制。
2. **采购与补货**：供应商、采购计划、采购单、成本、到货、质检、补货建议和批准。
3. **Inbound**：Inbound Plan → items → placement options → transportation options → shipment → carton/label → tracking → FC receiving → discrepancy/reimbursement。
4. **Inventory**：Sellable、Reserved、Inbound、Unfulfillable、Researching、Stranded、Aged、Excess、Days of Supply 和处置动作。
5. **Orders / Returns**：Amazon Order ID、订单行、FBA fulfillment、shipment、承运商、追踪、交付承诺、退款和退货 disposition。
6. **Finance**：Settlement、订单收入、FBA 履约费、仓储费、入仓配置费、库龄附加费、低库存费、移除/弃置、广告成本和赔付。
7. **Ads**：Profile → Campaign → Ad Group → Target/Keyword → Budget/Bid → Search Term/Placement → Report → 规则动作。
8. **Reports / Governance**：异步生成、下载、过期、失败重试、权限、审计和数据新鲜度。

## 三、修改优先级

### P0：本轮必须改

- 建立统一对象工作台组件：服务端读取、分页、查询、状态筛选、详情抽屉、创建/重试动作、错误和空状态。
- 把 FBA 商品、库存、入仓、费用、退货、同步、连接页面接入现有 API；本地模式只能显示带“演示数据”标记的 fixtures。
- 将“新建同步”“创建入仓计划”“导出/生成报表”变成真实任务创建，不再只弹 toast。
- 补充报表任务、订单行、采购单/供应商、赔付案件的持久化边界和 API 入口。
- Worker 将任务处理改成可扩展的 connector pipeline；未配置生产凭证时显示明确失败原因，不得伪造成功。

### P1：紧接着补齐

- 完成 LWA 回调、Refresh Token 密文存储、SP-API 请求签名、限流和健康检查。
- 完成 Inbound v2024-03-20 的 placement、transportation、packing、labels、tracking、receiving 阶段。
- 完成订单行、shipment、退货和赔付证据链；财务按 settlement 对账。
- 完成 Ads Profile/Campaign/Ad Group/Keyword/Report 的真实对象层级和批量写入审计。

### P2：上线前验收

- 阿里云 ECS / RDS PostgreSQL / Redis / OSS / HTTPS / WAF / 备份恢复；
- 真实 Amazon US 应用审批和 Seller Central 授权；
- 端到端验收：登录、授权、同步、列表、详情、动作、失败、重试、导出和审计；
- 权限矩阵、数据隔离、敏感信息加密、日志脱敏、速率限制和灾备演练。

## 四、验收标准

一个模块只有同时满足以下条件，才能标记为“已落地”：

- 有明确业务对象和唯一 ID；
- 有服务端数据源或明确的演示数据标识；
- 列表支持查询、筛选、分页、状态和空/错/加载状态；
- 行可以打开详情，详情能看到来源、更新时间、关联对象和状态历史；
- 页面动作会创建或更新服务端记录，进入任务队列并显示 request ID；
- 失败能展示原因、下一步和重试入口；
- 敏感写操作有权限校验和审计事件；
- 真实连接未配置时，系统明确显示“未配置/等待授权”，不能显示“已同步/已完成”。

## 官方与行业依据

- [Amazon Selling Partner API](https://developer-docs.amazon.com/sp-api)
- [Amazon Fulfillment Inbound API v2024-03-20](https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api)
- [Amazon SP-API connection guide](https://developer-docs.shipping.amazon.com/apis/docs/connecting-to-the-selling-partner-api)
- [Amazon SP-API endpoints](https://developer-docs.shipping.amazon.com/apis/docs/sp-api-endpoints)
- [领星 OpenAPI 业务目录](https://apidoc.lingxing.com/new)
- [sellerboard](https://sellerboard.com/)
