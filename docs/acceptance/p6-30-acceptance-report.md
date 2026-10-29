# P6-30 阶段 6 全站验收报告（R6-30 重做）

验收日期：2026 年 10 月 29 日。依据：14 章 14.6 阶段 6 验收清单、15 章、16 章。本报告取代 CR-158 的版本，原结论不当事先正确，逐条重新核查。

截图与真实浏览器走查：**未走查**。本环境没有带数据的浏览器验收环境，也没有真实店铺。全量持续集成由外层核验，本包没有跑，不能写成全绿。

## 结论

12 条里：**第 1、2、3、4、5、6、7、8、9、11 条按代码与测试通过**（第 8 条以 P5-12A 同步数据为前提，第 4 条未用真实装箱单走查）；**第 10 条（性能）部分通过**：首屏体积实测达标，但第 95 百分位响应预算没有压测，缺的是带数据量的环境，不是代码；**第 12 条**除全量 CI 外各项本包已核。

上一版验收留下的三个"遗留"本包都做掉了，不再用"不阻塞"带过：

1. 详情页签、抽屉、对比卡里的 antd `Table`（原 43 个文件、约 80 处）：**全部换成 `SimpleGrid`**；带行内展开的改为点行开右侧抽屉（`RowDetailDrawer`），采购单收货的商品明细改成列。`SimpleTable` 组件已删除。`src/erp` 下 `<Table` 为零，由 `p630-acceptance.test.ts` 锁死。
2. 库存台账与移除订单的页内搜索：改成地址栏 `FilterBar`（`useUrlFilters`），筛选可分享、刷新保留。
3. 导出文件没有口径版本：补上（见第 3 条）。

订单列表净收益已改为异步列（`POST /orders/net-income`），见遗留项 2。

## 阶段 6 验收清单

| 条 | 结论 | 证据与缺口 |
|---|---|---|
| 1 设计一致性 | 通过 | `acceptance.test.ts`：导航阶段 6 的 24 个路由都挂了页面，且没有 `Table`；`p630-acceptance.test.ts`：`src/erp` 不含 `<Table`、`pages` 不引用 `SimpleTable`、广告五个层级页面都用 `AdsLevelGrid`。库存台账（`InventoryLedgerPage.tsx`）与移除订单（`RemovalsPage.tsx`）筛选用 `FilterBar`，测试走地址栏参数（`inventory-ledger.test.tsx`、`inventory-removals.test.tsx`）。本包新增 `SimpleGrid` 的明细表约 80 处，每处有 `gridId`、空态说明。无浏览器走查：骨架、列宽与抽屉观感未看。 |
| 2 口径 | 通过 | `metric-keys.test.ts`：页面不自写列头说明，`metric` 键都在字典里。`p630-acceptance.test.ts`：`metrics.md` 10.7 的 50 个核心指标，`reconcileWith` 与 `mismatchReasons` 都非空。 |
| 3 口径版本 | 通过 | 修改走 `MetricVersion`，审批后生效；`metric-versions.db.test.ts`：版本、差异报告只读（区间过长 422）、利润总览带 `metricVersions`、跨企业隔离。关账快照带版本：`periods-close.service.ts`、`periods-close.http.test.ts`。**导出：本包补上**——经营报告、商品、自定义报表三类导出最后一列"口径版本"，每行写生成时生效的利润公式与业务口径版本（没有生效版本写"默认"），表头仍在第一行：`apps/worker/src/exports/metric-version.ts`、`run-export.ts`；`run-export.test.ts` 新增用例覆盖有版本、无版本、其他类型不加。订单、费用、审计等导出不含受口径影响的数字，不加。 |
| 4 发货链路 | 通过（未用真实装箱单走查） | 补货转入仓草稿：`batch-inbound.db.test.ts`、`POST /replenishment/batches/:id/to-inbound-drafts`。装箱单写入：`packing-list.db.test.ts`、`POST /inbound/plans/:id/packing-list/apply`。箱标签与商品标签：`label-template.db.test.ts`、`label-export.test.ts`。 |
| 5 售后 | 通过 | `returns-analysis.db.test.ts`：概览、退货周期、跨月退货（M-702）、队列退货率（M-703）；口径在字典主表，对账字段见 `metrics.md` 10.4。 |
| 6 隐私 | 通过 | `pii-guard.test.ts`：除 `POST /pii/reveal` 外响应、导出模板、日志不得出现个人信息字段名。`pii.db.test.ts`：明文只从统一出口返回并写审计。 |
| 7 预警 | 通过 | 条件构造器、三种频率、静默汇总、升级链：`alert-rule-notify.db.test.ts`。个人免打扰：`personal-account.db.test.ts`。已读与处理两套状态互不影响：`alerts-read.db.test.ts`。 |
| 8 广告 | 通过（以 P5-12A 同步数据为前提） | 五层级共用 `AdsLevelGrid`（`p630-acceptance.test.ts`）。超预算时间条 `GET /ads/campaigns/:id/budget-timeline`；冲突检查 `ads-tools.test.ts`、`GET /ads/conflicts`；词研究加词 `POST /ads/keywords/bulk-add`。无真实店铺数据，页面显示尚无记录；未走查。 |
| 9 自定义报表与仪表盘 | 通过 | `custom-reports.db.test.ts`：先 `reports.read`，再数据源与字段权限，然后才校参数；行数上限、超时、日期最长 366 天；嵌套自定义指标不能绕过字段门；数据范围只含一个店铺时只见该店铺。`dashboards.db.test.ts`：共享仪表盘缺权限时 `RESTRICTED`「无权查看」，看不到的组件不暴露配置。 |
| 10 性能 | **部分通过** | 首屏实测：本包 `pnpm build` 后 `bundle-budget.mjs` **296.2 KB（预算 350 KB）**，通过。**缺口：没有按 12 章 12.4 做第 95 百分位压测**（汇总 300 毫秒、列表与详情 500 毫秒）。这需要带数据量的数据库与服务环境，本环境没有，**不是代码缺陷，但这是冻结的验收项，上线前必须在预发环境补测**，不能当成已通过。宽表用游标或页码，自定义报表有页大小与 8 秒超时。 |
| 11 安全与隔离 | 通过 | 越权：`access-control.test.ts` 对已注册接口检查未登录 401、无权限 403、权限先于参数校验。跨企业：`cross-tenant.db.test.ts` 对全部租户表做攻击前后摘要。**本包补上此前缺跨企业用例的两个新模块**：`custom-reports.db.test.ts`（别的企业运行、改、删本企业报表与自定义指标均 404，列表与查询不泄漏，查询只返回自己企业的行）、`dashboards.db.test.ts`（别的企业读、改、删仪表盘与组件，往里加组件均 404，列表与目录不泄漏）。其余阶段 6 模块各自的真实库测试已含跨企业用例（口径版本、退货分析、批量入仓、标签、装箱单等）。 |
| 12 硬规则 | 本包范围内通过；全量 CI 未跑 | 官网指纹 `node scripts/website-fingerprint.mjs --check` 通过（44 页）；单文件 400 行、单行 240 字符 `node scripts/check-code-quality.mjs` 通过（`po-tabs.tsx` 因此拆出 `po-tabs-receiving.tsx`）；`pnpm lint` 警告 **35**，刚好在上限 35 上，**零余量**，新增警告就会失败；`format:check` 本包改动文件通过；`pnpm build`（含 `src/erp` 零警告 eslint、类型检查、预渲染）通过。**全量 CI 由外层核验，不能写成全绿。** |

## 对遗留项的重新判定

1. **详情 antd `Table`**：做了，见上。行内展开改抽屉是对 P6-28 已定做法（`RowDetailDrawer`）的延续，不改变数据与接口。
2. **订单列表净收益异步列**：已做（冻结 14 章 P6-28“订单列表（毛利改为异步列）”、16 章 251 行）。新增只读批量接口 `POST /orders/net-income`（`orders.read` + `field.profit`，一次最多 100 个订单，企业与店铺范围与列表一致，范围外订单不出现；口径与订单详情相同，来自财务交易合计）；`GET /orders` 响应不再带 `netIncome`。前端 `orders-columns.tsx` 用 `async: { key: 'net' }`，没有 `field.profit` 时整列不出现。证据：`orders.http.test.ts`（权限、企业条件、去重、101 个 422、列表不含净收益）、`orders-pages.test.tsx`（先出列表、再按屏幕行批量取、无权限不请求）、`routes.test.ts`。该列不可排序，与异步列规则一致。
3. **库存台账与移除页筛选**：做了，改地址栏 `FilterBar`。
4. **导出口径版本**：做了。

## 仍未做、必须披露

- 没有真实浏览器走查，也没有真实店铺核对。
- 第 95 百分位压测没做（第 10 条）。
- 行内展开改抽屉后，页面观感（抽屉宽度、嵌套抽屉层级）没有在浏览器里看过。
- `pnpm lint` 警告正好 35。
- 两个耗时较长的前端用例（`aplus-detail-write` 轮询、`inventory-removals` 登记收货）在整库并发跑时偶发 15 秒超时，单独跑都通过；非本包引入。

## 人工走查清单（部署后补）

1. 每个一级导航分组打开一个列表页和一个详情页，看骨架、空态和列头问号；详情页里点行打开的抽屉（AWD 货件、供应商报价、补货策略历史、刊登操作记录）。
2. 补货批次转入仓草稿，装箱单匹配后写入，再生成箱标签与商品标签。
3. 退货分析的周期、跨月、队列退货率在有数据时对一下字典口径。
4. 用无利润字段权限的账号打开共享仪表盘，确认组件显示「无权查看」而不是整页失败。
5. 导出经营报告、商品、我的报表，确认最后一列"口径版本"。
6. 广告活动详情展开超预算时间条；词研究批量加词走到预览而不是直接成功。
7. 1440 宽度下抽查商品表现宽表和 ASIN 360 锚点页。
8. 预发环境按 12 章 12.4 压测第 95 百分位。
