# P0-08 现状基线

> 记录时间：2026-10-21。本文件是阶段 0 的现状快照，后续所有阶段的"官网零改动""不退化"核对均以此为准。
> 对应执行计划：`14-execution-plan.md` 工作包 P0-08。

## 一、版本库状态

| 项 | 值 |
| --- | --- |
| 分支 | `codex/commercial-site-payment` |
| 最近提交 | `07d9311 chore: checkpoint production website and ERP baseline` |
| 工作区未提交文件数 | 63（含已修改与未跟踪） |
| 提交策略 | 不提交代码，除非用户明确要求 |

### 需要用户知晓的事实

官网相关源码相对最近提交已有未提交改动，**这些改动不是本轮 ERP 工作产生**，是此前对官网做的入口拆分与性能整理：

| 文件 | 相对提交的改动 | 说明 |
| --- | --- | --- |
| `src/main.tsx` | 改为按路径分流，动态加载 `app-entry` 或 `public-entry` | 官网与工作区入口分离 |
| `src/OfficialHome.tsx` | 61 行改动 | 官网首页相关 |
| `src/ProductionWebsite.tsx` | 221 行改动 | 官网整页相关 |

处理原则：以**当前工作区状态**作为"官网零改动"的基准（见第三节指纹），不回退这些改动。建议用户在方便时先确认并提交这部分官网改动，使基线与版本库一致。

## 二、构建与测试基线

| 检查项 | 结果 |
| --- | --- |
| 前端 `npm run build`（类型检查 + 构建 + 服务端渲染包 + 预渲染） | 通过，预渲染 42 页，另有 `app.html`、`404.html` |
| 前端 `npm test` | 通过，2 个测试文件、6 个用例 |
| `apps/api` 类型检查 | 通过 |
| `apps/worker` 类型检查 | 通过 |
| 前端主要产物 | `app-entry` 171.77 kB（gzip 50.32 kB）、`ProductionWebsite` 388.36 kB（gzip 132.94 kB）、`barGrid` 158.90 kB |

现有前端测试只有 `data.test.ts`（针对演示数据）与 `public-site.test.ts`，后端与工作进程目前没有自动化测试。该缺口由阶段 1 起各工作包补齐。

## 三、官网指纹基线

指纹工具：`scripts/website-fingerprint.mjs`（`--write` 生成、`--check` 核对）。
基线文件：`docs/erp-plan/freeze/fingerprints.json`。

| 指标 | 数量 |
| --- | --- |
| 预渲染 HTML 页面（含 `app.html`、`404.html`） | 44 |
| 官网源码文件（不含 ERP 专属文件） | 52 |
| 官网与 ERP 共用源码 | 2（`ui/chart.tsx`、`ui/motion.tsx`） |

规则：
- 页面指纹为"去除 `<script>` 与样式/预加载 `<link>` 后的内容哈希"，因此构建产物文件名变化不会误报；
- 共用源码一旦变化，必须连同官网页面指纹一起核对；
- 每个涉及前端构建的工作包，完成时执行 `node scripts/website-fingerprint.mjs --check` 并附结果。

ERP 专属（不计入官网源码指纹）：`src/erp/*`、`App.tsx`、`FbaOperationsPage.tsx`、`ProductionAdminPage.tsx`、`app-entry.tsx`、`fba-operations.css`、`data.ts`、`data.test.ts`、`api.ts`、`styles.css`。

## 四、现有后端接口清单（59 个）

共 59 个路由，其中 13 个无需登录。

### 无需登录（13）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `health` | 健康检查 |
| GET | `commerce/plans` | 公开套餐 |
| GET | `commerce/payment-configuration` | 支付配置 |
| POST | `commerce/orders` | 创建订单 |
| GET | `commerce/orders/:orderNo` | 订单查询（令牌） |
| POST | `commerce/orders/:orderNo/pay` | 发起支付 |
| POST | `commerce/orders/:orderNo/refunds` | 申请退款 |
| POST | `payments/alipay/notify` | 支付宝回调 |
| POST | `auth/login` | 登录 |
| POST | `auth/refresh` | 刷新 |
| GET | `sp-api/oauth/callback` | 卖家授权回调 |
| GET | `ads/oauth/callback` | 广告授权回调 |
| POST | `contact-requests` | 官网联系表单 |

### 需登录（46）

| 域 | 路径 |
| --- | --- |
| 认证与组织 | `auth/me`、`entities`（GET/POST）、`members`、`audit` |
| 订单与库存 | `orders`、`orders/:id/items`、`inventory`、`inventory/movements`、`warehouses` |
| 亚马逊物流 | `fba/summary`、`fba/products`、`fba/inventory`、`fba/inbound-plans`（GET/POST）、`fba/fees`、`fba/settlements`、`fba/returns`、`fba/sync/jobs` |
| 分析 | `analytics/profit`、`analytics/ad-terms` |
| 报告 | `reports/jobs`（GET/POST） |
| 采购 | `procurement/suppliers`、`procurement/purchase-orders`（GET/POST） |
| 连接与同步 | `connections`、`sync/jobs`（GET/POST）、`sync/jobs/:id/retry`、`sp-api/oauth/start` |
| 广告 | `ads/profiles`、`ads/campaigns`、`ads/reports`（GET/POST）、`ads/metrics`、`ads/oauth/start`、`ads/sync` |
| 官网线索与商业 | `contact-requests`（GET/PATCH）、`commerce/admin/plans`（GET/PATCH）、`commerce/admin/orders`、`commerce/admin/orders/:id/activate`、`commerce/admin/refunds`（GET/PATCH） |

已知问题（均已在 14 章对应工作包中安排修正）：
- 全部列表接口为偏移分页或整表读取，无游标；
- 写接口无幂等键、无写入开关、无预览；
- 利润与词级下钻在内存汇总，数据多时会被截断；
- `auth/refresh` 的刷新令牌 30 天不轮换，也无重用检测；
- 无平台运营后台接口、无邀请开通、无租户生命周期接口。

## 五、现有数据表（41 个模型，11 个迁移）

| 域 | 模型 |
| --- | --- |
| 租户与权限 | `User`、`Tenant`、`Role`、`Membership`、`Session` |
| 主体与连接 | `LegalEntity`、`SellerAccount`、`PlatformConnection`、`OAuthState`、`ConnectionHealth` |
| 订单与库存 | `Order`、`OrderItem`、`InventorySnapshot`、`Warehouse`、`InventoryMovement` |
| 同步与审计 | `SyncJob`、`AuditEvent`、`ContactRequest` |
| 商业与支付 | `CommercialPlan`、`CommerceOrder`、`PaymentRecord`、`PaymentEvent`、`RefundRequest`、`InvoiceRequest`、`Subscription`、`CommerceAuditLog` |
| 亚马逊物流 | `FbaProduct`、`FbaInventoryRecord`、`FbaInboundPlan`、`FbaInboundShipment`、`FbaFeeEvent`、`FbaReturnCase`、`FbaReportJob`、`FbaSettlement`、`FbaFinancialTransaction` |
| 广告 | `AdsProfile`、`AdsCampaign`、`AdsReportJob`、`AdsMetric`、`AdsTermMetric` |
| 采购 | `Supplier`、`PurchaseOrder`、`PurchaseOrderLine` |

迁移序列（共 11 个，最后一个为广告词级指标）：
`20261017120000_init` → `20261017140000_contact_requests` → `20261019100000_fba_operating_model` → `20261019113000_fba_report_jobs` → `20261019114000_oauth_token_vault` → `20261019150000_public_ads_connections` → `20261019170000_operational_completeness` → `20261019180000_production_sync_fixes` → `20261019190000_session_idle` → `20261020103000_commerce_checkout` → `20261021020000_ads_term_metrics`。

新增迁移序号应晚于 `20261021020000`。

## 六、现有工作进程与共享包

| 项 | 现状 |
| --- | --- |
| 队列 | 仅一个名为 `sync` 的队列，并发 4 |
| 报告类型 | 目录（`GET_MERCHANT_LISTINGS_ALL_DATA`）、仓储费（`GET_FBA_STORAGE_FEE_CHARGES_DATA`）、不合规（`GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA`）、广告报告（含搜索词与关键词分流） |
| 权限点 | 16 个模块级：`entity.read/write`、`seller.read/write`、`connection.manage`、`orders.read`、`refunds.read`、`finance.read`、`ads.read`、`ads.report`、`sync.manage`、`export.create`、`member.read/invite`、`role.manage`、`audit.read` |
| 共享包 | `api-contracts`（校验契约）、`authz`（权限判断）、`metrics`（仅 86 字节，基本为空） |
| 工作进程文件 | `main.ts` 约 57.8 KB 单文件，`amazon-sp-api.ts`、`amazon-ads-api.ts`、`fee-lines.ts`、`pii-vault.ts` |
| 后端服务 | `api.service.ts` 约 52 KB 单文件承载全部业务域 |

## 七、现有前端已知偏离（均已有对应工作包）

| 偏离 | 位置 | 处理阶段 |
| --- | --- | --- |
| 单文件 180 KB、54 个函数，依赖演示数据 | `src/App.tsx`、`src/data.ts` | 阶段 1 起拆分 |
| 一个页面承载 12 个业务域 | `src/FbaOperationsPage.tsx` | 各板块阶段拆分 |
| 演示驾驶舱 | `src/erp/Dashboard.tsx` | 阶段 1 改为真实"企业初始化与数据源健康" |
| 占位页 | `src/erp/Placeholder.tsx` | 阶段 1 起逐步被真实页面替换 |
| 演示主体与非美国站点 | `src/erp/scope.tsx` | 阶段 1 |
| 令牌存在浏览器本地存储 | `src/api.ts` | 阶段 1 改为内存令牌 + 安全 Cookie |
| 利润与词级下钻内存汇总 | `api.service.ts` | P2b-10 / P3-10 改库内汇总 |
| 代理信任缺失、内容安全策略关闭 | `apps/api/src/main.ts` | 阶段 1 |
| Redis 无密码、单实例 | 编排与配置 | 阶段 1 |
| 租户默认上海时区与人民币 | 租户创建逻辑 | 阶段 1 |

## 八、核对清单（后续阶段复用）

每个工作包完成后至少执行：

```
npm run build
npm test
node scripts/website-fingerprint.mjs --check
```

后端改动另需在 `apps/api`、`apps/worker` 下运行类型检查。
