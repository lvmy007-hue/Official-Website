# P1-30 阶段 1 收口核对记录

> 依据：`14-execution-plan.md` 14.6 阶段 1 验收清单（13 项）与 14.11 过渡期处理表。
> 核对日期：2026-10-22。核对方式：逐项对应到可重复运行的测试或命令，**不凭印象勾选**；做不到真实环境验证的，如实写在“未能验证的部分”。
> 全量命令：`TEST_REDIS_URL=redis://127.0.0.1:26379 node scripts/ci.mjs`。结果：前端、接口、后台任务、共享包共 **165 个测试文件、1498 条用例全部通过**（含真实数据库与真实 Redis）；lint 警告 35（上限 35）；格式化、类型检查、官网指纹、依赖漏洞扫描（高危 0，中危 4）均通过。

## 一、14.6 阶段 1 的 13 项

| # | 验收项 | 结论 | 证据（文件，均可重复运行） | 未能验证的部分 |
|---|---|---|---|---|
| 1 | 越权：无权限店铺参数不返回该店铺数据；跨租户访问每类对象返回“不存在” | 通过 | `apps/api/src/access-control.test.ts`（逐条已注册接口：无凭证 401、无权限 403，新增接口不登记过不了）；`apps/api/src/modules/auth/scope.db.test.ts`（店铺范围收窄，真实库）；`apps/api/src/testing/cross-tenant.db.test.ts`（跨租户逐类攻击：读 404、写 404 或参数错误，对方数据不变，对照组证明拒绝来自“不属于你”）；`rls.db.test.ts`（数据库行级隔离） | — |
| 2 | 前端代码与页面检索不到“规划中”“演示”“示例”，无非美国站点 | 通过 | `src/erp/hygiene.test.ts`（扫描 `src/erp` 与过渡期旧页面：演示数据字样、规划中占位、非美国站点域名与站点编号、随机业务数据、提示型假动作、写死的上下文条）；本次新增的 `OverviewPage` 在扫描范围内 | 官网源码按规则不在扫描范围（零改动） |
| 3 | 浏览器本地存储没有令牌；刷新令牌被重用时整个会话被吊销 | 通过 | `src/api.test.ts`（启动时清除旧版本地令牌，令牌只在内存）；`apps/api/src/modules/auth/auth.db.test.ts` 的“重用检测：宽限期外重用旧凭据则吊销整条会话链、写审计、清除 Cookie”，以及“刷新凭据只放在 HttpOnly Cookie，响应体不含” | — |
| 4 | 限流按真实地址生效；内容安全策略已开启 | 通过（接口层与配置层） | `auth.db.test.ts`“未信任代理时伪造的 X-Forwarded-For 被忽略”“TRUST_PROXY=1 时按真实地址”；`src/workspace-headers.test.ts`（三个工作台位置的内容安全策略一致、禁止嵌入、官网位置块不受影响）；`apps/api/src/platform/security/trust-proxy.ts` | 生产环境前置网关（阿里云）后“真实地址”的取值需在部署专项里用真实网关复验（部署专项暂缓） |
| 5 | 写入开关页面可切换，前置检查生效，切换写审计；一键只读与紧急强制关闭有效 | 通过 | `apps/api/src/modules/integrations/integrations.http.test.ts`（前置检查、写变更记录与审计、一键只读、紧急强制关闭）；`src/erp/pages/settings/settings-pages.test.tsx`（开启需原因、勾选确认、再次验证密码；强制关闭显示横幅且不能开启；读取失败如实显示） | — |
| 6 | 汇率每天自动入库，缺失时回退并标记 | 通过（替身来源） | `apps/worker/src/platform/fx-fetch.test.ts`（主源成功、主备回退、沿用并标注牌价日期、两源都失败不写数据、来源地址校验、关账日期跳过、连续失败通知、逐企业隔离）；`apps/api/src/modules/fx/fx.http.test.ts` | 汇率来源真实连通性需要出网环境，当前用替身验证（已在 CR-022 披露） |
| 7 | 1GB 样例报告压测，常驻内存不随文件增大 | 通过 | `apps/worker/src/streaming/stress.test.ts`。**本次实测** `STRESS_STREAM_MB=1024`：1024MB（压缩后 212MB、13,008,332 行）基线 18MB → 峰值 23MB（增长 5MB），进程常驻内存峰值 200MB，用时 19.6 秒；对照 16MB 增长 6MB、96MB 增长 4MB、128MB 增长 2MB，与文件大小无关 | — |
| 8 | 故障注入：重试、死信、断点续传、崩溃恢复，不重复创建亚马逊对象 | 通过 | `packages/workflow/src/workflow.test.ts`（“故障注入：重试与断点续传”“故障注入：不会重复创建亚马逊对象”）；`apps/api/src/testing/workflow.db.test.ts`（崩溃恢复，真实库）；`apps/worker/src/runtime/redis.integration.test.ts`（真实 Redis：重试退避、不可重试进死信、重试用尽、进程猝死后接管、租户并发延后）；`job-runner.test.ts`；`dead-letter.db.test.ts` | — |
| 9 | 订单与财务接口新旧并行核对的差异全部分类 | 通过 | `apps/worker/src/parity/parity.test.ts`（每条差异落在时间口径、归因口径、范围、未解释四类之内且带中文原因；连续 7 次无未解释才关闭旧通道）；`apps/api/src/modules/sync/parity.http.test.ts`；`apps/api/src/testing/orders-finance-v2.db.test.ts` | 真实授权店铺的新旧样本对照需第一个真实店铺同步后由核对报告兜底（CR-021 已披露） |
| 10 | 租户全流程：开通、邀请、激活、向导、首次同步、注销 | 通过 | `apps/api/src/testing/tenant-lifecycle.db.test.ts`（真实库：开通→邀请→接受→向导→首次同步分段→配额→暂停→支持访问→停用→注销六步与删除证明，其他企业不受影响） | 首次同步到真实亚马逊需真实授权店铺；当前验证到“按分段生成任务” |
| 11 | 首屏体积预算达标 | 通过 | `pnpm build` 内置 `scripts/bundle-budget.mjs`：**298.4 KB / 300.0 KB**（余量 1.6KB）；`src/erp/quality/bundle-budget.test.ts`。新增的 `OverviewPage` 为按需加载块，不计入首屏 | **余量只剩 1.6KB**，后续工作包必须继续按需加载，不放宽预算 |
| 12 | 过渡期页面满足 14.11 | 通过（见第二节） | 见第二节 | — |
| 13 | 持续集成全部通过，官网预渲染与基线一致 | 通过 | `node scripts/ci.mjs` 全步骤通过；`node scripts/website-fingerprint.mjs --check`：页面 44 个、官网源码 52 个、共用源码 2 个，指纹一致；预渲染 42 个页面加 app.html、404.html | — |

## 二、14.11 过渡期处理表

| 现有页面或代码 | 处理要求 | 现状 | 证据 |
|---|---|---|---|
| `/app/overview` 演示驾驶舱 | 删除演示内容，改为真实数据的“企业初始化与数据源健康”页 | **本次补齐**（此前路由已注册但没有页面，访问会落到“页面不存在”）。初始化进度读 `/onboarding`（仅有设置写入权限的成员读取，其他成员只看到说明）；数据源健康读新增的 `GET /overview/source-health`（`overview.read`，范围按本人授权收窄）：订单、库存、入仓计划、财务交易为真实新鲜度，报告、数据中心、广告、品牌分析写“尚未接入”，营销数据流、消息推送写“未接入”（14.10），没有同步记录显示“尚无记录”，不出现任何示例时间或数字 | `src/erp/pages/overview/overview-page.test.tsx`；`apps/api/src/modules/overview/overview.http.test.ts`；`packages/api-contracts/src/overview.test.ts` |
| “规划中”占位页（刊登表现、补货、自定义报表、预警） | 删除路由与导航；自定义报表永久移除 | 已完成：未登记的路由显示正式的“页面不存在”，不进导航 | `routes/router.test.tsx`、`routes/manifest.test.ts`、`hygiene.test.ts` |
| 旧利润页 | 下线 | 页面代码已删除（`ProfitPage.tsx` 不存在由测试保证）。**后端旧接口 `/analytics/profit` 仍保留**，作为接口兼容基线，随 P2b-10 一并替换（**已于 P2b-10 下线并由 `/profit/*` 替代，见 CR-048**） | `hygiene.test.ts`、`apps/api/src/routes.test.ts` |
| 旧词级下钻页 | 下线 | 页面代码已删除（`AdTermsPage.tsx`）。**后端旧接口 `/analytics/ad-terms` 仍保留**，随 P3-10 替换 | 同上 |
| `FbaOperationsPage` 承载的业务页 | 保留真实数据；删除写死文案；接入范围与新鲜度条 | 已完成：请求带全局范围参数，显示新鲜度条，没有数据只显示空状态，站点只有美国站 | `src/erp/pages/transitional.test.tsx` |
| `ProductionAdminPage` 承载的页面 | 同上 | 已完成（同上） | 同上 |
| Arco 组件 | 仅过渡期旧页面使用，新页面一律 Ant Design | 新页面（含本次 `OverviewPage`）全部使用 Ant Design；Arco 仅在旧过渡页，P5-12 删除 | 依赖清单；`P5-12` |
| 导航 | 只显示已交付或过渡保留的页面 | 已完成：只有登记在 `LIVE_PAGES` 的页面进导航 | `routes/manifest.test.ts`（导航生成）、`routes/router.test.tsx`（导航只显示有权限的已上线页面） |

## 三、结论与遗留

- 阶段 1 的 13 项全部有可重复的证据，**可收口**；其中 4、6、9、10 的“真实环境部分”依赖部署专项或真实授权店铺，已逐项写明，不算作已验证。
- 首屏体积余量 1.6KB，是后续阶段最紧的约束。
- 旧接口 `/analytics/ad-terms` 仍在，在 P3-10 替换；`/analytics/profit` 已在 P2b-10 下线（CR-048）。
