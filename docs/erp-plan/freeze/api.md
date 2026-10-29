# P0-03 后端接口清单

> 依据：10 章 10.4；03 章 3.2 动作守卫；执行计划 P0-03。
> 覆盖 10.4 全部接口，并补充页面实际需要但 10.4 未逐条列出的接口（标"补"）。

## 一、通用约定

### 1.1 路径与版本
所有路径前缀 `/api/v1`。下表路径省略前缀。路由顺序：静态路径优先于参数路径（如 `/inventory/ledger` 先于 `/inventory/:id`）。

### 1.2 请求契约（均定义在 `packages/api-contracts`，前后端共用）

| 契约 | 内容 |
| --- | --- |
| `ScopeQuery` | `entityIds[]`（法律主体）、`storeIds[]`（店铺）、`marketplaceId`（固定美国站 `ATVPDKIKX0DER`，可省略；传其他值一律 400）、`from`、`to`、`compareTo`（上一期、去年同期、自定义区间）、`currency`（显示币种，默认美元） |
| `CursorQuery` | `cursor`（签名游标，绑定查询条件，条件变化即失效）、`limit`（默认 50，上限 200）、`sort`（只允许白名单字段）、`order`、`filters`（白名单字段） |
| `PageQuery` | `page`、`pageSize`（默认 50，上限 200）；仅用于小而有界的列表（成员、角色、规则等） |
| `IdempotencyKey` | 请求头 `Idempotency-Key`，所有写接口必填，24 小时内去重，重复提交返回首次结果 |
| `VersionBody` | 被多人编辑的对象，请求体带 `version`；冲突返回 `409 CONFLICT`，前端提示合并或刷新 |
| `ReasonBody` | 需要填写原因的动作带 `reason`（忽略预警、重新开账、查看买家信息、开启开关等） |

### 1.3 响应封装
`{ data, meta }`。`meta` 包含 `requestId`、`freshness`（数据新鲜度：最近成功时间、延迟）、`nextCursor`（游标分页时）、`warnings`（局部失败、部分可用的说明）。错误统一为 `{ error: { code, message, requestId } }`，不暴露内部细节。

### 1.4 列说明

| 列 | 取值 |
| --- | --- |
| 权限 | 引用 `permissions.md`；"基础"表示所有登录成员；"公开"表示无需登录（按令牌或来源校验） |
| 开关 | 写入开关键（`permissions.md` 第六节）；"—"表示不涉及亚马逊写入 |
| 预览 | `校验`：亚马逊刊登接口校验预览模式；`影响`：广告活动预测或影响预览（`POST /ads/preview`）；`—`：无 |
| 审计 | 是：写审计（修改前后差异、请求编号、来源地址、访问模式）；—：只读，不写业务审计（敏感读取除外，已标"是"） |
| 验证 | 是：需再次验证身份（`permissions.md` 第七节） |
| 分页 | 游标 / 页码 / —（单对象或有界聚合，不分页） |

### 1.5 横向规则（所有接口）
1. 范围参数与成员授权范围取交集，交集为空返回 403；
2. 按编号访问对象时校验租户归属，不属于当前租户返回 404；
3. 响应序列化按字段权限过滤，没有权限的字段不返回键；
4. 亚马逊写接口依次经过：权限 → 连接健康 → 写入开关 → 数据条件 → 预览 → 幂等去重 → 记录意图 → 调用 → 记录结果 → 审计；
5. 所有查询有边界：无游标则必须有时间范围与上限，超限返回 400；
6. 列表接口返回行数不超过 `limit`；聚合接口返回行数有固定上限并在契约中声明；
7. 查询参数只接受“每个键一个字符串”（P5-13，CR-105）：数组写法（`?a[]=1`）、嵌套写法（`?a[b]=1`、`?a[$ne]=1`）与重复的键，在入口统一返回 400 `BAD_REQUEST`，不进入业务代码。多选值用逗号连接成一个字符串（前端 `api-query.ts` 已是这样做的）。

---

## 二、平台运营后台（独立鉴权，`/platform` 前缀，与租户接口分离）

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/platform/auth/login` | 公开 | `PlatformLoginBody` | 会话与多因素挑战 | — | — | 是 | — | — |
| GET | `/platform/tenants` | `platform.tenant.read` | `PlatformTenantListQuery` | 租户名、状态、开通时间、店铺数、成员数、最近活跃 | — | — | — | — | 游标 |
| POST | `/platform/tenants` | `platform.tenant.manage` | `PlatformTenantCreateBody` | 新租户编号与状态 | — | — | 是 | — | — |
| GET | `/platform/tenants/:id` | `platform.tenant.read` | — | 租户详情、生命周期事件、配额（补） | — | — | — | — | — |
| POST | `/platform/tenants/:id/invite` | `platform.tenant.manage` | `TenantInviteBody` | 一次性邀请链接（72 小时，只返回一次，库内只存哈希） | — | — | 是 | — | — |
| POST | `/platform/tenants/:id/suspend` | `platform.tenant.manage` | `ReasonBody` | 状态变更；停同步，只读 | — | — | 是 | — | — |
| POST | `/platform/tenants/:id/resume` | `platform.tenant.manage` | `ReasonBody` | 状态变更 | — | — | 是 | — | — |
| POST | `/platform/tenants/:id/deactivate` | `platform.tenant.manage` | `ReasonBody` | 停用，保留数据 | — | — | 是 | 是 | — |
| POST | `/platform/tenants/:id/close` | `platform.tenant.manage` | `TenantCloseBody` | 注销流程任务：导出、撤销亚马逊授权、删除令牌、删除买家信息、按保留策略删除、生成删除证明 | — | — | 是 | 是 | — |
| GET | `/platform/tenants/:id/usage` | `platform.tenant.read` | — | 用量与配额占用 | — | — | — | — | — |
| PUT | `/platform/tenants/:id/quota` | `platform.quota.manage` | `TenantQuotaBody` | 配额（补） | — | — | 是 | — | — |
| POST | `/platform/support-access` | `platform.support.access` | `SupportAccessRequestBody` | 申请限时支持访问；须租户所有者先授权，到期自动失效 | — | — | 是 | 是 | — |
| POST | `/platform/auth/mfa/verify` | 公开（登录挑战） | `PlatformMfaBody` | 动态验证码通过后签发平台令牌（补，CR-020） | — | — | 是 | — | — |
| GET | `/platform/auth/me` | 平台登录 | — | 当前平台账号与权限点（补，CR-020） | — | — | — | — | — |
| POST | `/platform/auth/logout` | 平台登录 | — | 注销，已签发的令牌立即失效（补，CR-020） | — | — | 是 | — | — |
| GET | `/platform/tenants/:id/close-export` | `platform.tenant.manage` | — | 注销导出包的短时下载链接（补，CR-020） | — | — | 是 | — | — |
| GET | `/platform/support-access` | `platform.support.access` | — | 可领取或已领取的授权列表（补，CR-020） | — | — | — | — | — |

租户侧授权与配额（补）：

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/settings/quotas` | `settings.read` | — | 配额与占用（补，CR-020） | — | — | — | — | — |
| GET | `/settings/support-access` | `settings.read` | — | 授权记录与状态（补，CR-020） | — | — | — | — | — |
| POST | `/settings/support-access` | `settings.write`（仅所有者） | `SupportAccessGrantBody` | 授权时长与范围 | — | — | 是 | 是 | — |
| DELETE | `/settings/support-access/:id` | `settings.write` | — | 提前撤销授权 | — | — | 是 | — | — |

## 三、租户开通与认证

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST | `/auth/login` | 公开 | `LoginInputSchema`（现有） | 访问令牌（内存使用）；刷新凭据通过仅服务端可读的 Cookie 下发 | — | — | 是 | — | — |
| POST | `/auth/refresh` | 公开（刷新凭据） | — | 新访问令牌；刷新凭据每次轮换，旧凭据重用则吊销整个会话；校验请求来源 | — | — | 是 | — | — |
| POST | `/auth/logout` | 基础 | — | 注销当前会话（补） | — | — | 是 | — | — |
| GET | `/auth/me` | 基础 | — | 用户、租户、角色、权限点、字段权限、数据范围、写入状态 | — | — | — | — | — |
| PATCH | `/auth/me` | `profile.manage` | `ProfileUpdateBody` | 个人资料（补）。**P5-11（CR-102）：只改显示名**，请求体 `{ displayName }`（去首尾空白，1 至 60 字，不含控制字符），响应 `{ displayName, changed }`；与现值相同时 `changed: false` 且不写审计；只改登录者本人，内部访问与平台支持访问模式拒绝。通知偏好改走 `PUT /me/preferences` | — | — | 是 | — | — |
| GET | `/me/preferences` | `profile.manage`（基础） | — | **P5-11（CR-102）**：本人在当前企业的通知偏好与个人免打扰。响应 `PreferencesResponse`：`notify`（`domains`：七个业务域 × 三个严重级别的接收开关；`dnd`：`enabled`、`start`、`end`，企业本地时区的 `HH:MM`，开始晚于结束表示跨午夜）、`version`（没保存过为 0）、`updatedAt`（没保存过为空）、`zone`（企业本地时区）。没保存过按默认返回：全部接收、免打扰关闭。**P6-01（CR-108）补**：`favorites`（收藏的路由模板数组，默认空）与 `density`（`COMPACT`/`STANDARD`，默认 `STANDARD`） | — | — | — | — | — |
| PUT | `/me/preferences` | `profile.manage`（基础） | `PreferencesUpdateBody` | **P5-11（CR-102）**：保存通知偏好与免打扰，请求体 `{ notify, version }`（整份覆盖）。`version` 为读取时的版本号（没保存过传 0）：不一致 409；与当前完全相同 422；内部访问与平台支持访问模式拒绝。写审计 `USER_PREFERENCES_UPDATED`（前后整份偏好）。成功响应与 `GET` 同形（`PreferencesResponse`，版本号加一）。**P6-01（CR-108）改**：请求体为 `{ notify?, favorites?, density?, version }`，三项各自可省略、省略的项保持不变，至少带一项；“与当前完全相同”按出现的项比较；审计只记出现的项的前后值 | — | — | 是 | — | — |
| GET | `/auth/invitations/:token` | 公开（一次性令牌） | — | 邀请预览：企业名、受邀邮箱、是否首个管理员（补，CR-020） | — | — | — | — | — |
| POST | `/auth/invitations/:token/accept` | 公开（一次性令牌） | `InviteAcceptBody` | 设置密码；首个管理员强制进入多因素绑定 | — | — | 是 | — | — |
| GET | `/onboarding` | `settings.write` | — | 8 步初始化向导进度 | — | — | — | — | — |
| PATCH | `/onboarding` | `settings.write` | `OnboardingStepBody` | 保存某一步，进度可恢复 | — | — | 是 | — | — |
| POST | `/auth/mfa/enroll` | 基础 | — | 多因素绑定所需信息 | — | — | 是 | — | — |
| POST | `/auth/mfa/verify` | 基础 | `MfaVerifyBody` | 验证结果与恢复码 | — | — | 是 | — | — |
| POST | `/auth/step-up` | 基础 | `StepUpBody` | 再次验证通过，有效 10 分钟 | — | — | 是 | — | — |
| GET | `/auth/sessions` | 基础 | — | 会话列表（设备、地址、最近活跃） | — | — | — | — | 页码 |
| DELETE | `/auth/sessions/:id` | 基础 | — | 注销指定会话（补） | — | — | 是 | — | — |

## 四、范围与平台

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/scope/options` | 基础 | — | 当前成员可选的法律主体、店铺（仅授权范围内）、站点固定美国站、对比期选项 | — | — | — | — | — |
| POST | `/telemetry/web-vitals` | 基础 | `WebVitalsReport`（指标名 FCP/LCP/TTI/API、耗时毫秒、路由模板；不含任何用户或业务标识） | 已接收条数；只写入服务端指标，不落业务库（CR-019） | — | — | — | — | — |
| GET | `/freshness` | 基础 | `ScopeQuery` | 各数据域最近成功时间、延迟、覆盖店铺数、失败码 | — | — | — | — | — |
| POST | `/exports` | `export.create` | `ExportCreateBody`（来源页面、筛选条件、格式、字段） | 导出任务编号；按发起人字段权限生成；含敏感字段需再次验证 | — | — | 是 | 条件 | — |
| GET | `/exports` | 基础 | `CursorQuery` | 我的导出列表 | — | — | — | — | 游标 |
| GET | `/exports/:id` | 基础 | — | 状态、文件大小、过期时间 | — | — | — | — | — |
| GET | `/exports/:id/download` | 基础 | — | 签名链接（短时有效） | — | — | 是 | — | — |
| GET | `/storage/local/:token` | 公开（令牌） | — | 本地存储驱动的签名下载链接（补，P1-23）：令牌绑定文件与动作、短时有效，无登录态；使用阿里云对象存储时不存在 | — | — | — | — | — |
| PUT | `/storage/local/:token` | 公开（令牌） | — | 本地存储驱动的签名直传链接（补，P1-23）：令牌绑定文件、内容类型与大小上限；使用阿里云对象存储时不存在；写接口豁免幂等与通用审计，理由在代码里写明 | — | — | — | — | — |
| GET | `/views` | `view.manage` | `ViewListQuery` | 保存视图（个人与团队共享） | — | — | — | — | 页码 |
| POST | `/views` | `view.manage` | `ViewCreateBody` | 新视图 | — | — | 是 | — | — |
| PATCH | `/views/:id` | `view.manage` | `ViewUpdateBody` + `VersionBody` | 更新（补） | — | — | 是 | — | — |
| DELETE | `/views/:id` | `view.manage` | — | 删除（补） | — | — | 是 | — | — |
| GET | `/comments` | 随对象读权限 | `CommentListQuery`（对象类型、对象编号） | 评论与 @成员 | — | — | — | — | 游标 |
| POST | `/comments` | `collab.write` | `CommentCreateBody` | 新评论，触发被 @ 成员通知 | — | — | 是 | — | — |
| POST | `/watches` | `collab.write` | `WatchBody` | 关注对象 | — | — | 是 | — | — |
| DELETE | `/watches/:id` | `collab.write` | — | 取消关注（补） | — | — | 是 | — | — |
| GET | `/events` | 随对象读权限 | `EventListQuery`（对象、时间范围、类型） | 事件标注：我方改动、亚马逊侧变更、预警、促销、断货、手工记录 | — | — | — | — | 游标 |
| GET | `/operation-logs` | 随对象读权限 | `OperationLogListQuery` | 运营日志时间线（补） | — | — | — | — | 游标 |
| POST | `/operation-logs` | `collab.write` | `OperationLogCreateBody` | 手工记录运营动作（补） | — | — | 是 | — | — |
| GET | `/notifications` | 基础 | `CursorQuery` | 站内通知（消息中心）。**P5-11（CR-102）补**：新增筛选 `domain`（七个业务域或 `OTHER`；`OTHER` 即没有业务域的旧通知）与 `silenced`（`true` 只看免打扰期间收到的，`false` 排除）；`unread=true` 不含免打扰期间的通知；每条增加 `domain` 与 `silenced`；`unreadCount` 同样不含免打扰期间的通知 | — | — | — | — | 游标 |
| POST | `/notifications/read` | 基础 | `NotificationReadBody` | 标记已读（单个或全部）（补） | — | — | — | — | — |
| GET | `/notifications/unread-count` | 基础 | — | 本人未读通知数，顶栏消息入口使用（补，CR-022）。**P5-11 补**：不含免打扰期间收到的通知。**P6-01（CR-108）改**：响应 `{ unreadCount, messages, alerts }`，`messages` 与 `unreadCount` 同值，`alerts` 在预警按人已读（P6-15 的 `AlertRead`）上线前恒为 `null`（尚未接入，不是 0）。**P6-15（CR-123）改**：`alerts` 是当前用户的预警未读数（成员数据范围内、状态为新或已确认、且当前用户没有 `AlertRead` 记录）；没有 `alerts.read` 权限为 `null`，有权限但数据范围为空为 0 | — | — | — | — | — |
| GET | `/metrics/definitions` | 基础 | `MetricSearchQuery` | 指标定义、公式、来源、刷新频率、口径版本、变更历史、使用页面 | — | — | — | — | 页码 |

## 五、首页

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/overview/kpis` | `overview.read` | `ScopeQuery` | 7 个指标卡（销售额、净利润、利润率、广告花费、广告占总销售比、可售天数风险数、待处理异常数），含对比期、目标达成横幅、迷你趋势；净利润与利润率需 `field.profit`；P2a-02 已实现（CR-025）：没有显式时间范围时默认近 30 天、对比上一期；利润、广告、库存风险、官方净收益对照尚未接入，卡片状态为 `NOT_CONNECTED`，不返回 0；目标达成横幅 P2a-04 已实现（CR-027）：仅限单一自然月范围，取范围内各店铺整店销售额目标汇总对照实际，无店铺设置目标或跨月时 `NOT_CONNECTED` | — | — | — | — | — |
| GET | `/overview/trend` | `overview.read` | `ScopeQuery`、`granularity`、`metric` | 销售与利润双轴趋势，含同比、环比；P2a-02 已实现（CR-025）：粒度日、周（周一起）、月；指标销售额、订单数、件数、净利润、广告花费；未接入的指标返回状态而非 0 | — | — | — | — | — |
| GET | `/overview/attribution` | `overview.read` | `ScopeQuery`、`date`、`granularity` | 指标树归因：会话、转化率、件单价；利润桥；P2a-02 已实现（CR-025）：会话数据未接入时退化为“件数 × 件单价”两因子并写明原因，利润桥尚未接入 | — | — | — | — | — |
| GET | `/overview/store-compare` | `overview.read` | `ScopeQuery` | 店铺对比表；P2a-02 已实现（CR-025）：利润、广告占比、库存风险、账户健康按列返回状态 | — | — | — | — | — |
| GET | `/overview/volatility` | `overview.read` | `ScopeQuery` | 波动异常（P6-28，CR-147）：本期、上期、上上期三个等长首尾相接的期间（与对比期选择无关），列出销售额连续两期下降的 ASIN（上上期 > 上期 > 本期），按两期累计下降金额降序，最多 50 行；只在上上期销售额前 1000 个 ASIN 内检查；响应 `{period, previous, earlier, state, note, rows[], candidateLimit}` | — | — | — | — | — |
| GET | `/overview/asin-rank` | `overview.read` | `ScopeQuery`、`rankBy` | 利润前 10 与后 10；P2a-02 已实现（CR-025）：`rankBy` 为销售额、净利润、利润率、利润变化，默认销售额（利润接入前）；利润率与利润变化只在销售额前 1000 个 ASIN 内排名 | — | — | — | — | — |
| GET | `/overview/ad-anomalies` | `overview.read` | `ScopeQuery` | 广告异常；P2a-02 已实现为“尚未接入”占位（CR-025），由 P3 交付 | — | — | — | — | — |
| GET | `/overview/inventory-risk` | `overview.read` | `ScopeQuery` | 库存风险分布；P2a-02 已实现为“尚未接入”占位（CR-025），由 P2a-06 交付 | — | — | — | — | — |
| GET | `/overview/growth-waterfall` | `overview.read` | `ScopeQuery` | 增长归因瀑布，断货损失为模型估算并标注；P2a-02 已实现（CR-025）：断货损失尚未接入（金额为空），已接入项之和等于总变化 | — | — | — | — | — |
| GET | `/overview/cash` | `overview.read` | `ScopeQuery` | 现金视角；需 `finance.read` 否则不返回；P2a-02 已实现（CR-025）：已释放、递延中余额、下次打款日（不推测） | — | — | — | — | — |
| GET | `/overview/source-health` | `overview.read` | `ScopeQuery` | 数据源健康表（订单、库存、财务交易、报告、数据中心、广告、营销数据流、品牌分析、消息推送）；阶段 1 已实现（CR-023）：同步器未交付的来源显示“尚未接入”，推送类显示“未接入” | — | — | — | — | — |
| GET | `/today/summary` | `overview.read` | `ScopeQuery` | 今日累计与对比、"截至时刻"；P2a-03 已实现（CR-026）：接收端未配置返回 `NOT_CONNECTED` 并退化日终汇总；已配置无小时事件返回 `NO_DATA`；广告区一律未接入（P3-06） | — | — | — | — | — |
| GET | `/today/hourly` | `overview.read` | `ScopeQuery` | 小时曲线与历史同时段区间带；P2a-03 已实现（CR-026）：含区间带与小时级异常列表（一键待办由前端调 `POST /work-items`） | — | — | — | — | — |
| GET | `/today/events` | `overview.read` | `ScopeQuery`、`CursorQuery` | 事件流；P2a-03 已实现（CR-026）：读 `EntityEvent`（排除待办类），按企业时区今日、游标分页 | — | — | — | — | 游标 |
| GET | `/work-items` | 基础（本人）/ `workitem.read`（全部） | `WorkItemListQuery`（页签、来源、严重度、截止） | 待办列表，含影响金额区间、建议动作、剩余时限 | — | — | — | — | 游标 |
| GET | `/work-items/:id` | 同上 | — | 触发规则与证据、处理时间线、关联对象（补） | — | — | — | — | — |
| POST | `/work-items` | `workitem.assign` | `WorkItemCreateBody` | 手工生成待办（"一键生成待办"）（补） | — | — | 是 | — | — |
| PATCH | `/work-items` | `workitem.handle` | `WorkItemBatchBody`（批量） | 批量指派、确认、忽略（需 `ReasonBody`） | — | — | 是 | — | — |
| POST | `/work-items/:id/assign` | `workitem.assign` | `WorkItemAssignBody` | 指派或转派 | — | — | 是 | — | — |
| POST | `/work-items/:id/ack` | `workitem.handle` | — | 确认 | — | — | 是 | — | — |
| POST | `/work-items/:id/ignore` | `workitem.handle` | `ReasonBody` | 忽略（必须填原因） | — | — | 是 | — | — |
| POST | `/work-items/:id/close` | `workitem.handle` | `WorkItemCloseBody`（结论：已处理、无需处理、误报） | 关闭，结论回流规则质量统计 | — | — | 是 | — | — |
| POST | `/work-items/:id/defer` | `workitem.handle` | `WorkItemDeferBody`（含原因） | 延期（补） | — | — | 是 | — | — |
| GET | `/targets` | `targets.read` | `sellerAccountId`+`periodKind`+`periodStart`（单店铺单期间，非 `ScopeQuery`；P2a-04 已实现，CR-027） | 整店与细化（类目/ASIN 组）目标网格、达成进度、预测达成；含版本号 | — | — | — | — | — |
| GET | `/targets/history` | `targets.read` | 同上三参数（补，CR-027） | 该店铺该期间的目标变更事件时间线 | — | — | — | — | — |
| PUT | `/targets` | `targets.write` | `TargetsUpsertBody`（`sellerAccountId`/`periodKind`/`periodStart`/维度/维度引用/指标/目标值/节奏线/版本号）；P2a-04 已实现（CR-027） | 保存目标（整店或细化），带版本号的创建或更新，冲突检测 | — | — | 是 | — | — |

## 六、运营分析

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/analytics/sales-traffic/summary` | `analytics.read` | `ScopeQuery`、`compareTo` | 销售仪表盘：指标卡、转化漏斗（**P4-02 已实现，CR-077**；对比期用 `ScopeQuery` 的 `compare`，没有 `compareTo` 参数） | — | — | — | — | — |
| GET | `/analytics/sales-traffic/by-date` | `analytics.read` | `ScopeQuery`、`granularity` | 按日、周、月趋势（**P4-02 已实现，CR-077**） | — | — | — | — | — |
| GET | `/analytics/sales-traffic/by-asin` | `analytics.read` | `ScopeQuery`、`CursorQuery`、`level`（父体、子体、SKU）、`q`、`sort` | ASIN 明细（**P4-02 已实现，CR-077**；游标是“已翻过的位置”，不是排序键） | — | — | — | — | 游标 |
| GET | `/analytics/sales-traffic/trends` | `analytics.read` | `ScopeQuery`、`asin` | ASIN 级趋势（**P4-02 已实现，CR-077**） | — | — | — | — | — |
| GET | `/analytics/asins` | `analytics.read` | `AsinAnalyticsQuery`（对比最多 5 个） | 父体树与所选对象趋势（**P4-03 已实现，CR-078**；另有 `q`、`brand`、`category`、`tag`、`owner`、`risk`、`issue`、`select`；`risk` 需 `inventory.read`） | — | — | — | — | 游标 |
| GET | `/analytics/parents/:parentAsin/matrix` | `analytics.read` | `ScopeQuery`、`metric`、`pivot` | 子体贡献矩阵与变体透视（**P4-03 已实现，CR-078**） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/trend` | `analytics.read` | `ScopeQuery` | 子体趋势叠加（**P4-03 已实现，CR-078**） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/traffic` | `analytics.read` | `ScopeQuery` | 流量分布（**P4-03 已实现，CR-078**） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/inventory` | `analytics.read` | `ScopeQuery` | 库存与补货（补）（**P4-03 已实现，CR-078**；实际还需 `inventory.read`，补货建议列需 `replenishment.read`） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/ads` | `analytics.read`、`ads.read` | `ScopeQuery` | 广告覆盖与缺口（**P4-03 已实现，CR-078**） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/reviews` | `analytics.read` | `ScopeQuery` | 父体级评论主题（**P4-03 只给“尚未接入”，CR-078**；未用 `reviews.read`，P4-13 接入真实数据时再加） | — | — | — | — | — |
| GET | `/analytics/parents/:parentAsin/changes` | `analytics.read` | `ScopeQuery` | 变体结构变更历史（**P4-03 已实现，CR-078**） | — | — | — | — | 游标 |
| GET | `/analytics/brand/search-query` | `analytics.brand.read` | `BrandQuery`（维度、周期、关键词） | 关键词漏斗、搜索量与份额、价格与配送速度对比、词表、断点诊断（**P4-04 已实现，CR-079**） | — | — | — | — | 游标 |
| GET | `/analytics/brand/catalog` | `analytics.brand.read` | `BrandQuery` | 目录表现漏斗（**P4-04 已实现，CR-079**） | — | — | — | — | 游标 |
| GET | `/analytics/brand/search-terms` | `analytics.brand.read` | `BrandQuery` | 搜索频率排名、点击前三 ASIN（**P4-04 已实现，CR-079**） | — | — | — | — | 游标 |
| GET | `/analytics/brand/market-basket` | `analytics.brand.read` | `BrandQuery` | 同篮组合与同篮率（**P4-04 已实现，CR-079**） | — | — | — | — | 游标 |
| GET | `/analytics/brand/repeat-purchase` | `analytics.brand.read` | `BrandQuery` | 重复购买指标（**P4-04 已实现，CR-079**） | — | — | — | — | 游标 |
| GET | `/promotions` | `analytics.read` | `PromotionListQuery` | 促销列表（**P4-05 已实现，CR-080**） | — | — | — | — | 游标 |
| GET | `/promotions/:id` | `analytics.read` | — | 促销详情：效果、商品明细、成本、利润影响、校验问题、关联广告（**P4-05 已实现，CR-080**） | — | — | — | — | — |
| GET | `/subscribe-save` | `analytics.read` | `ScopeQuery` | 订阅省指标卡与趋势（**P4-06 已实现，CR-081**） | — | — | — | — | — |
| GET | `/subscribe-save/asins` | `analytics.read` | `SnsAsinListQuery` | 订阅省 ASIN 明细（**P4-06 新增，CR-081**） | — | — | — | — | 游标 |
| GET | `/subscribe-save/offers` | `analytics.read` | `SnsOfferListQuery` | 订阅省报价参与列表（**P4-06 新增，CR-081**） | — | — | — | — | 游标 |

> **P4-06 实现说明（CR-081）**：冻结的单条 `/subscribe-save`（指标、明细、报价合在一起）拆成三条只读路由，权限都是 `analytics.read`，**先 403、再校验参数、再读数据**，没有写路由（订阅省的报价与折扣在卖家后台设置）。`GET /subscribe-save`：`state`（`OK`/`NO_DATA`/`NOT_CONNECTED`/`NOT_APPLICABLE`/`ROLE_PENDING`，没有任何数据时区分“没同步 / 没开通订阅省 / 接口角色没批 / 同步了但没有记录”）、`range`（全局范围参数，默认近 30 天）、`compare`、`sync`、`freshness`（来源键 `replenishment.api`）、八张卡 `cards`（活跃订阅数取范围末日前最近一天的值，订阅出货件数与订阅销售额是范围内累计且可对比；未来 30、60、90 天预计订阅出货件数与参与订阅省的报价数永远取各店铺最近一次报价快照，不随日期范围变，超过 7 天的店铺不计入并标“数据已过期”；**订阅取消数恒为 `NOT_CONNECTED`**，同步器没有向亚马逊请求取消指标；金额按币种分别给，取金额最大的币种为主、其余在 `others`，不跨币种相加）、`trend`（日级趋势 `points`、近 6 个自然月 `months`、`coverage`：日级指标只同步最近 31 天，页面写明覆盖天数）、`forecast`（所依据的快照日期、报价数、有预测的报价数、过期店铺名、被补货建议用作确定性需求的报价数）、`truncated`、`basis`、`replenishNote`。`GET /subscribe-save/asins`：同店铺同 ASIN 的各 SKU 报价合并（件数相加，没有一条报价给值就是 `null`），筛选 `q`（ASIN 或 SKU 关键词），排序白名单 `forecastNext30/60/90`、`subscriptions`、`shippedUnitsPrevMonth`（默认未来 30 天预计出货降序），每行带 `replenishment`（是否被补货建议叠加，不叠加时写原因 `STALE`/`INELIGIBLE`/`NO_FORECAST`/`NO_PREV_MONTH`，规则与补货计算第 1 步逐条相同，两边有一致性测试）与 `productId`（用于跳转 ASIN 360，找不到为 `null`）。`GET /subscribe-save/offers`：每个店铺 SKU 一行，另有 `eligibility` 筛选（`ELIGIBLE`/`INELIGIBLE`/`SUSPENDED`），排序白名单 `forecastNext30`、`subscriptions`、`price`、`inventory`。两个明细都是游标分页（游标按位置切页、服务端签名并绑定租户与查询条件，换了条件 400），排序前的数据是各店铺最近一次快照，旧快照里已不在的报价不沿用，读取上限 19,999 行（超出 `truncated: true`）。与冻结的出入见 CR-081。

促销若接口不支持修改，则不提供写接口；支持时增加 `PATCH /promotions/:id`（受写入开关），届时走变更单（14.7）。

> **P4-05 实现说明（CR-080）**：两条只读路由，权限 `analytics.read`，**先 403、再校验参数、再读数据**。**亚马逊促销接口（v2025-12-01）只有三个查询操作，没有创建、修改、取消，所以按上面这条规则不提供任何写路由**（`verification-log.md` 第 11 条），详情响应里 `write: { supported: false, note }` 明确写明，页面顶部常驻说明“请到卖家后台创建或调整”。`GET /promotions`：游标分页，默认按开始时间新到旧，筛选 `status`（`PROCESSING`/`UPCOMING`/`RUNNING`/`EXPIRED`/`FAILED`/`CANCELLING`/`CANCELLED`）、`type`（`DEAL`/`COUPON`/`PRICE_DISCOUNT`/`BASKET_BUILDING`）、`q`（标题包含或促销编号开头）、全局范围参数的 `from`/`to`（按活动开始日）；响应 `state`（`OK`/`NO_DATA`/`NOT_CONNECTED`/`ROLE_PENDING`，没有行时区分“没同步 / 没有促销 / 接口角色没批”）、`sync`、`freshness`（三个来源：促销接口 `promotions.api`、促销绩效报告 `rpt.promotion-performance`、优惠券绩效报告 `rpt.coupon-performance`）、`basis`（口径说明）；每行除促销本身（折扣力度来自促销级 `benefit`，商品数没取回清单时是 `null`）还带 `reported`（报告汇总：`OK`/`NO_RECORD`/`NOT_CONNECTED`，按映射编号 `trackingId` 关联；优惠券读优惠券报告，其余读促销报告）与 `platformFee`（`OK`/`NO_DATA`/`RESTRICTED`（没有 `finance.read`）/`NO_ITEMS`（按目录选品或清单未同步）/`NOT_APPLICABLE`（价格折扣与满减没有登记的平台费用）/`INCOMPLETE`（同期费用事件超过 5,000 条或一页商品合计超过 10,000 个，不给不完整的数字））。`GET /promotions/:id`：`:id` 是系统编号或亚马逊促销编号（范围外与别的企业 404）；一次返回六个页签，每个页签自带 `state` 与 `note`：**effect**（活动期间实际销量销售额对比基线：基线取活动开始前 28 天里没被其他促销占用、有数据的日子、按星期对齐，有效日少于 14 天不给增量；同店同期的按目录选品的促销、清单没同步的促销、商品有交集的促销都算“占用”；每日对比；绩效报告数字另列，不混进估算）、**items**（商品清单前 500 个，商品主数据链接要 `products.read`，商品级问题）、**cost**（折扣成本取订单明细的促销折扣合计，要 `orders.read`；平台费用从费用事件归集，要 `finance.read`；亚马逊预览费率）、**profit**（增量毛利与促销投入回报率，要 `profit.read` + `field.profit`；某天利润日表有一行缺成本这天就“未知”，不拿部分行凑数）、**issues**（促销级问题、商品级问题条数、最近一次修订状态）、**ads**（要 `ads.read`；复用 ASIN 广告覆盖，只含美元）。状态取值：`NOT_STARTED`、`NO_EFFECT`（失败、已取消、处理中）、`NO_ITEMS`、`INSUFFICIENT`（基线不足）、`RESTRICTED`、`NOT_CONNECTED`、`NO_DATA`、`OK`。`methodNote` 写明基线法与回报率公式，页面常驻。与冻结的出入见 CR-080。

> **P4-04 实现说明（CR-079）**：`/analytics/brand/{search-query,catalog,search-terms,market-basket,repeat-purchase}` 五条只读路由，权限都是 `analytics.brand.read`（只有 `analytics.read` 不行），**先 403、再校验参数、再读数据**；店铺范围用全局范围参数。品牌分析没有“日期范围”，只有 **周期种类 `period`（`WEEK` 默认、`MONTH`、`QUARTER`）+ 周期起始日 `periodStart`**（必须对齐：周日、每月 1 日、1/4/7/10 月 1 日，否则 422），不传起始日就用这种周期里最近一个有数据的周期，并对比上一个同种周期。共同头部 `BaCommon`：`state`（`OK`/`NO_DATA`）、`note`、`period`（`kind`、`start`、`end`、`previousStart`、`available` 最近 24 个有数据的周期、`defaulted`）、`stores`（每家店这份报告最近一次同步结果：`AVAILABLE`/`NO_BRAND`（缺品牌备案或品牌分析角色，单独说明）/`FAILED`/`NO_RECORD`）、`truncated`（读到 19,999 行上限）、`basis`、`freshness`（来源键 `rpt.ba.search-query`、`rpt.ba.search-catalog`、`rpt.ba.search-terms`、`rpt.ba.market-basket`、`rpt.ba.repeat-purchase`）。官方没给的值是 `null`，不是 0；份额按次数重算（我方次数 ÷ 市场总次数），不对份额做简单平均。`search-query`：`dimension`（`BRAND` 默认 / `ASIN`）、`asin`、`brand`、`q`、`sort`（白名单 7 列）；响应有四层漏斗（展示、点击、加购、购买的市场总量、我方、份额）、逐期趋势（搜索量前 500 个词、最多回看 12 期）、价格对比（点击、加购、购买的我方与市场中位价）、配送速度份额（当日、次日、两日）、`quadrant`（机会象限：横轴搜索量、纵轴购买份额，按全部词的中位数划分，至少 5 个带完整份额的词才分析）、`breakpoints`（份额漏斗断点诊断：展示高点击低、点击高加购低、加购高购买低，“高/低”以中位数为界，上游优先，每类给搜索量最高的例子词）、`overview`（品牌搜索份额总览：按词根汇总我方点击与购买份额，前 20 个词根）、词表（含 `advertising`：已投放 / 已暂停 / 未投放 / 尚未接入，按关键词文本不分大小写对照广告关键词；未投放的词带“加入投放”链接，**只跳到词级分析页，不直接写亚马逊**）。`catalog`：按 ASIN 的搜索漏斗与各步转化率（由次数重算），带上一期对比与业务报告对照（搜索带来的销售额占订购销售额的比例）。`search-terms`：搜索频率排名、点击份额前三的商品与转化份额，`filter`（`ALL`/`OPPORTUNITY`/`RISK`/`TOP3`），`term` 带出该词最近 12 期的排名与我方份额；机会词与风险词规则是自定常量（见契约 `BA_TERM_RULES`）；热门搜索词是全市场数据，企业下多家店铺各存一份，按（部门、搜索词）去重取排名最靠前的一行；“竞品 ASIN 一键加入竞品监控”未做（P4-12，页面只写明）。`market-basket`：同篮率、15×15 热力矩阵与建议（两个都是我方 ASIN 且同篮率不低于 10% → 捆绑销售候选；同篮的不是我方 ASIN 且不低于 5% → 商品定向广告候选，只是建议）。`repeat-purchase`：订单数、独立买家数、复购买家占比（**官方给的是“复购买家占全部买家的比例”，不是“复购订单占比”**）、复购销售额与占比（只认美元），可按品牌或 ASIN 拆分并看趋势。所有列表是游标分页，游标签名并绑定租户与查询条件（换了条件 400 `CURSOR_INVALID`）。**与 P3-10 的连接**：`GET /ads/terms/detail` 的 `brand` 现在有数据（见上表该行）。与冻结的出入见 CR-079。

> **P4-02 实现说明（CR-077）**：`/analytics/sales-traffic/{summary,by-date,by-asin,trends}` 四条只读路由（`analytics.read`），挂在已有的 `analytics` 模块里，权限先于参数校验（先 403 再 422），范围参数同其他分析接口。数据只读 P4-01 的 `SalesTrafficDaily` 与 `SalesTrafficAsinDaily`，只认美元行；同店同日（ASIN 表是同店同 ASIN 同 SKU 的整段范围）两个来源都有时只用数据中心，不逐列混合。所有响应有共同头部：`state`（`OK`/`NO_DATA`）、`note`、`range`（含 `defaulted`）、`currency`、`stores`（每家店 `AVAILABLE`/`NO_BRAND`/`FAILED`/`NO_RECORD`）、`latestDate`、`truncated`（读到 19,999 行/分组上限）、`basis`、`freshness`。官方没给的值一律是 `null`，不是 0。`summary`：`cards`（10 个指标，变化：金额与数量是比率、百分比是百分点差）、`coverage`、`trend`/`compareTrend`（逐日补齐）、`funnel`（会话→页面浏览量→订单商品数→订购件数）、`attribution`（销售额 = 会话 × 转化率 × 件单价，缺数据时为 `null` 并给 `attributionNote`）、`split`（自然销售 = 订购销售额 − 广告销售额，广告大于订购标 `MISMATCH`，不夹成 0）、`deviceSplit`（恒为 `NOT_CONNECTED`，同步器没有保存浏览器与移动应用拆分列）；没选日期默认最近 30 天并对比上一期。`by-date`：`granularity` 默认 `DAY`；日粒度逐日补齐并支持对比期，周（周日起）与月粒度只列有记录的期间、不支持对比期（`compareNote` 说明）；没选日期时日 30 天、周 12 周、月 12 个月。`by-asin`：`level` 默认 `CHILD`，`q` 搜 ASIN 或 SKU，`sort` 白名单 7 列、有值的在前、没有值的永远在最后；数据库按 店铺 × ASIN × SKU × 来源 汇总，内存里取舍来源、算比率、排序，游标签名并绑定租户与全部查询条件（条件变了 400 `CURSOR_INVALID`）。`trends`：`asin` 必须是 10 位字母数字，只取子体粒度逐日行，范围内所有店铺逐日相加。与冻结的出入见 CR-077。

> **P4-03 实现说明（CR-078）**：九条只读路由（`GET /analytics/asins`、`/analytics/parents/:parentAsin` 及 `/matrix`、`/trend`、`/traffic`、`/inventory`、`/ads`、`/reviews`、`/changes`），都要 `analytics.read`，权限先于参数校验。`/analytics/parents/:parentAsin`（身份区）是冻结表里没有的补充路由：返回子体数、销售额、转化率、净利润（需 `profit.read` 与 `field.profit`，否则 `RESTRICTED`）、有高/中库存风险的子体数（需 `inventory.read` 与生效的补货策略，否则 `RESTRICTED` 或 `NOT_CONNECTED`）；未知父体 404。额外权限在参数解析与任何查询之前检查：库存页签与 `risk` 筛选要 `inventory.read`，广告页签要 `ads.read`（缺权限 403）。数据：`SalesTrafficAsinDaily` 子体粒度（数据中心优先于报告、只认美元）加 `AsinDailySummary`（件数、广告销售、可售库存）、`FbaReturnCase`、`SalesRankSnapshot`；父体数字 = 名下子体相加（父体没有销售排名）；变体属性来自 `FbaProduct.variantAttributes`（目录同步写入，没同步过就是 `NOT_CONNECTED`，不从 SKU 或标题猜）。`/analytics/asins`：树按销售额降序，每页 20 个顶层节点（游标），筛选在内存里做（最多读 19,999 个商品），`select` 最多 5 个（`parent:ASIN` 或 `asin:ASIN`，逗号分隔），没选时默认选树顶第一项并标 `selectionDefaulted`；每个父体最多展开 300 个子体（按销售额），超出标 `membersTruncated`。`/changes`：来自 `EntityEvent` 的 `variation.child_added`、`variation.child_removed`、`variation.attribute_change`，最多读 500 条，偏移游标；事件从目录同步第二次起才有。与冻结的出入见 CR-078。

## 七、商品

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/products` | `products.read` | `ProductListQuery` | 商品列表（图片、ASIN、SKU、FNSKU、父体、品牌、类目、状态、价格、可售、近 30 天销售、问题数、质量分、利润率*、负责人、标签）；*需 `field.profit`（**P4-07 已实现，CR-082；问题数与质量分尚未接入，见下方实现说明**） | — | — | — | — | 游标 |
| PATCH | `/products/meta` | `catalog.meta.write` | `ProductMetaBatchBody` | 批量设置负责人、标签（系统内数据）（补；**P4-07 已实现，CR-082**） | — | — | 是 | — | — |
| POST | `/products/sync` | `sync.manage` | `ProductSyncBody` | 按店铺同步商品目录（**P4-07 新增，CR-082**），返回已发起的任务与跳过的店铺 | — | — | 是 | — | — |
| GET | `/products/:id` | `products.read` | — | ASIN 360 身份区 | — | — | — | — | — |
| GET | `/products/:id/overview` | `products.read` | `ScopeQuery` | 经营表现页签 | — | — | — | — | — |
| GET | `/products/:id/traffic` | `products.read` | `ScopeQuery` | 流量转化页签 | — | — | — | — | — |
| GET | `/products/:id/ads` | `products.read`、`ads.read` | `ScopeQuery` | 广告页签 | — | — | — | — | — |
| GET | `/products/:id/inventory` | `products.read`、`inventory.read` | `ScopeQuery` | 库存补货页签 | — | — | — | — | — |
| GET | `/products/:id/economics` | `products.read`、`profit.read` | `ScopeQuery` | 利润与成本页签：单位经济瀑布、官方对照、成本版本、费用预览；需 `field.cost`、`field.profit` | — | — | — | — | — |
| GET | `/products/:id/returns` | `products.read`、`returns.read` | `ScopeQuery` | 退货页签 | — | — | — | — | — |
| GET | `/products/:id/listing` | `products.read`、`listing.read` | — | 刊登与问题页签 | — | — | — | — | — |
| GET | `/products/:id/reviews` | `products.read`、`reviews.read` | — | 评价页签 | — | — | — | — | — |
| GET | `/products/:id/pricing` | `products.read`、`pricing.read` | `ScopeQuery` | 定价与购物车页签 | — | — | — | — | — |
| GET | `/products/:id/competitors` | `products.read`、`competitors.read` | `ScopeQuery` | 竞品页签 | — | — | — | — | — |
| GET | `/products/:id/content` | `products.read`、`aplus.read` | `ContentCompareQuery`（两个日期） | 内容与 A+ 页签、字段级对比 | — | — | — | — | — |
| GET | `/products/:id/changes` | `products.read` | `CursorQuery` | 变更与审计页签 | — | — | — | — | 游标 |
| GET | `/products/:id/compare` | `products.read` | `ScopeQuery`（`from/to/compare/compareFrom/compareTo`） | P6-21 同环比明细：9 个指标 `{metric,value,prevValue,changeRate,changeValue}`；利润列需字段权限，缺则 `RESTRICTED` | — | — | — | — | — |
| GET | `/products/:id/competitor-compare` | `products.read`、`competitors.read` | `ScopeQuery` | P6-21 竞品对比：本品与绑定到本 ASIN 的竞品（最多 5 个）并列价格、销售排名、评分、评论数；竞品评分无官方来源，写原因；评分需 `reviews.read` | — | — | — | — | — |
| GET | `/products/:id/alerts` | `products.read`、`alerts.read` | — | P6-21 预警日志：只含与本商品有关的预警（ASIN/SKU/库存对象），最多 200 条，新到旧（补） | — | — | — | — | — |
| GET | `/products/:id/actions` | `products.read` | — | 建议动作区：触发条件、建议、预估影响、执行入口（补） | — | — | — | — | — |

> **P4-07 实现说明（CR-082）**：三条路由都先查权限（403）、再校验参数（422）、再读写数据。`GET /products`：全局范围参数加筛选 `q`（ASIN 前缀、SKU 与 FNSKU 前缀、标题包含）、`asin`、`sku`、`parentAsin`、`brand`（不分大小写相等）、`category`（包含）、`status`、`fulfillment`（`AFN`/`MFN`）、`ownerId`、`tag`、`risk`（库存风险等级，**要求 `inventory.read`，否则 403**，用库存健康页同一套装配与规则，最多评估 5000 条库存记录，没有生效的库存规则时没有风险结论、筛选结果为空）、`watched`（`true` 只看自己已关注的、`false` 排除）；排序白名单 `updatedAt`（默认降序）、`asin`、`sku`、`price`、`sales30`、`units30`、`margin30`、`sellable`，数值列没有值的永远排在最后；游标分页是服务端签名的偏移游标，绑定租户与全部查询条件，换了条件 400；读取上限 19,999 个商品（`truncated`）。每行带 `sales30`、`units30`（近 30 天窗口 = 企业时区今天往前 29 天到今天，订单口径美元，按店铺 × ASIN 汇总，同店同 ASIN 的多个 SKU 共用同一份，`salesShared: true`，没有记录是 `null` 不是 0）、`sellable`（库存接口最近一次可售数量，没有 `inventory.read` 或没有库存记录为 `null`）、`margin30` 与 `marginState`（`OK`/`NO_SALES`/`COST_MISSING`/`NO_RECORD`；**需要 `profit.read` 与 `field.profit`，没有时这两个字段整个不出现**；按下单口径的利润日表合计，任何一天缺成本整组为 `null`）、`version`（乐观锁）、`catalogState`；顶层 `stock`/`profit`（`OK`/`NO_DATA`/`RESTRICTED` 与原因）、`filterOptions`（可见范围内已有的品牌、类目、状态、标签、负责人）、`members`（可设置的在职成员，没有 `catalog.meta.write` 时为空）、`canWrite`、`freshness`（订单、库存、商品目录三个来源）、`notConnected`（刊登问题数与质量分尚未接入的说明）。**刊登问题数、刊登质量分以及对应的两个筛选没有做**：数据来源是刊登表现与刊登质量（P4-09、P4-10），现在没有。`PATCH /products/meta`：每个商品带 `version`，标签 `ADD`/`REMOVE`/`SET`、负责人（`null` 清空），整批在一个事务里全有或全无：版本冲突 409、范围外或不存在的商品 404（不泄露存在性）、标签含逗号或超限与负责人不是在职成员与同一商品重复都是 409；每个真正有变化的商品写一条 `EntityEvent`（`entityType: ASIN`、`kind: product.meta`，ASIN 360 的“变更”页签读它）和一条审计 `PRODUCT_META_UPDATED`，没变化的商品不涨版本。`POST /products/sync`：商品目录同步是店铺授权级任务，请求体 `storeIds`（1 到 50 个）；每个店铺找已授权的亚马逊连接，复用同步中心的入队与去重（同一连接已有排队或运行中的 `CATALOG_SYNC` 任务时返回同一个任务），没有已授权连接的店铺放进 `skipped` 并写明原因；范围外或不存在的店铺 404；成功返回 201；审计 `PRODUCT_CATALOG_SYNC_REQUESTED`。导出走通用的 `POST /exports`，`kind: products`，筛选键 `storeIds`、`q`、`asin`、`sku`、`parentAsin`、`brand`、`category`、`status`、`fulfillment`、`ownerId`、`tag`，**只导出商品自身的资料，不含销售、利润与库存数字，也不支持库存风险与“只看已关注”**。

> **P4-08 实现说明（CR-083）**：ASIN 360 剩余六个页签上线（`traffic`、`listing`、`reviews`、`content`、`pricing`、`competitors`），**六条只读路由都在冻结表里，没有新增路由、没有迁移、没有新权限点**（沿用 `products.read` 加 `listing.read`、`reviews.read`、`pricing.read`、`competitors.read`、`aplus.read`；流量转化只要 `products.read`），顺序统一为权限（403）→ 按成员数据范围找商品（范围外与别的企业 404）→ 校验参数（422）→ 读数据；`ASIN360_TABS` 12 个页签全部 `live`。契约 `packages/api-contracts/src/asin360-more.ts`（常量、口径文字、`ASIN360_PENDING_SECTIONS`、各响应类型、`ASIN360_ACTION_RULES` 与 `asin360ActionRuleViews`，没有 zod）与 `asin360-more-query.ts`（`Asin360PeriodQuerySchema`，zod 单独成文件）。**`GET /products/:id/traffic`**（`ScopeQuery`，不选默认最近 30 天）：`daily`（逐日会话、页面浏览、件数、销售额、购物车获得率、转化率，范围内每天一点、没记录是 `null`，汇总的转化率 = 件数 ÷ 会话、购物车获得率按会话加权；只读子体粒度、美元；数据中心优先于报告）、`searchFunnel`（品牌分析“搜索查询表现”：我方 ÷ 市场总次数的四层漏斗、核心搜索词最多 20 个按搜索量排序、断点诊断，以这个 ASIN 自己全部搜索词的份额中位数为界，不足 5 个词不诊断）、`catalogFunnel`（“搜索目录表现”，本周期与上一周期）、`pending`、`freshness`、`basis`；另带 `period`（`WEEK` 默认 / `MONTH` / `QUARTER`）与 `periodStart`（必须对齐，否则 422）。**品牌分析两块另需 `analytics.brand.read`，没有时整块 `state = RESTRICTED`，不是 403**，逐日流量照常；店铺从没同步过品牌分析是 `NOT_CONNECTED`，缺品牌备案或角色（`BA_NO_BRAND`）单独说明。`GET …/listing`、`/content`：只列商品目录同步已经写入的字段（`facts`，没有取值是 `null`）；`/reviews` 只有 `pending`。`GET …/pricing`（`ScopeQuery`）：当前标价（最近一次同步值与同步时间）、逐日成交均价（订单口径销售额 ÷ 件数，没有件数为 `null`）、购物车获得率。`GET …/competitors`（**冻结表写 `ScopeQuery`，本包改为 `period` / `periodStart`**，品牌分析没有日期范围）：这个 ASIN 搜索量最高的 5 个核心搜索词，对照品牌分析“热门搜索词”里点击份额前三的商品，词匹配不分大小写、整词相等，标出本品与企业范围内我方其他商品；需 `competitors.read`，品牌数据读取不另要 `analytics.brand.read`。**五个页签里没有数据来源的区块一律在 `pending` 里列出，`state` 恒为 `NOT_CONNECTED`，并写明负责的工作包（官方接口没有的写 `workPackage: null`），不返回 0 或示例数字**。冻结的 `/content` 的 `ContentCompareQuery`（两个日期的字段级对比）**没有实现**（需要按日留存内容快照，P4-14）。`GET /products/:id/actions` 增加 **`rules`**：建议动作区 6 条规则各自的状态（`TRIGGERED` / `CLEAR` / `NO_DATA` / `RESTRICTED` / `NOT_CONNECTED`）：库存类两条（可售天数低于目标 ← 补货建议，库龄附加费 ← 库龄建议）按库存详情判断，没有 `inventory.read` 是 `RESTRICTED`、没有库存记录是 `NO_DATA`；其余四条（价格高于预期获胜价、新增刊登错误、负面评论主题上升、详情页被他人修改）**一律 `NOT_CONNECTED`，不当作“没触发”**。

> **P4-09 实现说明（CR-084）**：刊登表现 **一条只读路由** `GET /listings/performance`（冻结表里已有，没有新增；权限 `listing.read`，顺序为权限（403）→ 校验参数（422）→ 读数据）。参数：全局范围参数（不选默认最近 30 天，写在 `range.defaulted`；上一周期 `previousRange` 是同长度紧邻的前一段）加 `q`（ASIN 前缀、SKU 与 FNSKU 前缀、标题包含）、`brand`、`category`、`status`、`fulfillment`（`AFN`/`MFN`）、`ownerId`、`anomaly`（只能是 `CONVERSION_DROP`，其余三类异常没有来源，传了 422）、`sort`（白名单 `sales` 默认降序、`units`、`sessions`、`pageViews`、`conversion`、`buyBox`、`price`、`adsSales`、`returnRate`、`daysOfSupply`、`asin`、`sku`，数值列没有值的永远在最后）、`pageSize`、`cursor`（服务端签名的偏移游标，绑定租户与全部查询条件，换了条件 400）。读取上限 19,999 个商品（`truncated`），排序与分页在内存里做。响应 `ListingPerfResponse`（契约 `packages/api-contracts/src/listing-performance.ts`，只有常量与类型）：`state`（`OK` / `NO_DATA` 被筛空 / `NOT_CONNECTED` 可见范围内没有商品）与 `note`、`items`、`pageInfo`、`range`、`previousRange`、`currency`（恒为 `USD`）、`trend`（范围内每天一点，没记录的日子各指标是 `null`）、`anomalies`（四类各带 `state`/`count`/`note`，三类没有来源的是 `NOT_CONNECTED` 且 `count` 为 `null`）、`gates`（`traffic`/`ads`/`returns`/`stock` 各自 `OK`/`NO_DATA`/`RESTRICTED`/`NOT_CONNECTED` 与原因）、`pending`（评分、评分数、刊登问题数、刊登质量分四列及负责的工作包）、`filterOptions`、`truncated`、`freshness`（销售与流量、库存、商品目录）、`basis`。每行：会话、浏览量、销量、销售额、转化率、购物车获得率（销售与流量表，子体粒度、美元、数据中心优先，**按店铺 × ASIN 汇总，同 ASIN 的多个 SKU 共用，`salesShared`**）、上一周期的会话与转化率、`price`（目录最近一次标价）、`adsSales`（需 `ads.read`）、`returnRate`（需 `returns.read`，估算）、`daysOfSupply`（需 `inventory.read`，可售数量 ÷ 范围最后 7 天日均订购件数），没有记录或没有权限都是 `null`，原因看 `gates`。纯函数在 `listing-performance-math.ts`（`listingConversion`、`isConversionDrop`、`listingDaysOfSupply`、`listingReturnRate`、`compareListingRows`、`compareLines`），转化率骤降的阈值（两期会话 ≥ 100、转化率相对下降 ≥ 30%）是常量 `LISTING_MIN_SESSIONS` 与 `LISTING_CONVERSION_DROP_RATIO`。
> **P4-10 实现说明（CR-085）**：刊登质量与合规，**读 3 条、写 4 条**（路由与冻结表不同：冻结表按 `:sku` 与 `previewToken`，实际 SKU 只在店铺内唯一，所以 SKU 与店铺编号都放请求体，校验令牌用校验预览的任务编号 `previewRunId`；批量任务的查询并入统一的 `runs`）。全部路由顺序：权限（403）→ 校验参数（422）→ 店铺在数据范围内（范围外 404）→ 业务条件。**`GET /listings/quality`**（`listing.read`，`ListingQualityQuery`：全局范围参数加 `tab`（`issues` 默认 / `suppressed` / `restrictions` / `missing` / `productType` / `otherEdits` / `inactive`）、`severity`、`status`（`OPEN` 默认 = 新增 + 处理中 / `NEW` / `IN_PROGRESS` / `RESOLVED` / `ALL`）、`impact`、`ownerId`，排序白名单 `firstSeen` 默认降序、`lastSeen`、`severity`、`sku`，游标分页）：响应 `ListingQualityResponse`：`tab`、`state`（`OK` / `NO_DATA` / `NOT_CONNECTED`）与 `note`、按页签分的行集合（`issueRows` 问题项、被搜索抑制与属性缺失；`changeRows` 商品类型变更与他人内容修改；`inactiveRows`；`restrictionRows`）、`pageInfo`、`counts`（七个页签各自的条数，问题类按“未解决”计，刊登限制是未过期的查询结果数）、`stats`（范围内新增与解决数、未解决合计、处理中、错误与警告数、影响销售的问题数、平均解决时长，没有已解决样本时是 `null`）、`sources`（刊登同步、被搜索抑制报告、推送等来源各自的状态，**推送一律“尚未接入”**）、`freshness`、`basis`（口径说明）、`write`（`validate` / `update` / `batch` 三个动作各自的可用状态：权限 → 店铺授权 → 写入开关，不可用时带原因与去处，页面据此置灰）、`stores`（范围内店铺，供选择）。问题行带 `impactEstimate`：问题存续期日均销售额与此前同长度时段对比，**一律标估算**，存续不足 2 天、销售汇总里没有这个商品、此前没有销售记录都给 `NO_DATA` 与原因，不写 0；存续天数封顶 180，每页最多估算 200 行，读取按每批 10 个 ASIN × 20,000 行分批。**`POST /listings/validate`**（`listing.write`，不需要写入开关，不改亚马逊的数据）：`{ storeId, sku, productType?, patches[] }`，入队后立即返回任务记录；`patches` 每项 `{ op: replace | delete, attribute, values?, languageTag? }`，一次 1 至 10 项，同一属性只能出现一次，价格、库存与配送类属性（`purchasable_offer`、`list_price`、`fulfillment_availability` 等）一律 422。校验通过的预览 30 分钟内可用。**`POST /listings/patch`**（`listing.write`，开关 `sw.listing.update`）：多带 `previewRunId`；409 的错误码：`PREVIEW_REQUIRED`（没带或不是校验通过的预览）、`PREVIEW_EXPIRED`（超过 30 分钟）、`PREVIEW_MISMATCH`（修改内容或商品与预览不一致）、`LISTING_RUN_STALE`（同一商品已有未完成的修改）。**`POST /listings/batch`**（`listing.write`，开关 `sw.feeds.batch`）：`{ storeId, items[{ sku, patches[] }] }`，最多 200 个商品、SKU 不能重复，每个商品必须已有同步下来的商品类型，否则 422；整体交 Feeds API（`JSON_LISTINGS_FEED`，每个商品一条 PATCH 消息）。**`POST /listings/restrictions`**（权限 `listing.read`，只读）：`{ storeId, asins[1..20], conditionType? }`，结果随任务记录保存，1 小时后过期。四条写路由都返回 **201** 与 `{ run, state }`：`state = QUEUED` 表示已受理进入后台队列（**受理不等于亚马逊已处理**），`FAILED` 表示没能入队，记录与同步任务已标失败（`QUEUE_UNAVAILABLE`），可重新提交。审计 `LISTING_VALIDATE_REQUESTED`、`LISTING_PATCH_SUBMITTED`、`LISTING_BATCH_SUBMITTED`、`LISTING_RESTRICTIONS_REQUESTED`，与任务记录在同一事务内写入。**`GET /listings/runs`**（`listing.read`，可选 `kind`，最近 50 条）与 **`GET /listings/runs/:id`**：查看任务记录与逐个商品的结果；**列表不按成员的店铺范围过滤**（任务记录属于企业，详情按店铺范围 404），见 CR-085 披露。亚马逊的调用都在后台任务 `LISTING_WRITE` 里，批量任务的处理结果由后台每 30 秒轮询一次、最多 240 次（约 2 小时），超时以 `FEED_TIMEOUT` 结束。契约 `packages/api-contracts/src/listing-quality.ts`（常量、状态与影响的纯函数、影响估算、响应类型）、`listing-quality-write.ts`（修改项校验、亚马逊局部修改与批量文件的构造、失败码文字）、`listing-quality-query.ts`（zod）。
> **P4-11 实现说明（CR-086）**：定价与购物车，**读 5 条、写 6 条**（比冻结表多两条：`POST /pricing/:sku/validate`、`POST /pricing/rule-runs/:id/dismiss`）。SKU 只在店铺内唯一，所以详情、模拟、校验与改价都带 `storeId`（详情是查询参数，其余在请求体里）；顺序统一为权限（403）→ 校验参数（422）→ 店铺在数据范围内（范围外与别的企业 404）→ 业务条件；静态路径 `guardrails`、`rules`、`rule-runs` 写在 `:sku` 之前。**`GET /pricing`**（`pricing.read`，`PricingListQuery`：全局范围参数加 `q`、`health`（七种价格健康）、排序白名单 `sku`/`price`/`gap`（默认降序）/`margin`/`buyBox`/`lastChange`、游标分页）：`PricingListResponse` 的 `state`（`OK`/`NO_DATA`/`NOT_CONNECTED`）、`items`（`PricingRow`：当前价与同步时间、推荐报价价格与我方是否获得、最低竞争价、预期获胜价与接口结论、差距（我方价 − 预期价）、近 30 天购物车获得率（按会话加权）、价格健康、最近一次调价、两种价格下的利润率（估算；缺成本或没有 `field.profit` 时数值为 `null` 并由 `margin.state` 说明）、适用的护栏）、`summary`、`stores`、`write`（`validate`/`update`/`rule` 三个动作各自按权限 → 连接 → 开关判断）、`marginBasis`、`freshness`（来源键 `pricing.api`）。**`GET /pricing/:sku`**（`storeId`；冻结表写 `ScopeQuery`）：`row`、近 90 天价格历史（价格快照只在变化或每 24 小时写一条，所以是阶梯曲线）、当前报价与竞争（`offerKey` 是卖家编号的哈希，不存别家卖家编号原文）、事件（价格变化、改价提交、获得与失去推荐报价、价格健康推送）、调价记录（带前后各 7 天对照，调价后不满 3 天是 `WAITING`）、适用的护栏、待确认的规则建议、`write`。**`POST /pricing/:sku/simulation`**（`pricing.read`，只读、不写审计，返回 200；**另需 `field.profit`，没有时 403**）：估算净利与利润率（佣金、退款、促销按售价等比例变化，其余费用与成本每件固定）、盈亏平衡价、是否达到预期获胜价、护栏是否通过与原因、价格弹性（近 90 天对数回归，价格有过 3% 以上变动且不少于 8 天样本才给，否则 `INSUFFICIENT` 并写原因）与日销量、日利润预测。**`POST /pricing/:sku/validate`**（新增，`pricing.price.write`，不需要写入开关，返回 201）：服务端先按护栏检查（超出返回 422，`details.code = GUARDRAIL_BLOCKED`、`details.violations` 是违规代码），再受理一次“价格校验预览”（亚马逊只检查不修改，复用 `ListingWriteRun`，种类 `PRICE_VALIDATE`），响应是任务记录。**`PATCH /pricing/:sku`**（`pricing.price.write` + 开关 `sw.pricing.update`，返回 200，只代表“已受理”；**请求体用 `previewRunId` 代替冻结的 `previewToken`**）：必须有 30 分钟内校验通过的预览且价格与校验过的完全一致（409，`details.code` 为 `PREVIEW_REQUIRED` / `PREVIEW_EXPIRED` / `PREVIEW_MISMATCH`），同一 SKU 有未完成的写入也是 409（`LISTING_RUN_STALE`），护栏在这里再核一遍；来自规则建议时带 `ruleRunId`（建议必须是待确认且价格等于建议价），同一事务里把建议标为已提交；种类 `PRICE_PATCH`，后台任务 `LISTING_WRITE` 调刊登接口改报价。`/listings/runs` 默认不列价格写入记录（`PRICE_VALIDATE`、`PRICE_PATCH`），按编号读 `/listings/runs/:id` 照常。**`GET`/`PUT /pricing/guardrails`**（冻结表写 `CursorQuery`；实际可选 `storeId`，最多返回 2000 条并带 `truncated`）：同一字段多层护栏时按 SKU > ASIN > 类目 > 店铺取最具体且有值的一层；修改已有护栏必须带 `expectedVersion`（缺少是 409 `VERSION_REQUIRED`，版本不符 409）。**`GET`/`POST /pricing/rules`、`PATCH /pricing/rules/:id`**（冻结表写页码分页，实际一次最多 100 条并带 `truncated`）：每家店铺最多 50 条规则、同店规则名不能重复；`BREAKER`（熔断）状态不能手工设置，只能由系统熔断，恢复只能把状态改回 `ACTIVE`；策略建好后不能改；自动规则在开关没打开时仍可创建，响应的 `autoReady`、`autoNote` 写明“现在只生成建议”。**`POST /pricing/rules/:id/dry-run`**（`pricing.rule.write`，返回 200，只读但写审计）：最多 30 天，历史每天按当天结束时的数据逐日模拟（单位经济取最新值，是近似），当前命中最多 200 个 SKU；不写执行记录。**`GET /pricing/rules/:id/runs`**（冻结表写 `CursorQuery`，实际 `RuleRunListQuery`，可按 `outcome` 筛选、按 `runAt` 排序）：执行记录；已执行的带前后对照（每页最多算 20 条）。**`POST /pricing/rule-runs/:id/dismiss`**（新增，`pricing.price.write`，返回 200）：忽略一条待确认的建议，同一个建议价 7 天内不再被建议。后台：`PRICING_SYNC` 每 2 小时一次，规则扫描每小时一次（自动规则要两个开关都打开才真正提交，否则降级为建议并写明原因；连续失败、调价后转化率下降、调价后利润率不达标会熔断）。
>
> **P4-12 实现说明（CR-087）**：竞品监控，**读 3 条、写 2 条**（比冻结表多一条：`GET /competitors/candidates` 搜索词推荐，静态路径写在 `:asin` 之前）。同一个竞品 ASIN 可在多个店铺、对应多个我方商品里关注，所以**详情与移除都带 `storeId`（必填）与 `ownAsin`（选填）**：详情的查询参数是 `CompetitorDetailQuery`（`storeId`、`ownAsin`、`days` 7 到 180，默认 90），移除是 `CompetitorRemoveQuery`（`storeId`、`ownAsin`），不再是冻结表里的 `ScopeQuery` 与无参数；详情不带 `ownAsin` 时取第一个关注的我方 ASIN 对照。列表筛选 `reason`（`SEARCH_TERM`、`MANUAL`，**没有“竞争摘要”来源**：官方接口不返回别的商品），关键字 `q` 搜 ASIN、标题、品牌，排序 `addedAt`、`asin`、`price`、`rank`、`priceGap`、`rankGap`、`clickShare`、`observedAt`，游标分页。`POST /competitors` 请求体 `CompetitorAddBody`（`storeId`、`asin`、`ownAsin?`、`reason` 默认 `MANUAL`、`note?` 不超过 200 字）：竞品是我方商品、我方对应 ASIN 不在目录、单店超过 200 条、重复关注都返回 409；返回里写明要等下一次同步才有数据。`DELETE` 在该店铺该 ASIN 不再有任何关注时同时删除其快照。顺序统一为权限（403）→ 校验参数（422）→ 店铺在数据范围内（范围外与别的企业 404）→ 业务条件。写入审计动作 `COMPETITOR_WATCH_ADDED`、`COMPETITOR_WATCH_REMOVED`（同一事务）。**不抓取亚马逊前台页面；竞品评分没有官方来源，详情固定返回 `NO_OFFICIAL_SOURCE`。**

> **P4-13 实现说明（CR-088）**：评价与反馈，**读 2 条、写 2 条，四条都在冻结表里，没有新增路由**（都是静态路径）。顺序统一为权限（403）→ 校验参数（422）→ 店铺在成员数据范围内（范围外 403，别的企业的店铺 404 或空列表）→ 业务条件。**`GET /reviews`**（`reviews.read`，`ReviewsQuery`：全局范围参数加 `tab`（`ratings` 默认、`topics`、`returns`、`solicit`）、`storeId`、`asin`、`nodeId`、`ratingBelow`（1 到 5）、`q`，排序白名单 `REVIEW_SORTS`，游标分页，未知参数 422）：按页签返回四种响应，共同字段 `state`（`OK`/`NO_DATA`/`NOT_CONNECTED`/`RESTRICTED`）、`note`、`stores`、`basis`、`freshness`。① **评分概况**：每个店铺 × ASIN 最新一次导入的平均星级与评分数、与上一次采集的变化（只在两次都有该字段时才给，只有一次采集没有变化）、最近 12 个采集点的趋势、星级分布；**每个值都带来源（文件导入）、采集日期、文件名、导入人**，没导入过写“尚无记录”；列表最多 2000 行，超出 `truncated=true`。② **评论主题**：`storeId` + `asin` 选商品（不带取最近有主题的商品），前 10 正面与前 10 负面，提及量用接口给的区间原样显示（**不估算占比**）；类目对比取该商品所在浏览节点最近一个月的占比，分“类目全部商品”“类目前 25% 商品”两档，近 6 个月趋势。③ **退货主题**：`storeId` + `nodeId` 选类目，**只到类目级**（接口没有商品级退货主题）；另有**改进清单**（最多 30 条）：把商品的负面主题与近 90 天退货原因并排，“可能相关”只是英文词有重合，不是语义判断；没有 `returns.read` 时改进清单是 `RESTRICTED`。④ **请求评价**：第一页可请求订单、近 90 天请求覆盖率（已请求 ÷ 已送达，没有已送达是 `null` 不是 0）、请求后评分数增长（请求前后各要有一次评分导入，缺一次写原因）、最近 20 条请求记录，另带 **`switch: { enabled, permitted }`**（企业级写入开关 `sw.solicitation.send` 是否打开、当前成员是否有 `reviews.solicit`，页面据此禁用按钮并写原因；提交时仍按店铺再判断）。**`GET /reviews/solicitations/eligible`**（`reviews.read`，`EligibleQuery`：范围参数、`storeId`、`q`、`pageSize`、`sort=deliveredAt:asc|desc`，游标分页；冻结表写 `CursorQuery`）：送达后第 5 至 30 天（含）、整单所有包裹都已送达、没被取消、还没请求过（`FAILED` 的可以再次受理）的订单，只读订单号、下单日期、ASIN、送达时间，**不读买家信息**；最多扫描 5000 单，超出 `truncated=true`。**`POST /reviews/ratings-import`**（`data.import`，`RatingsImportBody`：`storeId`、`fileName`、`content`（浏览器读出的文本，最大 2MB）；冻结表写“文件”）：CSV 或制表符，列 ASIN、采集日期、平均星级、评分数、1 至 5 星（别名见契约 `parseRatingsFile`），最多 5000 行，**一行有错整份拒绝**：422，`fieldErrors.content` 是“第 N 行（列）：原因”列表，最多 50 条，其余给条数，一行都不写；成功返回 `imported`、`replaced`（同店铺同 ASIN 同采集日已有的被覆盖）、`batchId`；审计 `RATINGS_IMPORTED` 只记行数与文件名，不记文件内容。**`POST /reviews/solicitations`**（`reviews.solicit`，`SolicitationBatchBody`：`storeId`、1 到 50 个不重复订单号）：先过动作守卫（权限 → 该店铺亚马逊连接 `CONNECTION_UNAVAILABLE` 409 → 写入开关 `WRITE_SWITCH_OFF` 409，**服务端每次重新判断**），再逐单检查，返回 `accepted`、`skipped`（`NOT_FOUND`、`NOT_DELIVERED`、`OUT_OF_WINDOW`、`ALREADY_REQUESTED`）、`batchId`、`jobId`；通过的订单在同一事务里**插入 `QUEUED` 行（靠唯一键 `(店铺, 订单号)` 保证每单只请求一次，并发抢同一单的输家记 `ALREADY_REQUESTED`）**、建同步任务（任务编号即批次号）、写审计 `SOLICITATIONS_REQUESTED`，再入队，由 worker 的 `solicitation.send` 流程逐单发给亚马逊。**没有同步返回亚马逊的结果**，页面从“最近的请求”读状态。

> **P4-14 实现说明（CR-089）**：A+ 内容，**读 3 条、写 6 条，比冻结表多三条**（`GET /aplus/uploads` 图片库、`POST /aplus/uploads` 申请直传票据、`POST /aplus/uploads/confirm` 确认上传；图片走签名直传，必须先拿票据再确认，冻结表里只有一条 `POST /aplus/uploads`），静态路径都写在 `:id` 之前。写入检查顺序固定为权限（403）→ 校验参数（422）→ 店铺在成员数据范围内（范围外 403，别的企业与不存在的内容 404）→ 店铺连接（409，`step=CONNECTION`）→ 写入开关 `sw.aplus.submit`（409，`step=SWITCH`）→ 业务条件 → 事务（内容或乐观锁更新、`AplusWriteRun`、`SyncJob`、审计同一事务）→ 提交后入队。**POST 返回 201，`PATCH /aplus/:id` 返回 200**（项目里 PATCH 的默认），响应只代表“已登记”（`status=QUEUED`），亚马逊的结果由后台任务稍后写入“写入记录”；入队失败时写入记录标 `FAILED`（`QUEUE_UNAVAILABLE`），返回 `queued:false`。**同一内容同一时间只允许一个进行中的写入**（`409 CONFLICT`，`details.code=APLUS_RUN_BUSY`），`version` 与当前不一致同样 409（乐观锁，每次受理 +1）；动作不可用（审核中不能改、已批准与已发布的内容不能在这里编辑、没有关联 ASIN 不能提交、内容含编辑器不支持的模块不能保存）是 409 `DATA_CONDITION_FAILED` 并带原因；模块内容或图片不合格是 422。**图片必须来自本店铺已成功上传的图片库，宽高不小于所在模块的要求**；保存已有内容时文档里已有的图片沿用旧图，不再核对尺寸。创建失败（亚马逊那边还没有）的草稿再保存时重新发起创建。`GET /aplus/:id` 返回模块结构原样（`modules`）、`editable` 与 `editNote`（有模块不在支持范围或转换后与原结构不一致就只读）、关联 ASIN、审核时间线、拒绝原文与修复建议、发布前后对照 `compare`（取关联子 ASIN 发布日前后各 28 天的销售与流量，每侧会话不少于 100 才给结论，没有同步过销售与流量是 `NOT_CONNECTED`，没有分析权限是 `RESTRICTED`，发布后不足 7 天是 `TOO_RECENT`）、写入记录与各动作是否可用。写入审计动作 `APLUS_CREATED`、`APLUS_UPDATED`、`APLUS_ASINS_ASSOCIATED`、`APLUS_IMAGE_UPLOADED`、`APLUS_SUBMITTED`。**冻结的 `/products/:id/content` 的 `ContentCompareQuery`（两个日期的字段级对比）仍未实现**，A+ 内容的变更快照没有按日留存。
| POST | `/products/:id/price-simulation` | `pricing.read` | `PriceSimulationBody` | 目标价下的净利、是否达到预期获胜价、单品经济模拟（模型估算标注） | — | — | — | — | — |
| GET | `/listings/performance` | `listing.read` | `ListingPerfQuery` | 刊登表现上半部分趋势与异常、下半部分海量表（**P4-09 已实现，CR-084；表格是普通表格，三类异常与四列尚未接入，见实现说明**） | — | — | — | — | 游标 |
| GET | `/listings/quality` | `listing.read` | `ListingQualityQuery`（7 个页签） | 问题清单、生命周期统计、影响估算（**P4-10 已实现，CR-085**；路由与请求体与冻结不同，见 P4-10 实现说明） | — | — | — | — | 游标 |
| POST | `/listings/:sku/validate` | `listing.write` | `ListingPatchBody` | 刊登接口校验预览结果（**P4-10 已实现，CR-085**；路由与请求体与冻结不同，见 P4-10 实现说明） | — | 校验 | 是 | — | — |
| PATCH | `/listings/:sku` | `listing.write` | `ListingPatchBody` + `previewToken`（必须来自上一步校验） | 修改结果（异步），操作状态（**P4-10 已实现，CR-085**；路由与请求体与冻结不同，见 P4-10 实现说明） | `sw.listing.update` | 校验 | 是 | — | — |
| POST | `/listings/batch-jobs` | `listing.write` | `ListingBatchBody` | 批量刊登任务（批量接口），返回任务编号（补）（**P4-10 已实现，CR-085**；路由与请求体与冻结不同，见 P4-10 实现说明） | `sw.feeds.batch` | 校验 | 是 | — | — |
| GET | `/listings/batch-jobs/:id` | `listing.read` | — | 批量任务状态与结果回写（补）（**P4-10 已实现，CR-085**；路由与请求体与冻结不同，见 P4-10 实现说明） | — | — | — | — | — |
| GET | `/pricing` | `pricing.read` | `PricingListQuery` | 价格、推荐报价、预期获胜价、差距、获得率、价格健康、两种价格下的利润率*（**P4-11 已实现，CR-086**；本组路由与冻结的差异见 P4-11 实现说明） | — | — | — | — | 游标 |
| GET | `/pricing/:sku` | `pricing.read` | `ScopeQuery` | 价格历史、竞争报价快照、事件、调价历史 | — | — | — | — | — |
| POST | `/pricing/:sku/simulation` | `pricing.read` | `PriceSimulationBody` | 调价模拟器：单品经济模拟利润、价格弹性估算（补；与 `/products/:id/price-simulation` 同一计算） | — | — | — | — | — |
| PATCH | `/pricing/:sku` | `pricing.price.write` | `PriceUpdateBody` + `previewToken` | 改价；超出价格护栏拦截 | `sw.pricing.update` | 校验 | 是 | — | — |
| GET | `/pricing/guardrails` | `pricing.read` | `CursorQuery` | 价格护栏列表 | — | — | — | — | 游标 |
| PUT | `/pricing/guardrails` | `pricing.rule.write` | `GuardrailUpsertBody` + `VersionBody` | 设置最低价、最高价 | — | — | 是 | — | — |
| GET | `/pricing/rules` | `pricing.read` | `PageQuery` | 定价规则列表 | — | — | — | — | 页码 |
| POST | `/pricing/rules` | `pricing.rule.write` | `PricingRuleCreateBody`（模式：手动或自动；条件；调幅上限；每日次数上限；熔断阈值） | 新规则；自动模式只有开关 `sw.pricing.rule.auto` 开启后才会执行 | `sw.pricing.rule.auto`（仅自动执行时） | — | 是 | — | — |
| PATCH | `/pricing/rules/:id` | `pricing.rule.write` | `PricingRuleUpdateBody` + `VersionBody` | 修改（补） | — | — | 是 | — | — |
| POST | `/pricing/rules/:id/dry-run` | `pricing.rule.write` | `DryRunBody` | 试运行：用历史数据模拟命中情况（补） | — | — | 是 | — | — |
| GET | `/pricing/rules/:id/runs` | `pricing.read` | `CursorQuery` | 执行记录与前后对照（补） | — | — | — | — | 游标 |
| GET | `/competitors` | `competitors.read` | `CompetitorListQuery` | 竞品列表关注列表（**P4-12 已实现，CR-087**；差异见 P4-12 实现说明） | — | — | — | — | 游标 |
| POST | `/competitors` | `competitors.write` | `CompetitorAddBody` | 手工添加或从搜索词、竞争摘要加入（**P4-12 已实现，CR-087**；来源只有搜索词与手工添加） | — | — | 是 | — | — |
| GET | `/competitors/:asin` | `competitors.read` | `ScopeQuery` | 价格与排名趋势、属性变化快照、份额趋势、并排对比（补）（**P4-12 已实现，CR-087**；改为 `CompetitorDetailQuery`，必带 `storeId`） | — | — | — | — | — |
| DELETE | `/competitors/:asin` | `competitors.write` | — | 移除关注（补）（**P4-12 已实现，CR-087**；必带 `storeId`） | — | — | 是 | — | — |
| GET | `/reviews` | `reviews.read` | `ReviewsQuery`（页签：评分概况、评论主题、退货主题、请求评价） | 评分与评分数（标注来源）、主题与占比、类目对比、趋势（**P4-13 已实现，CR-088**；响应按页签区分，请求评价页签另带 `switch`） | — | — | — | — | 游标 |
| POST | `/reviews/ratings-import` | `data.import` | `RatingsImportBody`（文件） | 评分与评分数导入，标注来源、采集日期、导入人（补）（**P4-13 已实现，CR-088**；请求体是文件文本，一行有错整份拒绝） | — | — | 是 | — | — |
| GET | `/reviews/solicitations/eligible` | `reviews.read` | `CursorQuery` | 可请求订单（送达后第 5 至 30 天、尚未请求）（补）（**P4-13 已实现，CR-088**；`EligibleQuery`） | — | — | — | — | 游标 |
| POST | `/reviews/solicitations` | `reviews.solicit` | `SolicitationBatchBody` | 批量请求，每单只请求一次（**P4-13 已实现，CR-088**） | `sw.solicitation.send` | — | 是 | — | — |
| GET | `/aplus` | `aplus.read` | `AplusListQuery` | A+ 内容列表 | — | — | — | — | 游标 |
| POST | `/aplus` | `aplus.write` | `AplusCreateBody`（结构化模块） | 创建内容草稿 | `sw.aplus.submit` | — | 是 | — | — |
| GET | `/aplus/:id` | `aplus.read` | — | 内容详情、审核状态时间线、拒绝原因 | — | — | — | — | — |
| PATCH | `/aplus/:id` | `aplus.write` | `AplusUpdateBody` + `VersionBody` | 编辑 | `sw.aplus.submit` | — | 是 | — | — |
| POST | `/aplus/:id/asins` | `aplus.write` | `AplusAsinBody` | 关联 ASIN（补） | `sw.aplus.submit` | — | 是 | — | — |
| POST | `/aplus/uploads` | `aplus.write` | `AplusUploadTicketBody`（类型与大小校验） | 申请图片直传票据（**P4-14 已实现，CR-089**，登记上传任务在 confirm） | `sw.aplus.submit` | — | 是 | — | — |
| POST | `/aplus/:id/submit` | `aplus.write` | — | 提交审核 | `sw.aplus.submit` | — | 是 | — | — |
| GET | `/aplus/uploads` | `aplus.read` | `AplusUploadsQuery` | 图片库（**P4-14 新增，CR-089**） | — | — | — | — | — |
| POST | `/aplus/uploads/confirm` | `aplus.write` | `AplusUploadConfirmBody` | 确认图片上传并登记上传任务（**P4-14 新增，CR-089**；`POST /aplus/uploads` 改为申请直传票据） | `sw.aplus.submit` | — | 是 | — | — |
| GET | `/costs` | `costs.read`（+ `field.cost`） | `CostListQuery` | 成本列表：当前版本、单位头程分摊、关税、到岸成本、覆盖状态 | — | — | — | — | 游标 |
| GET | `/costs/:sku` | `costs.read`（+ `field.cost`） | — | 版本时间线、版本来源、构成、计价结果（补） | — | — | — | — | — |
| POST | `/costs` | `costs.write` | `CostVersionCreateBody` + `VersionBody` | 新成本版本（已关账期间不受影响） | — | — | 是 | — | — |
| POST | `/costs/import` | `costs.write` | `CostImportBody`（文件） | 成本导入（补） | — | — | 是 | — | — |
| POST | `/costs/activate` | `costs.write` | `CostActivateBody` | 批量确认草稿生效，全部成功或全部不生效（P2b-14 补） | — | — | 是 | — | — |
| PATCH | `/costs/versions/:id` | `costs.write` | `CostVersionUpdateBody` | 修改草稿（P2b-14 补） | — | — | 是 | — | — |
| DELETE | `/costs/versions/:id?version=` | `costs.write` | — | 丢弃草稿（P2b-14 补） | — | — | 是 | — | — |
| GET | `/costs/:sku/compare?a=&b=` | `costs.read`（+ `field.cost`） | `CostCompareQuery` | 两个版本逐项对比（P2b-14 补） | — | — | — | — | — |

> **P2a-14 实现说明（CR-037）**：本包只实现 ASIN 360 的 5 条路由：`GET /products/:id`（身份区）、`/overview`、`/inventory`、`/actions`、`/changes`；其余页签路由（流量、广告、利润、退货、刊登、评价、定价、竞品、内容）与 `/products` 列表、`PATCH /products/meta`、`POST …/price-simulation` 未实现，页面也不显示那些页签。`:id` 是商品（`FbaProduct`）编号，限美国站，先校验 `products.read` 再查商品，不在成员数据范围内的商品返回 404。身份区响应：`product`（图片、ASIN、SKU、FNSKU、品牌、类目、父 ASIN、状态、目录同步状态 `catalogState`）、同店铺同 ASIN 的其他 SKU（`siblings`）、变体、`ranks`（最近一次销售排名快照）、`stock`（可售等，没有 `inventory.read` 为 `RESTRICTED`，没有库存记录为 `NO_DATA`）、`freshness`（订单、库存、商品目录三个来源）、`owner`、`tagIds`。`/overview` 接受 `ScopeSearchSchema` 的日期与对比参数，返回 KPI 卡、销售趋势（含对比线与事件）、对比表、指标树归因、渠道拆分、利润与退款；**销售、销量、排名按店铺 × ASIN 汇总**，同一 ASIN 下的多个 SKU 看到的是同一份数据；利润需 `field.profit`，没有权限时字段不出现；利润、会话、广告类指标固定为 `NOT_CONNECTED`（页面写“尚未接入”，不是 0）。`/inventory` 返回库存详情的引用（需 `inventory.read`）；`/actions` 目前只有库存规则产生的建议（没有 `inventory.read` 为 `RESTRICTED`），其余动作来源由 P4-08 接入。`/changes` **不是游标分页**：合并 `EntityEvent` 与 `OperationLog` 各取最近 200 条，任一来源超过 200 条时 `truncated=true`。库存详情 `GET /inventory/:id` 响应多 `productId`（按店铺与 SKU 找到商品，找不到为 `null`），用于“商品全景”入口。

## 八、库存与补货

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/inventory` | `inventory.read` | `InventoryListQuery`（页签 7 个、风险、搜索、排序） | 库存健康表（商品、数量、销售与覆盖、风险、库龄与费用、建议）；P2a-06 已实现（CR-029）：风险等级由库存规则当前版本与近期销量算出，没有规则时 `policyState=NOT_CONNECTED` 且不给等级；范围内 SKU 上限 5000（超出 `truncated=true`） | — | — | — | — | 页码 |
| GET | `/inventory/summary` | `inventory.read` | `ScopeQuery` | 8 张指标卡（每张带状态与原因）与 4 张图（结构、库龄、可售天数分布、仓储费趋势）；P2a-06（CR-029） | — | — | — | — | — |
| GET | `/inventory/rules` | `inventory.read` | — | 库存规则（企业级）当前生效版本与版本历史；没有版本时 `state=NOT_CONNECTED`；P2a-06（CR-029） | — | — | — | — | — |
| PUT | `/inventory/rules` | `replenishment.policy.write` | `InventoryPolicyWriteSchema`（含 `expectedVersionNo` 与 `changeReason`） | 追加新版本（旧版本不改写）；版本号冲突返回 409；P2a-06（CR-029）。P2a-07 的 `/replenishment/policies` 在此基础上扩展品类与 SKU 级 | — | — | 是 | — | — |
| GET | `/inventory/ledger` | `inventory.read` | `view=summary` 用 `LedgerSummaryQuerySchema`（`unbalanced`、`q`、`from`、`to`、页码）；`view=detail` 用 `LedgerDetailQuerySchema`（`group` 事件分组、`q`、游标） | 台账汇总（店铺 × FNSKU × 月，“期初 + 变动 = 期末”平衡校验，`difference`、`balanced`、`unbalancedCount`；最近一个月的行带库存接口比对 `live`）或明细（事件分组 `group`、调整细分 `adjustmentLabel`、`referenceKind`）；P2a-09（CR-032）。汇总最多读 20000 行，超出 `truncated=true`；没有记录 `state=NO_DATA` | — | — | — | — | 汇总页码、明细游标 |
| GET | `/inventory/removals` | `inventory.read` | `RemovalListQuery`（`type`、`status`、`q`、页码） | 移除订单列表：按订单汇总数量与费用（无费用为 null）、承运商与运单号、收货核对状态 `receiptState`；附 `guide`（移除订单只能在卖家后台创建）；P2a-09（CR-032） | — | — | — | — | 页码 |
| GET | `/inventory/removals/recommended` | `inventory.read` | `RecommendedRemovalQuerySchema`（页码） | 亚马逊推荐移除清单（R-17，每个店铺取最近一次有该列的快照日期，数量大于 0）；`estimatedSavings` 暂为 null（尚未接入）；P2a-09（CR-032） | — | — | — | — | 页码 |
| GET | `/inventory/removals/:id` | `inventory.read` | — | 移除订单详情，`:id` 为 `<店铺编号>:<移除订单号>`（URL 编码）：明细行、货件、时间线、逐 SKU 收货核对、已登记收货、`canReceive`；`returnAddress` 恒为 `NOT_CONNECTED`（官方报告没有地址）；店铺不在范围内或订单不存在一律 404；P2a-09（CR-032） | — | — | — | — | — |
| POST | `/inventory/removals/:id/receipt` | `inventory.removal.receive` | `RemovalReceiptBody`（`sku`、`receivedQty`、`sellableQty`、`damagedQty`、`receivedAt?`、`note?`） | 登记退回件实收：只有 RETURN 订单且 SKU 在订单内已发货；收货日期不得晚于今天；同一天同一 SKU 再登记视为更正（审计 `REMOVAL_RECEIPT_RECORDED` / `REMOVAL_RECEIPT_CORRECTED`，含前后值）；应收取订单已发货数量，不另存；P2a-09（CR-032） | — | — | 是 | — | — |
| GET | `/inventory/capacity` | `inventory.read` | `ScopeQuery` | 利用率（月度报告的比率，与限额文件分开显示）、近 6 个月费用（无记录为 null）、下月预测（规划报告预估、库龄附加费预估、30 天内跨档提醒）、清理建议、`notConnected`（实际库龄附加费与低库存水平费，P2b-05 交付）；P2a-09（CR-032） | — | — | — | — | — |
| POST | `/inventory/capacity/limits-import` | `data.import` | `StorageLimitImportBody`（`sellerAccountId`、`fileName`、`content` 为 CSV 文本，≤100 KB、≤200 行） | 限额文件导入，逐行标注来源文件、采集日期、导入人；一行有错整份拒绝（错误挂在 `fieldErrors.content`，至多 10 条）；与月度报告同一天同一类型的记录不覆盖；同日再导入覆盖上次导入；审计 `STORAGE_LIMITS_IMPORTED`；P2a-09（CR-032）。**与原设计不同：** 用 JSON 携带 CSV 文本，不用 multipart | — | — | 是 | — | — |
| GET | `/inventory/:id` | `inventory.read` | — | 库存详情身份区、规则建议与新鲜度；P2a-06 已实现（CR-029），以下 9 个页签接口同；**必须注册在所有 `/inventory/<静态路径>` 之后** | — | — | — | — | — |
| GET | `/inventory/:id/structure` | `inventory.read` | — | 库存结构趋势 | — | — | — | — | — |
| GET | `/inventory/:id/snapshots` | `inventory.read` | `SnapshotCompareQuery`（`a`、`b` 两个日期，均可省略） | 历史快照对比；两个日期都省略时只返回可选日期列表 | — | — | — | — | — |
| GET | `/inventory/:id/ledger` | `inventory.read` | `CursorQuery` | 该 SKU 台账流水（按 FNSKU，日期倒序）；每行带 `referenceKind`，对应页面上线后前端才渲染为链接 | — | — | — | — | 游标 |
| GET | `/inventory/:id/inbound` | `inventory.read` | — | 入仓与在途 | — | — | — | — | — |
| GET | `/inventory/:id/awd` | `inventory.read`、`awd.read` | — | 上游仓储页签：这个 SKU 的最近一次库存快照与未完结的入库货件（`AwdTabResponse`；店铺没有开通为 `NOT_APPLICABLE`，没有快照 `stock` 为 null，不显示 0；P2a-08 改为真实数据，CR-031） | — | — | — | — | — |
| GET | `/inventory/:id/replenishment` | `inventory.read`、`replenishment.read` | — | 我方建议（`ours: ReplenishCalc`，含 8 步计算链）与官方建议并列及差异原因；**P2a-07（CR-030）起由补货模块提供，`ours` 形状已变（不再有 `qty`、`formula`、`inputs`）** | — | — | — | — | — |
| GET | `/inventory/:id/age-fees` | `inventory.read` | — | 库龄分段与跨档时间线 | — | — | — | — | — |
| GET | `/inventory/:id/disposition` | `inventory.read` | — | 处置建议：官方与我方并列、预计节省 | — | — | — | — | — |
| GET | `/inventory/:id/forecast` | `inventory.read` | — | 日销预测（含区间与剔除说明） | — | — | — | — | — |
| GET | `/replenishment/policies` | `replenishment.read` | `PolicyListQuery`（企业、品类、SKU 三级） | 策略与全部版本（版本号倒序）、企业级当前版本 `tenantCurrent`、可选品类 `categories`；P2a-07 已实现（CR-030） | — | — | — | — | 页码 |
| PUT | `/replenishment/policies` | `replenishment.policy.write` | `PolicyUpsertBody`（含 `expectedVersionNo`、`changeReason`） | 追加新版本（旧版本不改写）；版本号冲突 409；**不自动重算**，需再点“重新计算”（CR-030） | — | — | 是 | — | — |
| POST | `/replenishment/recompute` | `replenishment.plan.create` | `RecomputeBody` | 同步计算并返回新批次（`batch`、`snapshot`）；一次计算 = 一个批次，冻结当时输入 | — | — | 是 | — | — |
| GET | `/replenishment/recommendations` | `replenishment.read` | `RecommendationQuery` | 指定批次（省略则最新）的建议列表，含 8 步公式、官方建议量与差异原因、资金占用（`NOT_CONNECTED`） | — | — | — | — | 页码 |
| GET | `/replenishment/batches` | `replenishment.read` | `BatchListQuery` | 批次列表（新增，CR-030） | — | — | — | — | 页码 |
| POST | `/replenishment/batches/:id/decisions` | `replenishment.plan.create` | `DecisionBody` | 批量采纳 / 调整数量 / 忽略（忽略必须写原因）（新增，CR-030） | — | — | 是 | — | — |
| POST | `/replenishment/batches/:id/evaluate` | `replenishment.plan.create` | — | 按需评估预测误差：到仓满 7 天且数据覆盖 ≥ 80% 才评估，不满足的跳过并说明（新增，CR-030） | — | — | 是 | — | — |
| POST | `/replenishment/simulate` | `replenishment.read`（上游仓储情景另需 `replenishment.plan.create`，服务内校验） | `SimulateBody`（`kind: TREND / AWD`） | `TREND`：同步返回 90 天库存走势（不补货、按建议、自定义）与断货区间；`AWD`：向 Data Kiosk 提交 `economicsSimulation`，返回 `runId`（状态 PENDING） | — | — | 是 | — | — |
| GET | `/replenishment/simulations/:id` | `replenishment.read` | — | 上游仓储模拟进度与结果（新增，CR-030）；只暴露合计（币种、销售额、费用、净收入、行数） | — | — | — | — | — |
| POST | `/replenishment/to-purchase-draft` | `replenishment.plan.create`、`purchase.order.write` | `ToDraftBody` | 按供应商生成采购单草稿（仅我方数据）；采购单已存在才生成，否则按请求如实返回 | — | — | 是 | — | — |
| ~~POST~~ | ~~`/replenishment/to-inbound-draft`~~ | — | — | **P6-08 已移除（CR-116）**：由批次级 `POST /replenishment/batches/:id/to-inbound-drafts` 取代（见第十六节）；以前登记的意图用 `GET /replenishment/intents` 查、用新接口补建 | — | — | — | — | — |
| POST | `/replenishment/to-awd-draft` | `replenishment.plan.create`、`awd.order.write` | `ToDraftBody` | **生成真实的本地草稿**（P2a-08 起，CR-031）：按店铺分单，创建 `LOCAL_DRAFT` 的 `AwdInboundOrder`（参考号 `NOVA-<12 位>`，`draftJson` 记来源建议），不调用亚马逊；包装与发货地址须在上游仓储页补全后才能提交；已生成过的建议再生成返回 409 | — | — | 是 | — | — |
| GET | `/replenishment/batches/:id` | `replenishment.read` | 页码 | 批次详情：冻结输入快照、执行情况（决策计数、采购单草稿、待生成登记）、结果回看、建议明细（分页） | — | — | — | — | 页码 |
| GET | `/awd/inventory` | `awd.read` | 页码、`q` | 上游仓储库存（每店铺取最近一次快照；`totals` 合计里缺的数字为 null；店铺未开通 `NOT_APPLICABLE`） | — | — | — | — | 页码 |
| GET | `/awd/orders` | `awd.read` | 页码、`status`、`q` | 入库订单列表（含 `write`：服务端按“权限 → 连接 → 开关”判断的结果，页面据此禁用并写明原因）。**亚马逊没有“列出入库订单”接口**：列表是我方创建的订单加货件所属订单，在亚马逊后台直接创建且还没有货件的订单不会出现 | — | — | — | — | 页码 |
| POST | `/awd/orders` | `awd.order.write` | `AwdOrderCreateBody`（`submit` 默认 false） | 创建入库订单：默认只存本地草稿（`LOCAL_DRAFT`，只要权限）；`submit: true` 时依次要求店铺连接与开关 `sw.awd.order.write`，订单与 `SyncJob` 同一事务写入，提交后返回 `QUEUED`，由后台任务调用亚马逊 | `sw.awd.order.write`（仅 `submit`） | 校验（提交前每个包装需长宽高） | 是 | — | — |
| GET | `/awd/orders/:id` | `awd.read` | — | 订单详情：地址、包装、货件（含 SKU 明细）、时间线、`actions`（服务端按状态算出的可用动作）、`draft`（补货建议来源） | — | — | — | — | — |
| PATCH | `/awd/orders/:id` | `awd.order.write` | `AwdOrderUpdateBody`（含 `version`、`submit`、`transport`） | 更新订单（本地草稿只改本地；亚马逊草稿整单覆盖并交后台任务）、提交本地草稿、更新运输信息（已确认且有货件）；版本不符 409；有后台操作在途 409 | `sw.awd.order.write`（涉及亚马逊时） | 校验 | 是 | — | — |
| POST | `/awd/orders/:id/confirm` | `awd.order.write` | `{ version }` | 确认入库订单（亚马逊 204，后台任务完成；确认后包装不可再改） | `sw.awd.order.write` | — | 是 | — | — |
| POST | `/awd/orders/:id/cancel` | `awd.order.write` | `{ version, reason }` | 取消入库订单；本地草稿只取消本地，不调用亚马逊、不需开关 | `sw.awd.order.write`（非本地草稿） | — | 是 | — | — |
| GET | `/awd/shipments` | `awd.read` | 页码、`status`、`q` | 入库货件（含订单行编号、标签状态、预计与已接收件数） | — | — | — | — | 页码 |
| GET | `/awd/shipments/:id/labels` | `awd.read` | — | 标签状态；已生成并存入文件存储时返回 5 分钟有效的签名下载链接 | — | — | — | — | — |
| POST | `/awd/shipments/:id/labels` | `awd.read`（只读请求，不受写入开关限制） | — | 发起获取标签（亚马逊异步生成，作业类型 `AWD_LABELS`，返回 `QUEUED`；货件已取消 409）（新增，CR-031） | — | — | 是 | — | — |

> **P2a-08 实现说明（CR-031）**：`/awd/*` 共 10 条（上表 9 条 + `POST /awd/shipments/:id/labels`），冻结时的游标分页改为页码分页；调用亚马逊的写接口按“权限 → 店铺连接 → 开关 → 事务内更新订单（`updateWithVersion`）与创建 `SyncJob` → 提交后入队”处理，worker 执行前再查一次开关。写接口返回 `{ order, state: SAVED | QUEUED, jobId }`，订单状态在后台任务完成前是“预期状态”，下一次同步（2 小时）按亚马逊的真实状态校正。`/replenishment/batches/:id` 的 `execution` 新增 `awdOrders`（本批生成的上游仓储本地草稿）。

## 九、采购、国内仓、头程、入仓

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/suppliers` | `supplier.read` | `SupplierListQuery` | 供应商列表与表现指标 | — | — | — | — | 页码 |
| POST | `/suppliers` | `supplier.write` | `SupplierCreateBody` | 新增 | — | — | 是 | — | — |
| GET | `/suppliers/:id` | `supplier.read` | — | 详情：资料、报价历史、采购历史、交付趋势、质检、附件 | — | — | — | — | — |
| PATCH | `/suppliers/:id` | `supplier.write` | `SupplierUpdateBody` + `VersionBody` | 修改 | — | — | 是 | — | — |
| DELETE | `/suppliers/:id` | `supplier.write` | — | 停用（软删除，保留历史） | — | — | 是 | — | — |
| GET | `/purchase-orders` | `purchase.read` | `PurchaseOrderListQuery` | 采购单列表（金额字段需 `field.cost`） | — | — | — | — | 页码 |
| POST | `/purchase-orders` | `purchase.order.write` | `PurchaseOrderCreateBody` | 创建采购单（草稿） | — | — | 是 | — | — |
| GET | `/purchase-orders/:id` | `purchase.read` | — | 详情与 9 个页签数据（补） | — | — | — | — | — |
| PATCH | `/purchase-orders/:id` | `purchase.order.write` | `PurchaseOrderUpdateBody` + `VersionBody` | 编辑（补） | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/submit` | `purchase.order.write` | — | 提交审批 | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/approve` | `purchase.order.approve` | `ApprovalBody`（通过或驳回、意见） | 审批；创建人不能审批自己的单 | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/receipts` | `purchase.receive` | `ReceiptBody` | 分批收货；完成后生成成本版本草稿 | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/inspections` | `purchase.receive` | `InspectionBody` | 质检登记 | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/payments` | `purchase.pay` | `PaymentBody` | 付款登记 | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/status` | `purchase.order.write` | `PoStatusBody` + `VersionBody` | 开始生产、关闭、取消、退货给供应商（状态机在 `purchaseOrderActions`，取消与退货必填原因）（补） | — | — | 是 | — | — |
| POST | `/purchase-orders/:id/attachments` | `purchase.order.write` | 签名直传凭据申请 | 附件（类型与大小校验）；返回上传凭据 | — | — | — | — | — |
| POST | `/purchase-orders/:id/attachments/confirm` | `purchase.order.write` | `AttachmentConfirmBody` | 上传完成后确认入库（按内容哈希去重）（补） | — | — | 是 | — | — |
| GET | `/purchase-orders/:id/attachments/:attachmentId/download` | `purchase.read` | — | 返回限时下载链接（补） | — | — | — | — | — |
| POST | `/suppliers/:id/attachments`、`/attachments/confirm`；GET `/suppliers/:id/attachments/:attachmentId/download` | `supplier.write` / `supplier.read` | 同上 | 供应商附件（补） | — | — | 是 | — | — |
| GET | `/domestic-warehouse/stock` | `warehouse.read` | `WarehouseStockQuery` | 国内仓库存（货值需 `field.cost`） | — | — | — | — | 页码 |
| GET | `/domestic-warehouse/movements` | `warehouse.read` | `WarehouseMovementQuery` | 流水（补） | — | — | — | — | 页码 |
| GET | `/stock-counts` | `warehouse.read` | `StockCountListQuery` | 盘点单列表（补） | — | — | — | — | 页码 |
| POST | `/stock-counts` | `warehouse.stockcount.write` | `StockCountBody` | 创建盘点单、录入结果 | — | — | 是 | — | — |
| POST | `/stock-counts/:id/approve` | `warehouse.stockcount.approve` | `ApprovalBody` | 审批差异后才调整库存；录入人不能审批（补） | — | — | 是 | — | — |
| GET | `/first-mile` | `firstmile.read` | `FirstMileListQuery` | 头程运单列表（含货代与国内仓选项；预估与实际费用需 `field.cost`） | — | — | — | — | 页码 |
| POST | `/first-mile` | `firstmile.write` | `FirstMileCreateBody` | 新增运单（含明细） | — | — | 是 | — | — |
| GET | `/first-mile/:id` | `firstmile.read` | — | 详情：节点、费用、分摊、附件、关联入仓货件与明细、可用动作、同类实际时效（补） | — | — | — | — | — |
| PATCH | `/first-mile/:id` | `firstmile.write` | `FirstMileUpdateBody` + `VersionBody` | 修改运单；传 `items` 整体替换明细（分摊或出库后不允许）（补） | — | — | 是 | — | — |
| POST | `/first-mile/:id/outbound` | `firstmile.write` | `FirstMileOutboundBody` + `VersionBody` | 国内仓出库：按明细记 `FIRST_MILE_OUT` 负流水，库存不足整张拒绝（补） | — | — | 是 | — | — |
| POST | `/first-mile/:id/milestones` | `firstmile.write` | `MilestoneBody` + `VersionBody` | 录入节点 | — | — | 是 | — | — |
| POST | `/first-mile/:id/milestones/import` | `firstmile.write` | `{ version, fileName, content }` | 货代文件导入节点；一行有错整份拒绝，重复行跳过（补） | — | — | 是 | — | — |
| DELETE | `/first-mile/:id/milestones/:milestoneId?version=` | `firstmile.write` | — | 删除手工录入的节点（文件导入的不可删）（补） | — | — | 是 | — | — |
| POST | `/first-mile/:id/costs` | `firstmile.write` | `FirstMileCostBody` + `VersionBody` | 录入费用（币种同运单，金额大于 0；分摊后锁定） | — | — | 是 | — | — |
| DELETE | `/first-mile/:id/costs/:costId?version=` | `firstmile.write` | — | 删除费用（分摊后不可）（补） | — | — | 是 | — | — |
| POST | `/first-mile/:id/allocate` | `firstmile.write` | `AllocateBody`（体积、重量、货值或件数）+ `VersionBody` | 费用分摊到 SKU，同时为每个 SKU 生成 `CostVersion` 草稿（`FIRST_MILE_ALLOCATION`） | — | — | 是 | — | — |
| DELETE | `/first-mile/:id/allocation?version=` | `firstmile.write` | — | 撤销分摊，删除对应成本版本草稿（有已生效的拒绝）（补） | — | — | 是 | — | — |
| POST | `/first-mile/:id/attachments`、`/attachments/confirm`；GET `/first-mile/:id/attachments/:attachmentId/download` | `firstmile.write` / `firstmile.read` | 同采购单附件 | 提单、发票、报关单等附件（补） | — | — | 是 | — | — |
| GET | `/first-mile/transit-stats` | `firstmile.read` | — | 按货代与运输方式的实际时效分布（p50、p90、月度点、补货策略现用值、能否回写） | — | — | — | — | — |
| POST | `/first-mile/transit-stats/apply` | `replenishment.policy.write` | `TransitApplyBody`（货代、运输方式、期望的策略版本号） | 人工确认后把 p90 回写企业级补货策略的该运输方式时效，保存为新策略版本（补） | — | — | 是 | — | — |
| GET / POST / PATCH | `/freight-forwarders`、`/freight-forwarders/:id` | `firstmile.read` / `firstmile.write` | `ForwarderListQuery`、`ForwarderCreateBody`、`ForwarderUpdateBody` + `VersionBody` | 货代资料（名称唯一；停用后不能新建运单）（补） | — | — | 是 | — | 页码 |
| GET | `/inbound/plans` | `inbound.read` | `InboundPlanListQuery` | 计划列表、状态看板、异常队列 | — | — | — | — | 游标 |
| POST | `/inbound/plans` | `inbound.plan.write` | `InboundPlanCreateBody` | 创建计划（我方草稿，提交到亚马逊时创建入仓计划） | `sw.inbound.plan.create` | 校验（资格预检） | 是 | — | — |
| GET | `/inbound/plans/:id` | `inbound.read` | — | 计划概览：步骤条、截止时间（分仓方案过期、作废窗口）（补） | — | — | — | — | — |
| POST | `/inbound/plans/:id/eligibility` | `inbound.plan.write` | `EligibilityBody` | 入仓资格预检结果 | — | — | 是 | — | — |
| POST | `/inbound/plans/:id/packing-options` | `inbound.plan.write` | `PackingOptionBody`（`action`：生成或确认） | 装箱方案；确认时受开关控制 | `sw.inbound.packing.confirm`（确认） | — | 是 | — | — |
| POST | `/inbound/plans/:id/packing-info` | `inbound.plan.write` | `PackingInfoBody` | 提交箱内物品信息 | `sw.inbound.packinginfo.submit` | 校验 | 是 | — | — |
| POST | `/inbound/plans/:id/placement-options` | `inbound.plan.write` | `PlacementOptionBody`（`action`：生成或确认） | 分仓方案，含总成本比较；确认时受开关控制 | `sw.inbound.placement.confirm`（确认） | — | 是 | — | — |
| POST | `/inbound/plans/:id/transport-options` | `inbound.plan.write` | `TransportOptionBody`（`action`：生成或确认） | 运输方案；确认时受开关控制 | `sw.inbound.transport.confirm`（确认） | — | 是 | — | — |
| POST | `/inbound/plans/:id/delivery-windows` | `inbound.plan.write` | `DeliveryWindowBody` | 送达时间窗生成与确认 | `sw.inbound.transport.confirm`（确认） | — | 是 | — | — |
| POST | `/inbound/plans/:id/confirm` | `inbound.plan.write` | `ShipConfirmBody` | 标记已发货（我方状态流转，需标签已打印；不调用亚马逊） | — | — | 是 | — | — |
| POST | `/inbound/plans/:id/cancel` | `inbound.plan.write` | `ReasonBody` | 取消计划，提示作废窗口（小包裹 24 小时、零担与整车 1 小时） | `sw.inbound.plan.create` | — | 是 | — | — |
| GET | `/inbound/plans/:id/operations` | `inbound.read` | — | 异步操作时间线与状态 | — | — | — | — | — |
| GET | `/inbound/plans/:id/boxes` | `inbound.read` | — | 箱内物品 | — | — | — | — | — |
| GET | `/inbound/plans/:id/labels` | `inbound.read` | — | 标签（签名链接） | — | — | — | — | — |
| POST | `/inbound/plans/:id/labels/print-jobs` | `inbound.plan.write` | `LabelPrintBody` | 批量打印任务（补） | — | — | 是 | — | — |
| GET | `/inbound/shipments` | `inbound.read` | `ShipmentListQuery` | 货件接收与差异列表 | — | — | — | — | 游标 |
| GET | `/inbound/shipments/:id` | `inbound.read` | — | 货件详情（补） | — | — | — | — | — |
| GET | `/inbound/shipments/:id/discrepancies` | `inbound.read` | — | SKU 差异表、不合规问题、赔付任务 | — | — | — | — | — |
| GET | `/inbound/shipments/:id/timeline` | `inbound.read` | — | 接收时间线 | — | — | — | — | — |
| PATCH | `/inbound/shipments/:id/tracking` | `inbound.plan.write` | `TrackingUpdateBody` | 回填承运商与追踪号（补） | `sw.inbound.transport.confirm` | — | 是 | — | — |

> **P2a-10 实现说明（CR-033）**：采购、供应商、国内仓共 26 条路由。冻结时的游标分页改为页码分页（列表需要总数）；收货、质检、付款的路径用复数名词（`receipts`、`inspections`、`payments`）；国内仓库存路径为 `/domestic-warehouse/stock`。金额、单价、货值、已付金额只在有 `field.cost` 时返回（没有权限时字段**不出现**，不是 null，前端写“无权查看”）。所有写接口带乐观锁版本号（冲突 409），状态变更的响应统一为 `{ id, status, statusLabel, version, documentNo? }`。审批人不能是创建人或提交人（403），盘点同理（录入人不能审批）。收货全部完成时在同一事务里为每个 SKU 生成一条 `CostVersion` 草稿（`PURCHASE_RECEIPT`，单价为已收数量加权平均），生效与替换留给 P2b-14。

> **P2a-11 实现说明（CR-034）**：头程物流与货代共 20 条路由（上表 `/first-mile*` 与 `/freight-forwarders*`）。分页为页码；所有写接口带乐观锁版本号（冲突 409），对运单的子记录（节点、费用、分摊）写入都会让运单版本加 1，页面据此刷新。预估费用、实际费用、明细货值、费用明细、分摊结果与 `allocationReady` 只在有 `field.cost` 时返回（没有权限时**不出现**）；实际费用是费用明细的合计（没有费用记录为 null，不是 0）。`transit-stats/apply` 不新建策略表，而是调用补货策略的版本化入口（`ReplenishmentPolicyService.upsert`），因此审计与时间线沿用补货策略的 `REPLENISHMENT_POLICY_VERSIONED`，另有本接口自己的 `FIRST_MILE_TRANSIT_APPLIED` 审计；期望的策略版本号与当前不一致返回 409。`/domestic-warehouse/stock` 的 `pendingOutbound` 由本包提供：已选该仓、尚未出库的运单明细数量；`/purchase-orders/:id` 的 `links.firstMile` 改为引用该采购单的运单列表（没有 `firstmile.read` 为 `NO_PERMISSION`）。协作对象类型新增 `FIRST_MILE`（评论、关注、时间线随 `firstmile.read`）。

> **P2a-12 实现说明（CR-035）**：入仓计划共 25 条路由，在上表基础上多出：`GET /inbound/plans/:id/options`（装箱、分仓、运输方案与送达时间窗，含分仓总成本与推荐）、`GET /inbound/plans/:id/shipments`、`POST /inbound/plans/:id/submit`（提交到亚马逊创建计划，受 `sw.inbound.plan.create` 控制）、`PUT /inbound/plans/:id/boxes`（整体替换箱内物品，只改本地）、`PATCH /inbound/plans/:id/costs`（分仓总成本的估算参数与卖家自理的预处理、贴标费用，只改本地）。`POST /inbound/plans`（创建）只保存本地草稿，不调用亚马逊、不受开关控制；写入开关只管“提交创建、取消、确认装箱方案、提交箱内物品、确认分仓方案、确认运输方案与时间窗、回填追踪号”，生成方案、资格预检、取箱标签是只读调用，不受开关控制。每个写接口带计划版本号（乐观锁，冲突 409），有操作在途时一律拒绝（409）；调用亚马逊的写操作经 `INBOUND_PLAN_OP` 工作流在后台提交并轮询（15 分钟超时），响应是 `{ plan, state, jobId, operationId }`，真正结果看计划的 `stage` 与 `operations`。预处理与贴标固定由卖家负责：请求体里没有这两个字段，数据库有 CHECK 约束。`/inbound/plans/:id/labels` 返回 5 分钟有效的签名下载链接，箱标签 PDF 由亚马逊获取，商品标签是 CSV 清单（没有 FNSKU 标签接口）。`/inbound/shipments/:id/discrepancies` 的不合规问题与赔付任务固定为 `NOT_CONNECTED`，由 P2a-13、P2b-03 接入；`/inbound/shipments*` 列表为页码分页。采购单 `GET /purchase-orders/:id` 的 `links.inboundPlans` 由“尚未接入”改为按头程运单上登记的入仓货件推算的计划列表（需同时有 `firstmile.read` 与 `inbound.read`，否则为 `NO_PERMISSION`）。`POST /replenishment/to-inbound-draft` 当时仍只登记意图（补货建议没有发货地址，不能直接建计划）；P6-08 起该路由移除，改为批次级 `to-inbound-drafts`（CR-116）。

> **P2a-13 实现说明（CR-036）**：`GET /inbound/shipments` 新增查询参数 `destinationFc`（目的运营中心）与 `discrepancy=1`（只看有未消除差异或不合规问题的货件），每行新增 `receiving`：`{ transportStatus, discrepancyDays, claimState, noncomplianceCount }`——`claimState` 取 `NOT_JUDGED`（货件没关闭）、`NONE`、`WAITING`（少收但还在等待期）或赔付机会的状态；`noncomplianceCount` 在不合规报告还没有同步成功过时为 `null`（页面写“尚未接入”，不是 0）。`GET /inbound/shipments/:id` 的货件编号参数除货件行编号外也认亚马逊的货件编号与确认号（库存台账的参考编号），响应多 `sellerAccountId`、`transportStatus`。`GET /inbound/shipments/:id/discrepancies` 的 `compliance` 改为 `{ state: OK|NOT_CONNECTED, items, note }`，`claims` 改为 `{ state: OK|NOT_JUDGED, items, window, note }`（`window` 是入仓差异的等待期与申请期限，默认关闭起 45 天、540 天，未对照亚马逊当期政策核实），每个 SKU 行多 `reason`（亚马逊接收接口不给差异原因，只有同一 SKU 在不合规报告里有记录时才有，否则为 `null`）。新增 7 条路由：`GET /inbound/shipments/:id/attachments`（证据附件，需 `inbound.read`）、`POST /inbound/shipments/:id/attachments`（申请直传凭据）与 `POST …/attachments/confirm`（登记，需 `inbound.plan.write`，审计动作 `ATTACHMENT_ADDED`）、`GET …/attachments/:attachmentId/download`（5 分钟有效的签名链接）、`GET /inbound/shipments/:id/audit`（货件与所属计划上的审计记录，最近 100 条）、`GET /inbound/receiving/stats`（按目的运营中心的接收时长 p50、p90、最短、最长与样本数，统计最近 365 天内已关闭的货件，样本不足 5 个只显示不建议回写，口径文字随响应返回）、`POST /inbound/receiving/stats/apply`（人工确认后把 p90 回写企业级补货策略的 `receivingDays`，保存成新版本，请求体 `{ destinationFc | null, expectedVersionNo }`，权限 `replenishment.policy.write`，且要求全部店铺数据范围；`leadTimeDays` 不改；审计动作 `INBOUND_RECEIVING_TIME_APPLIED`）。证据附件复用采购模块的签名直传（`entityType = INBOUND_SHIPMENT`），附件挂在货件上而不是挂在某条差异上。

## 十、订单与售后、财务

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/orders` | `orders.read` | `OrderListQuery` | 订单列表（金额、状态、配送承诺、承运商、追踪号、退款、关联退货、结算、风险标记）；净收益是异步列，不在本响应里（见下一行） | — | — | — | — | 游标 |
| POST | `/orders/net-income` | `orders.read` + `field.profit` | `{ ids ≤ 100 }`（订单行 id） | 订单列表净收益异步列（P6-30 补）：返回 `{rows:{id:{net:{value,currency}}}}`，`value` 为空表示财务交易未同步；口径同订单详情；企业与店铺范围外的订单不出现；只读，不进审计 | — | 校验（超过 100 个 422） | — | — | — |
| GET | `/orders/:id` | `orders.read` | — | 订单详情身份区与概览 | — | — | — | — | — |
| GET | `/orders/:id/items` | `orders.read` | — | 订单行（现有接口保留）：商品、促销、税、取消信息 | — | — | — | — | — |
| GET | `/orders/:id/charges` | `orders.read` | — | 收入与费用明细（补） | — | — | — | — | — |
| GET | `/orders/:id/packages` | `orders.read` | — | 包裹与物流节点（补） | — | — | — | — | — |
| GET | `/orders/:id/returns` | `orders.read`、`returns.read` | — | 退款与退货（补） | — | — | — | — | — |
| GET | `/orders/:id/transactions` | `orders.read`、`finance.read` | — | 财务交易，含状态与结算单（补） | — | — | — | — | — |
| GET | `/orders/:id/timeline` | `orders.read` | — | 状态历史与推送事件（补） | — | — | — | — | — |
| GET | `/orders/:id/risks` | `orders.read` | — | 风险标记（补） | — | — | — | — | — |
| ~~POST~~ | ~~`/orders/:id/pii-access`~~ | — | — | **P6-14 已下线**，并入全站唯一出口 `POST /pii/reveal`（`objectType=ORDER`，字段 `buyerName` 等） | — | — | — | — | — |
| GET | `/returns` | `returns.read` | `ReturnListQuery` | 退货列表 | — | — | — | — | 游标 |
| GET | `/returns/analysis` | `returns.read` | `ScopeQuery` | 按 ASIN、原因的退货率趋势，与评论主题交叉（补） | — | — | — | — | — |
| GET | `/returns/awaiting` | `returns.read` | `ScopeQuery` | 退款后未收到退货的待核实清单（本包新增，冻结表之外，见 CR-040） | — | — | — | — | — |
| GET | `/returns/:id` | `returns.read` | — | 退货详情 | — | — | — | — | — |
| GET | `/reimbursements/opportunities` | `reimbursements.read` | `OpportunityQuery`（7 类规则） | 赔付机会：规则、证据、估算金额、截止时间、状态 | — | — | — | — | 游标 |
| GET | `/reimbursements` | `reimbursements.read` | `ReimbursementListQuery`（页签） | 案件列表 | — | — | — | — | 游标 |
| GET | `/reimbursements/stats` | `reimbursements.read` | `ScopeQuery` | 回收率、平均到账时长、各类成功率（补） | — | — | — | — | — |
| POST | `/reimbursements` | `reimbursements.write` | `ReimbursementCreateBody` | 从机会生成案件 | — | — | 是 | — | — |
| GET | `/reimbursements/:id` | `reimbursements.read` | — | 案件详情：证据、应收与实收、关联支持案件、时间线（补） | — | — | — | — | — |
| PATCH | `/reimbursements/:id` | `reimbursements.write` | `ReimbursementUpdateBody` + `VersionBody` | 更新状态、回填亚马逊案件编号 | — | — | 是 | — | — |
| POST | `/reimbursements/:id/evidence-pack` | `reimbursements.write` | — | 生成并导出证据包（走导出任务） | — | — | 是 | — | — |
| GET | `/support-cases` | `support.read` | `CursorQuery` | 支持案件列表（只读同步） | — | — | — | — | 游标 |
| GET | `/support-cases/:id` | `support.read` | — | 沟通历史、预约回电、附件、关联对象 | — | — | — | — | — |
| GET | `/finance/events` | `finance.read` | `FinanceEventQuery`（9 类费用分类） | 费用事件 | — | — | — | — | 游标 |
| PATCH | `/finance/events/:id/reconciliation` | `finance.reconcile` | `ReconcileBody` + `VersionBody` | 标记差异、对账备注 | — | — | 是 | — | — |
| GET | `/finance/fee-audit` | `finance.read` | `FeeAuditQuery`（4 类核查） | 核查结果：应收、实收、差额、依据、累计 | — | — | — | — | 游标 |
| POST | `/finance/fee-audit/:id/reimbursement` | `reimbursements.write` | — | 一键转为赔付机会（补） | — | — | 是 | — | — |
| GET | `/settlements` | `finance.read` | `SettlementListQuery` | 结算列表 | — | — | — | — | 游标 |
| GET | `/settlements/:id/summary` | `finance.read` | — | 结算汇总 | — | — | — | — | — |
| GET | `/settlements/:id/transactions` | `finance.read` | `CursorQuery` | 交易明细 | — | — | — | — | 游标 |
| GET | `/settlements/:id/reconciliation` | `finance.read` | — | 三方核对结果 | — | — | — | — | — |
| GET | `/settlements/:id/exceptions` | `finance.read` | `CursorQuery` | 异常清单（补） | — | — | — | — | 游标 |
| GET | `/settlements/:id/disbursements` | `finance.read` | — | 打款记录（补） | — | — | — | — | — |
| GET | `/finance/cashflow` | `finance.read` | `ScopeQuery` | 余额、递延与释放、打款预测、按周现金流预测（模型估算标注） | — | — | — | — | — |
| POST | `/finance/disbursements/confirm` | `finance.reconcile` | `DisbursementConfirmBody` | 到账手工登记（补） | — | — | 是 | — | — |
| GET | `/profit/overview` | `profit.read`（+ `field.profit`；缺字段权限 403） | `ScopeQuery`、`recognition`（ORDERED、SHIPPED、SETTLED，默认 ORDERED） | 利润桥、趋势、数据质量标记（实现：另给核心指标、问题标记行数、口径说明） | — | — | — | — | — |
| GET | `/profit/stores` | `profit.read`（+ `field.profit`；缺字段权限 403） | `ScopeQuery`、`recognition` | 店铺利润（范围内每个店铺一行，含没有数据的；每行带自己的利润桥） | — | — | — | — | — |
| GET | `/profit/asins` | `profit.read`（+ `field.profit`；缺字段权限 403） | `ScopeQuery`、`recognition`、`by`（SKU、ASIN、PARENT）、`q`、`sort`（revenue、profit、margin、units）、`CursorQuery` | ASIN、SKU、父体单位经济；官方净收益对照恒为“尚未接入”（P2b-11 前）；成本类字段需 `field.cost`，没有则整字段不返回；游标是服务端签名的偏移型游标，分组读取上限 20000 | — | — | — | — | 游标 |
| GET | `/profit/ads` | `profit.read`（+ `field.profit`；缺字段权限 403） | `ScopeQuery`、`recognition`、`by`、`q`、`sort`、`CursorQuery` | 广告分摊后利润；P3-16 起先按广告商品报表归属到 ASIN，剩余按财务口径规则（销售额或销量）分摊；没有分摊结果的行仍是“广告尚未分摊”，店铺层面给账户总花费；见下方“P3-16 实现说明” | — | — | — | — | 游标 |
| GET | `/profit/cost-coverage` | `profit.read`（+ `field.cost`；缺字段权限 403） | `ScopeQuery`、`recognition`、`q`、`CursorQuery` | 缺成本 SKU、成本过期（超过 180 天，接口返回 `staleDays`）、广告未分摊、汇率缺失或回退 | — | — | — | — | 游标 |
| GET | `/profit/bridge` | `profit.read`（+ `field.profit`；缺字段权限 403） | `ScopeQuery`（当前期 = 时间范围；对比期 = 全局对比期，没选用上一期）、`recognition` | 利润桥对比（逐项影响；任一期没有数据的项不给影响值） | — | — | — | — | — |
| GET | `/finance/economics/compare` | `finance.read`（+ `field.profit` 与 `field.cost`，缺任一 403；CR-049） | `ScopeQuery`、`recognition`、`verdict`、`q`、`sort`、`CursorQuery` | 双源核对与差异分类（成本口径、广告口径、时间口径、未解释；无法核对三种原因；店铺广告核对；每边最多读 19,999 行，超过 `truncated`） | — | — | — | — | 游标 |
| GET | `/finance/economics/preview` | `finance.read` | `ScopeQuery`、`changedOnly`、`feeType`、`q`、`CursorQuery` | 费用预览（未来 120 天；每个店铺只看最近一次、3 天内的查询；影响 = −单件费用变化 × 预估数量，没有预估数量不估算） | — | — | — | — | 游标 |
| POST | `/finance/economics/simulate` | `finance.read`（`@Write`，审计 `ECONOMICS_SIMULATED`） | `EconomicsSimulateBody`（`sellerAccountId`、`sku`、`actionType` 为 `AWD` 或 `SIPP`、`quantity`（AWD 必填、SIPP 不得填）、`itemPrice`、`endInDays`） | 向数据中心提交模拟查询，建运行记录与后台任务，立即返回 `PENDING`；同一租户在途最多 5 个，超过 409（CR-049） | — | — | — | — | — |
| GET | `/finance/economics/simulations/:id` | `finance.read` | — | 轮询模拟结果：`PENDING`、`DONE`、`FAILED`；净收益需 `field.profit`（CR-049 新增） | — | — | — | — | — |
| GET | `/finance/sales-tax` | `finance.tax.read` | `ScopeQuery` | 按州汇总、与订单对账、趋势；缺受限角色时在每家店的 `stores[].state` 里写“未授权”（**P2b-12 已实现，CR-050**） | — | — | — | — | — |
| GET | `/finance/periods` | `finance.read` | `PageQuery`（`status` 筛选、`periodStart` 排序） | 期间列表与各状态个数（**P2b-13 已实现，CR-051**） | — | — | — | — | 页码 |
| POST | `/finance/periods` | `finance.period.close` | `PeriodCreateBody` | 创建期间 | — | — | 是 | — | — |
| GET | `/finance/periods/:id` | `finance.read` | — | 关账详情（补） | — | — | — | — | — |
| POST | `/finance/periods/:id/check` | `finance.period.close` | — | 数据完整性检查清单结果 | — | — | 是 | — | — |
| POST | `/finance/periods/:id/approve` | `finance.period.close` | `ApprovalBody` | 审批 | — | — | 是 | — | — |
| POST | `/finance/periods/:id/close` | `finance.period.close` | `PeriodCloseBody`（`version`） | 锁定并对利润日表、汇率、成本版本做快照（**实现要求再次验证身份，CR-051**） | — | — | 是 | 是 | — |
| POST | `/finance/periods/:id/reopen` | `finance.period.reopen` | `ReasonBody` | 重新开账，生成差异报告 | — | — | 是 | 是 | — |
| GET | `/settings/finance-policy` | `settings.read` | — | 收入确认口径、存货计价、广告分摊、费用分摊及版本（补） | — | — | — | — | — |
| PUT | `/settings/finance-policy` | `finance.policy.write` | `FinancePolicyBody` + `VersionBody` | 提交修改，进入审批（补） | — | — | 是 | 是 | — |
| POST | `/settings/finance-policy/:version/approve` | `finance.policy.write` | `ApprovalBody` | 审批生效；发起人不能审批（补） | — | — | 是 | 是 | — |

> **P3-19 实现说明（CR-075）**：ASIN 360“广告”页签，**一条只读路由** `GET /products/:id/ads`（冻结表已有，没有新增）。`:id` 是商品编号（`FbaProduct.id`，范围外与别的企业 404）；权限 `products.read` 加 `ads.read`，**先于参数校验与读数据**（403 在 422 之前），日期参数只有全局范围的 `from`、`to`（不选默认最近 30 天，写在 `range.defaulted`）。一个商品 = 一个店铺 × 一个 ASIN，**同一 ASIN 的多个 SKU 合在一起**；店铺下经广告档案（`AdsProfile.sellerAccountId`）绑定的所有档案一起算（不同站点各一个档案），只含美元、花费不为空的行；别的店铺与别的企业的同 ASIN 不并入。响应 `Asin360AdsResponse`（契约 `packages/api-contracts/src/asin360-ads.ts`，只有常量与类型）：`state`（`OK` / `NO_DATA` / `NOT_CONNECTED`）与 `note`、`range`、`summary`（花费、广告销售额、订单、广告成本销售比等比率、全部销售额、广告占总销售比、自然销售额与 `organicIssue`、推广活动数、广告数在投/全部）、`trend`（范围内每天一点，没有记录的日子广告列全是 null）、`halo`（光环销售，`OK` 或 `NOT_CONNECTED`）、`stock`（库存与断货仍在花钱的依据）、`campaigns`、`adGroups`、`targets`、`searchTerms`（四块各自 `state` / `note` / `items` / `truncated`，每块最多 50 行，按花费从高到低）、`brandGaps`（恒为 `NOT_CONNECTED`，等 P4-04 品牌分析）、`sharedNote` 与 `basis`（口径说明）。**口径要点**：活动行的数字是这个 ASIN 自己的（被推广商品日报表按 ASIN 在数据库里聚合）；广告组、投放对象、搜索词的数字是**对象自己的合计**（亚马逊没有按 ASIN 拆开），广告组行带 `groupAsins`（组内不同 ASIN 数，大于 1 表示数字包含别的商品）与 `asinAds`（本 ASIN 的广告数）；这三块靠广告表（`AdsAd.asin`）找出关联这个 ASIN 的广告组。店铺没有绑定广告账户：整页 `NOT_CONNECTED` 并写原因，**不读任何广告业务表**；绑定了但被推广商品报表从没同步过：`NOT_CONNECTED`；同步过但范围内没有这个 ASIN 的行：`NO_DATA`。广告实体（广告、广告组、投放、关键词）与搜索词报表的同步器原先没排给任何包；**P5-12A（CR-104）已交付**（实体每 2 小时、报表每天自动申请），之后这几块没有记录时写“尚无记录”，光环销售没有转化商品行也是“尚无记录”，不再写“尚未接入”。

> **P2b-17 实现说明（CR-055）**：ASIN 360 的“利润与成本”“退货”两个页签上线，共 5 条路由，`:id` 与 P2a-14 一致（商品编号，范围外与别的企业 404）；权限先于参数校验（403 在 422 之前）。冻结表只有 `/economics` 与 `/returns`，**本包新增** `/economics/official`、`/economics/preview`、`/economics/costs`，把官方对照、费用预览、成本版本拆成独立接口（各有自己的准入，不让一个无权限的块拖垮整个页签）。`GET /products/:id/economics`（`products.read` + `profit.read` + `field.profit`；参数 `from`/`to`/`compare`、`recognition`）：把利润分析（P2b-10）的同一套计算收窄到这个商品（店铺 × SKU，只含下单或结算释放一种口径、不含店铺级行）；返回 `bridge`（利润桥）、`unit`（每件经济：`state` 为 `OK`/`NO_UNITS`/`INCOMPLETE`，`avgPrice`、`netPerUnit`、`proportionalShare` 与每一项的 `perUnit`、`priceLink`；有任一行缺成本时整体净利润与每件净利润都是 `null`）、`trend`、`listPrice`、`winPrice`（恒为 `NOT_CONNECTED`，P4-08 接入）、`costCoverage`（只在有 `field.cost` 时给，否则 `null`）。**价格模拟器在前端用契约里的纯函数 `simulatePrice` 计算，不新增后端接口**（与冻结的 `POST /products/:id/price-simulation` 不同，那条路由仍未实现）：佣金、退款、促销随价格成比例，其余每件固定。`GET …/economics/official`（`finance.read` + `field.profit` + `field.cost`，一次最多 90 天，超过 422）：逐日官方与我方对照，只读这个 SKU 的行；我方数字不含店铺级费用与账户级广告。`GET …/economics/preview`（`finance.read`）：这个 SKU 在店铺**最近一次**费用预览里的行，那次查询里没有这个 SKU 时写明原因，不估算。`GET …/economics/costs`（`costs.read` + `field.cost`）：这个 SKU 的成本版本时间线，复用成本详情的计算。`GET /products/:id/returns`（`products.read` + `returns.read`；全局范围参数，默认最近 90 天）：**按店铺 × ASIN 汇总**（同 ASIN 的多个 SKU 看到同一份），返回汇总与退货率（分母是同期销售件数）、趋势、原因、处置分布、最近 20 条退货（含详情链接编号）、`reimbursements`（同 ASIN 各 SKU 的退货类赔付机会与案件，最多 50 条；没有 `reimbursements.read` 为 `RESTRICTED`）、`categoryThemes`（恒为 `NOT_CONNECTED`，P4-13 接入）。

> **P2b-12 实现说明（CR-050）**：`GET /finance/sales-tax`（`finance.tax.read`，只读，一条路由，无写入口）。参数只有全局范围参数（店铺、`from`、`to`），权限先于参数校验，参数错误 422；没选日期默认最近 90 天，按 UTC 日历日分月，最多保留最近 14 个月（超过时起点收窄，`range.clamped=true`）。响应：`state`（`OK`/`NO_DATA`，报告与订单接口两边在所选范围内都没有税额记录才是 `NO_DATA`，带 `note`）、`range`、`currency`（固定 `USD`）、`stores`（每家店的取得情况 `AVAILABLE`/`NOT_GENERATED`/`ROLE_PENDING`/`FAILED`/`NO_RECORD`，来自 `rpt.sales-tax` 的同步新鲜度；失败写中文原因）、`sources`（税务文档库报告、订单接口、发货报告：`OK`/`NO_DATA`/`NOT_CONNECTED`，发货报告恒为“尚未接入”）、`totals`（`taxCollected`、`taxableSales`、`ordersTax`，没有数据为 `null`）、`states`（按州汇总，税额从高到低，含 `share` 与 `jurisdictions` 辖区明细，辖区最多读 3000 行，超出 `jurisdictionsTruncated=true`，各州合计不受影响）、`trend`（每月报告与订单合计，没有记录为 `null`）、`reconciliation`（每月 × 店铺：`MATCHED`/`DIFFERENT`/`NO_REPORT`/`NO_ORDERS`，差额=报告−订单，一边没有记录时差额为 `null`；容差 max(0.05, 0.1%×较大者) 是自定的）、`basis`、`freshness`。订单一边是 `OrderCharge`（`chargeKind=TAX`，只算美元）按下单时间汇总，**订单接口不给收货州，所以订单一边不分州**；报告一边是 `SalesTaxSummary`（来源 `TAX_LIBRARY`，按报告日期存到日）。与冻结的出入见 CR-050。

> **P2b-15 实现说明（CR-053）**：财务口径冻结的 3 条路由全部实现，没有新增路由。`GET /settings/finance-policy`（`settings.read`）返回 `current`（当前口径：最近一个 `ACTIVE` 版本；没有时是系统默认口径 `source=DEFAULT`，存货计价沿用企业设置 `finance.inventoryCosting` 的旧值，取值不合法时 `inventoryMethodValid=false` 并按先进先出）、`pending`（待审批版本，至多一个，含 `mine` 表示是否本人发起）、`history`（最近 50 个版本，`historyTruncated`）、`latestVersionNo`（提交时作为乐观锁带回）、`fields`（5 项口径的名称、说明、可选项、是否可改，以及 `consumer`：`WIRED` 已被计算使用 / `RECORDED` 仅登记尚未使用，附说明）、`today`（企业数据口径时区的今天）、`actions`（`submit` / `approve` / `reject` 各自 `allowed` 与不能点的原因，页面按它启用按钮）、`frozenPeriodCount`（关账中与已关账的期间数）。`PUT /settings/finance-policy`（`finance.policy.write` + 再次验证身份 `finance.policy`）：请求体 `version`（= `latestVersionNo`，不一致 409）、`effectiveFrom`（不晚于今天、不早于 366 天前，且不能落在关账中或已关账的期间内）、`revenueRecognition`（`ORDERED`/`SHIPPED`/`SETTLED`）、`inventoryCostMethod`（`FIFO`/`MOVING_AVG`/`MONTH_AVG`）、`adsAllocationMode`、`storeFeeAllocation`（`BY_SALES`/`BY_UNITS`）、`fxRateRule`（目前只有 `SALE_DAY`）、`reason`（2 至 500 字）；与当前口径完全相同返回 422，已有待审批版本返回 409；成功生成 `PENDING` 版本，**不生效**。`POST /settings/finance-policy/:version/approve`（`finance.policy.write` + 再次验证身份，创建返回 201）：请求体 `decision`（`APPROVED`/`REJECTED`）、`comment`（驳回必填 2 字以上）、`version`（版本行的乐观锁）；**发起人不能批准自己的版本（409），但可以驳回自己的版本，等于撤回**（响应与历史里标 `withdrawn`）；通过时同一事务里把旧 `ACTIVE` 版本标 `REPLACED`，并把存货计价方法写入企业设置 `finance.inventoryCosting`（利润日表与成本页估值读这一项）。权限先于参数校验，被拒绝的写请求也写 `DENIED` 审计；审计动作 `FINANCE_POLICY_SUBMITTED`、`FINANCE_POLICY_APPROVED`、`FINANCE_POLICY_REJECTED`，`detail.summary` 写变化摘要、`detail.frozenPeriodsUnaffected` 写当时受保护的期间数。

> **P2b-14 实现说明（CR-052）**：商品成本冻结的 4 条路由全部实现，另新增 4 条（`POST /costs/activate`、`PATCH` 与 `DELETE /costs/versions/:id`、`GET /costs/:sku/compare`），共 8 条；冻结的“新版本”落为 `POST /costs`（创建一个草稿，带 `activate: true` 时同一事务里确认生效）。读需要 `costs.read` 且有 `field.cost`（缺字段权限返回 403，不是去字段），结果按数据范围过滤；**写需要 `costs.write` 且范围为“全部店铺”**（成本版本没有店铺归属，范围收窄的人不能写），被拒绝的写请求也写 `DENIED` 审计。`GET /costs` 是签名偏移游标（`cursor`、`pageSize`，排序只有 `sku`，筛选 `coverage`（`COVERED`/`STALE`/`DRAFT_ONLY`/`MISSING`）、`draft`、`q`（SKU 包含），汇总在内存里按 SKU 做，最多读 19,999 个分组，超过 `truncated=true`），响应带 `summary`（四种覆盖状态各多少个 SKU、待确认草稿多少个）；每行：当前生效版本（生效日期、各项成本含币种与折合美元）、到岸成本合计、覆盖状态、待确认草稿数、最近变更时间；没有的项为 `null`，不是 0。`GET /costs/:sku`：版本时间线（来源、单据号、状态、被替换与被入库批次压过的说明、可否修改与丢弃、确认生效时会替换哪一版、不能生效的原因）、构成、库存成本估算（`valuation`：按企业计价设置 `finance.inventoryCosting` 的方法（先进先出、移动加权、月末加权，设置不合法按先进先出）算，数量取各店铺最近一次库存规划报告的可售数量；`state` 为 `OK`/`NO_COST`/`NO_STOCK_DATA`，没有库存报告写“尚无库存报告”）；SKU 不存在或不在数据范围内返回 404。版本状态：`DRAFT` 草稿、`ACTIVE` 生效、`REPLACED` 已替换；**不同生效日期的 `ACTIVE` 版本并存**（利润按销售日取不晚于当天的最新一层），只有同一生效日、同一成本项的旧版本被标 `REPLACED`。`PATCH`、`DELETE` 与 `POST /costs/activate` 都带版本号（乐观锁，冲突 409）；系统生成的草稿（采购收货、头程分摊）只允许改关税、其他成本、生效日与备注，且不能丢弃（要到来源单据或运单撤销）；**生效日期落在 `CLOSING`/`CLOSED` 期间内的草稿拒绝生效**（409 `DATA_CONDITION_FAILED`，写明哪个期间）；生效日期最多晚于今天 365 天。`POST /costs/import`：浏览器读出 CSV 文本连同文件名提交（`content`，最大约 200 KB、500 行），服务端逐行校验，**一行有错整份拒绝**，通过则写成 `FILE_IMPORT` 草稿（需再确认生效），中英文表头都认。审计动作：`COST_VERSION_CREATED`、`COST_VERSION_UPDATED`、`COST_VERSION_DISCARDED`、`COST_VERSION_ACTIVATED`、`COST_VERSION_REPLACED`、`COST_VERSIONS_IMPORTED`。与冻结的出入见 CR-052。

> **P2b-13 实现说明（CR-051）**：7 条路由，创建返回 201。流程：`POST /finance/periods`（`sellerAccountId` + `month` 年-月，一个店铺一个自然月，企业数据口径时区）→ `POST :id/check`（可带 `acknowledgements`：只有“广告分摊完成”“对账异常已处理或已确认”两项能确认放行，每项必填 2 至 300 字原因；清单六项：同步完整、结算已到、成本覆盖率不低于 95%、汇率齐全、广告分摊、对账异常）→ 通过后 `CLOSING`（这期间 worker 对该店铺该期间停止重算利润日表）→ `POST :id/approve`（`decision` 为 `APPROVED` 或 `REJECTED`，驳回必须写意见；**审批人不能是运行检查的人**）→ `POST :id/close`（再次验证身份；锁定前重新检查，不通过返回 409 `DATA_CONDITION_FAILED` 并回到开放；通过则写快照、锁定期间内汇率）。`POST :id/reopen`（`finance.period.reopen`，再次验证身份，原因必填）：汇率解锁、状态 `REOPENED`，已有快照保留；再次锁定写下一个修订并生成与上一份快照的差异报告。所有写请求带 `version`（乐观锁，检查除外），审计动作 `PERIOD_CREATED`、`PERIOD_CHECKED`、`PERIOD_APPROVED`、`PERIOD_REJECTED`、`PERIOD_CLOSED`、`PERIOD_REOPENED`。`GET :id` 响应：`period`（含状态说明）、`checklist`、`preview`（未关账是实时利润日表、已关账是快照；缺 `field.profit` 为 `RESTRICTED`，缺 `field.cost` 时成本项为 `RESTRICTED`）、`snapshots`（最近 10 份摘要）、`diff`（重新开账期间是“上一份快照与现在”，再次关账后是“本次与上一份”）、`actions`（每个动作 `allowed` 与不能做的原因，页面按它启用或禁用按钮）。与冻结的出入见 CR-051。

> **P2b-08 实现说明（CR-046）**：2 条路由都在 `/finance` 下。`GET /finance/cashflow`（`finance.read`，查询参数 `currency` 默认 `USD`、`weeks` 默认 8 最多 13，再加通用范围参数）：权限先于参数校验，参数错误 422；每次现算，不读取也不保存预测快照。响应分五块：`balances`（只有递延余额，每个店铺 × 账户类型 × 币种取最近一次快照，`unavailable` 写明可用余额与下次打款额没有官方接口）、`deferral`（递延中合计、有预计释放日的笔数、按周分桶的释放计划、最近 90 天入账现已释放的合计）、`payout`（每个店铺单独推断周期与到账延迟，已公布的打款与模型预计的打款分开，`next` 取最近的一次，`dailyRate` 是最近 28 天已释放交易的日均净入账）、`forecast`（按周入账与出账、各来源状态 `OK`/`RESTRICTED`/`OUT_OF_SCOPE`/`NOT_CONNECTED`，来源不可用的列为 `null` 并列在 `missing`，币种不同与没有日期的付款单列 `excluded`、`undated`，累计净额不含期初余额）、`disbursements`（最近 100 张带打款金额的结算单与手工登记的到账，核对状态见 `DISBURSEMENT_STATE_LABEL`）；`currencies` 是范围内出现过的币种，页面据此切换，不换算汇率；没有任何数据 `state=NO_DATA` 并写明原因；`canConfirm` 表示是否有登记权限。`POST /finance/disbursements/confirm`（`finance.reconcile`，`@Write` 动作 `DISBURSEMENT_CONFIRMED`，需幂等键）：请求体 `settlementId`、`disbursedAt`（YYYY-MM-DD，不能晚于企业时区明天）、`amount`（大于 0）、`currency`、可选 `bankLast4`（四位数字）、`note`（≤ 200）、`version`；一张结算单一条登记，已有登记时不带 `version` 返回 409、带 `version` 走乐观锁改正（版本过期 409）；结算单不在数据范围内 404，报告没有打款金额 409；返回 201 与 `{ id, version, created, state, diff }`，差额是“登记 − 报告”，币种不同不比较（`diff=null`），容差 0.05。`GET /settlements/:id/disbursements` 的 `manual.available` 现在在有打款金额时为 `true`，已登记的到账多一行 `source=MANUAL`。

> **P2b-07 实现说明（CR-045）**：结算交易 6 条路由全部实现，均只读、`finance.read`，路径用冻结的 `/settlements`（交易明细是 `/:id/transactions`）；权限检查先于参数校验，参数错误 422，坏游标 400；数据范围按店铺过滤，范围外的结算单所有子路由都是 404（不是 403）。`GET /settlements` 游标分页（默认按 `sortAt` 从新到旧；`status` 筛选 `MATCHED`/`DISCREPANCY`/`PENDING`），响应带 `summary`（各状态张数，不随分页变）与 `freshness`，待核对的行 `totals`、`diffAmount`、`totalAmount` 为 `null`（不是 0）并带 `pendingReason`。`/:id/summary` 给身份、各类别合计与按科目汇总（报告没到 `hasReport=false` 并写明原因）；`/:id/transactions` 游标分页，`category` 筛选，`orderFound` 只在有 `orders.read` 时才有值（`canViewOrders`）；`/:id/reconciliation` 给官方金额（报告，不含保留金）、系统金额（财务接口）、差额、三项核对与差异分类汇总，待核对时三个金额为 `null`；`/:id/exceptions` 游标分页，`kind`、`category`、`status` 筛选；`/:id/disbursements` 的来源现在只有结算报告，`manual.available=false`（手工登记属 P2b-08）。**冻结的 `exceptions.amount` 在实现里是各类差额绝对值之和**。
>
> **P2b-06 实现说明（CR-044）**：费用核查冻结的 2 条路由全部实现，**没有新增路由**（汇总与尺寸分段变化直接放在列表响应里）。`GET /finance/fee-audit` 游标分页（默认按累计差额 `overchargeAmount` 从大到小，也可按多收次数 `occurrences`；响应 `pageInfo`；坏游标 400，参数错误 422，权限检查先于参数校验）。查询参数：全局范围参数加 `kind`（`FULFILLMENT`/`COMMISSION`/`STORAGE`/`INBOUND_PLACEMENT`，**冻结里的“其他”类没有做**）、`status`（`NORMAL`/`SUSPECTED`/`APPEALED`）、`q`（SKU 与货件号开头匹配不分大小写，ASIN 开头匹配）。**列表只显示每个店铺最近一个核查日的结果**（后台每 6 小时核查一次，同一天重复核查覆盖当天的行，更早的核查日是历史、不重复出现）。响应：`state`（`OK`/`NO_DATA`，没有结果时带 `note` 写明需要哪些报告；筛选后为空时提示放宽条件）、`items`（每行：核查对象 `subjectKey`——SKU 或入仓计划编号、SKU/ASIN/货件号、`expectedAmount`（应收）、`actualAmount`（实收）、`diffAmount`、`overchargeAmount`（累计差额，只累计多收的行）、`occurrences`（多收次数）、`checkedCount`（核对行数）、首次与最近一次发生时间、`status`、`basis`（依据：说明文字、多收明细最多 20 条、尺寸与重量对比、核对限制 `notes`）、`opportunityId`；金额一律是费用的绝对值正数）、`summary`（4 类各一行：对象数、疑似多收对象数、发生次数、按币种分别合计的累计差额，**不受 `kind`、`status`、`q` 筛选影响**，只受数据范围影响）、`sizeTierChanges`（最近 14 天尺寸分段变化，每个店铺每个 SKU 最近一次，最多 50 条）、`snapshotDate`、`canConvert`（是否有 `reimbursements.write`）、`freshness`（财务交易、两份基准报告、月度仓储费报告、入仓计划 5 个来源）。`POST /finance/fee-audit/:id/reimbursement`（`@Write`，审计动作 `FEE_AUDIT_CONVERTED`，需 `reimbursements.write`，路径参数先校验权限再校验格式）：把疑似多收的核查行转成赔付中心的“费用多收”机会（`ruleCode = FEE_OVERCHARGE`，去重键 `fee-audit:<类别>:<对象>`，**不含核查日**，所以同一对象无论哪天转都只对应一个机会；应收金额取累计差额，截止日按赔付时限设置里 `FEE_OVERCHARGE` 的等待期与申请期限从最早一次多收起算）。返回 201 `{ id, status: 'APPEALED', opportunityId, created }`：已转过且机会仍待处理或已立案时返回已有机会（`created = false`，不重复建）；没有多收的对象、最早一次多收已超过申请期限、对应机会已被忽略/已过期/差异已消除，均返回 409（后一种提示去赔付中心处理，不重建）；范围外或不存在返回 404；并发时靠唯一键兜底。转出后核查行状态为 `APPEALED`，之后每一轮核查都保持该状态，不会改回“疑似多收”。赔付中心的 `FEE_OVERCHARGE` 现在是“已接入”（`connected = true`），但**只有人在费用核查页点“转为赔付机会”才会产生机会，后台不会自动识别**；证据类别新增 `FEE_AUDIT`。

> **P2b-05 实现说明（CR-043）**：费用事件冻结的 2 条路由全部实现，另新增 2 条（冻结表里没有）：`GET /finance/events/summary`（页签统计）、`GET /finance/events/:id`（证据与变更历史）。静态路径 `summary` 排在 `:id` 之前，权限检查先于参数校验。`GET /finance/events` 游标分页（只按入账时间排序，响应 `pageInfo`；坏游标 400，参数错误 422），查询参数：全局范围参数加 `category`（9 类之一，不传是 9 类全部；销售收入、税这类“不是费用”的明细 `NON_FEE` 从不返回）、`status`（`DEFERRED`/`RELEASED`/`DEFERRED_RELEASED`，只命中来自财务接口的明细，报告类没有交易状态）、`reconciliation`（`UNRECONCILED`/`DISCREPANCY`/`RECONCILED`）、`q`（订单号、结算单号、交易编号开头匹配，ASIN 开头匹配，SKU 开头匹配不分大小写）。不带日期范围默认最近 30 天（企业时区），响应 `range` 含 `from`、`to`、`defaulted` 与实际起止时刻 `fromAt`、`toAt`（导出任务原样带上，保证导出与页面一致）。每行含类型与子类型（中文）、带符号金额（扣费为负）、币种、入账时间、交易状态、订单号、ASIN、SKU、结算单号、货件号（来自交易的关联标识）、来源（`FINANCE_API`/`STORAGE_REPORT`/`NONCOMPLIANCE_REPORT`）、对账状态与备注、`version`；`state` 为 `OK` 或 `NO_DATA`（带 `note`）。`GET /finance/events/summary`：9 类各一行（笔数、按币种分别合计、标记有差异的笔数），按其余筛选统计，不受 `category` 影响。`GET /finance/events/:id`：费用明细、来源交易（含关联标识）、同一笔交易的其他明细（最多 50 条）、对账变更记录（最近 20 条）、`orderId`（仅当有 `orders.read` 且订单已同步）；范围外或不是费用的明细返回 404。`PATCH /finance/events/:id/reconciliation`（`@Write`，需 `finance.reconcile`，审计 `FEE_EVENT_RECONCILED`）：body `{ version, status?, note? }`——冻结表里的 `ReconcileBody` 与 `VersionBody` 合成一个体；`status` 只能是 `UNRECONCILED`/`DISCREPANCY`（**不接受手工设“已对账”**，留给 P2b-07 的结算核对）；`DISCREPANCY` 必须带 `note`；备注最长 500 字；状态与备注都没变化返回 409；版本不一致 409（带当前版本号）；每次写一条变更记录（`EntityEvent`，`entityType = FEE_EVENT`）。发起导出走导出中心（`kind = fee-events`，需 `finance.read` 与 `export.create`，导出列见 `EXPORT_KINDS`）。旧 `GET /fba/fees` 过渡期保留。`GET /inventory/capacity` 的 `notConnected` 两项（实际库龄附加费、低库存水平费）的 `workPackage` 改为空串，说明改指向费用事件页（本页暂不汇总实际发生额）。

> **P2b-04 实现说明（CR-042）**：支持案件 2 条路由全部实现，**只读，没有任何写入口**（回复、上传附件、预约回电都在卖家后台进行）。`GET /support-cases` 游标分页（默认按最近更新时间新到旧，可改按创建时间；响应 `pageInfo`），查询参数：全局范围参数加 `q`（主题包含或亚马逊案件编号开头）、`status`（`PENDING_AMAZON_ACTION`/`PENDING_MERCHANT_ACTION`/`TRANSFERRED`/`RESOLVED`），可选 `from`、`to`（按创建日期、企业时区），**不设默认日期范围**（案件总量小）。响应 `state`：`OK`、`NO_DATA`（同步正常但没有案件，写“尚无记录”）、`NOT_CONNECTED`（没有成功同步过）、`ROLE_PENDING`（受限角色未获批，`note` 是申请方式）；`sync` 给出同步状态（含 `rolePending`、`lastSuccessAt`、失败原因），`freshness` 是新鲜度条。每行含案件编号（`caseId`）、系统编号（`id`）、主题、状态与中文、创建、更新、解决时间、`contactCount`（沟通还没同步为 null，页面写“尚未同步”，不是 0）、`reimbursementCaseId` 与 `reimbursementCaseNo`（赔付案件里回填的亚马逊案件编号一致就关联；没有 `reimbursements.read` 时不返回）。`GET /support-cases/:id` 的 `:id` 认系统编号或亚马逊案件编号，不在成员数据范围内返回 404；返回案件、`appointments`（预约回电：状态、时间窗，**没有电话号码**）、`contacts`（沟通记录从早到晚，最多 500 条，附件只有名称）、`contactsState`（`OK`/`NOT_SYNCED`/`NO_DATA`）与 `contactsNote`、`links`（赔付案件需 `reimbursements.read`、货件需 `inbound.read`、商品需 `products.read`，缺权限的关联不给；货件来自赔付案件的货件证据，或案件主题里的 FBA 货件编号且在我方货件里存在，后者页面标明“按案件主题推算”）。**与冻结的出入**：评论与关注没有接（协作模块的对象类型不含支持案件，页面只读）。`GET /reimbursements/:id` 的 `supportCases` 由固定“尚未接入”改为 `SupportLinkView`：`RESTRICTED`（没有 `support.read`）、`NO_ID`（赔付案件没有回填案件编号）、`NOT_CONNECTED`（该店铺没有成功同步过，或受限角色未获批）、`NOT_FOUND`（同步正常但没有这个编号）、`OK`（案件加最近 5 条沟通）。

> **P2b-01 实现说明（CR-039）**：订单共 10 条路由（上表 `/orders*` 全部）。**列表由页码改为游标分页**（响应 `pageInfo`：`pageSize`、`nextCursor`、`hasMore`、`approxTotal`；只按下单时间倒序，游标与查询绑定，换了条件再用旧游标返回 400），旧响应 `{ items, total }` 作废。查询参数：全局范围参数加 `q`（订单号前缀或追踪号完全匹配）、`status`、`asin`、`sku`、`refunded`、`returned`、`replacement`、`promotion`、`settlement`（`NONE`/`DEFERRED`/`RELEASED`）、`risk`（`CANCEL_REQUEST`/`REFUND`/`RETURN`/`REPLACEMENT`；财务差异与税务异常要逐单比对金额，只在每行与详情里显示，不能整表筛选）。不带日期范围时默认最近 30 天，响应 `range` 写明实际范围与 `defaulted`；退款、退货、结算筛选先找出符合条件的订单号再套到列表上，订单号集合上限 5000，超出时 `filterLimited=true`（页面提示“结果可能不完整”）。没有订单时 `state = NO_DATA` 并带 `note`。每行含金额、件数、状态、履约、承运商与追踪号、`refund`（`NONE`/`PARTIAL`/`FULL`/`PENDING_DATA`，**没有任何财务交易时是 `PENDING_DATA`，不是“无退款”**）、`returnCount`、`settlement`、`risks`；`netIncome` 只在有 `field.profit` 时出现（字段不返回，不是 null），值为空表示财务交易还没同步（不是 0）；列表任何位置都没有买家信息，也不读取密文列。`:id` 认系统编号或亚马逊订单号，不在成员数据范围内返回 404。`/returns` 页签需 `orders.read` + `returns.read`，`/transactions` 需 `orders.read` + `finance.read`，权限检查先于查订单；`/charges` 的费用明细按财务交易路径里的关键字分为收入、税、费用三组（**启发式，不是亚马逊官方分类**），并与订单接口的收入与税逐项比对（`match`：一致、有差异、没有财务交易、没有逐项明细）；`/transactions` 最多 200 条（`truncated`）；`/packages` 的逐段物流节点 `tracking`、`/timeline` 的推送事件 `push`、`/items` 的关联商品 `associatedItems` 固定为 `NOT_CONNECTED`（页面写“尚未接入”）。`/orders/:id/items` 的响应改为 `{ items, cancellation, associatedItems }`。`POST /orders/:id/pii-access`：先要 `orders.read` 与 `field.buyer`，请求体 `{ reason }`（至少 2 个字），返回 `{ state: OK|EXPIRED|NOT_SYNCED, buyer, expiresAt, note }`；每次成功都写审计 `ORDER_BUYER_PII_VIEWED`（含理由，**不含任何买家明文**），`sensitiveResponse` 让幂等记录也不保存响应体；解密只发生在 `SecretBoxService.openBuyerPii` 一处（`architecture.test.ts` 限定只有订单模块的 `orders-pii.service.ts` 能调用，P1-24 原有的“API 不解密买家信息”约束改为“只有这一个口子”）。前端明文只放在组件状态里，60 秒后自动隐藏，不进请求缓存。

> **P2b-03 实现说明（CR-041）**：赔付中心冻结的 7 条路由全部实现，另新增 5 条（冻结表里没有）：`POST /reimbursements/opportunities/:id/ignore`（忽略，body `{ version, reason }`，原因必填）、`POST /reimbursements/opportunities/:id/restore`（恢复为待处理）、`POST /reimbursements/:id/attachments`、`POST /reimbursements/:id/attachments/confirm`、`GET /reimbursements/:id/attachments/:attachmentId/download`（案件证据附件，复用采购模块的签名直传，`entityType = REIMBURSEMENT_CASE`，上传需 `reimbursements.write`、下载需 `reimbursements.read`）。静态路径（`opportunities`、`stats`）排在 `:id` 之前，权限检查先于参数校验。`GET /reimbursements/opportunities` 与 `GET /reimbursements` 都是游标分页（机会按发现时间倒序、案件按创建时间倒序，响应 `pageInfo`）：机会可按 `rule`、`status` 筛选，案件可按 `tab`（`pending`/`processing`/`paid`/`rejected`/`all`）、`rule`、`status`、`ownerId` 筛选；没有数据时 `state = NO_DATA` 并带 `note`。机会行含规则中文名、`connected`（费用多收尚未接入，恒为 false）、店铺、SKU、数量、`estimatedAmount`（= 数量 × 当前生效单件商品成本；没有商品成本为 null，页面写“无商品成本，无法估算”，不是 0）、截止日、证据引用、已生成的案件。`POST /reimbursements`：只有“待处理”且规则已接入的机会可以立案；应收金额默认取估算金额，没有估算时可手填并必须同时给币种；同一机会只能立一个案件（`opportunityId` 唯一，并发抢占靠机会的版本号，失败 409）；案件编号 `PC-YYYYMMDD-XXXXX`；负责人默认当前用户，必须是在职成员。`PATCH /reimbursements/:id` 必须带 `version`（过期 409）：状态只能按 待提交→已提交→处理中→已批准/部分批准/已拒绝 流转，已拒绝可以重新提交；**不接受手工改成“已到账”，实收金额没有任何手填入口**（违规返回 409 `DATA_CONDITION_FAILED`）；批准与部分批准必须带批准金额，部分批准金额必须小于应收金额，已到账的案件金额不可再改；改状态时写 `submittedAt`、`decidedAt`，并写一条 `EntityEvent`（`REIMBURSEMENT_CASE`）。`GET /reimbursements/:id` 返回案件、识别依据原文、证据引用、附件、已匹配的官方赔付明细（最多 200 条，含匹配依据）、证据包（最多 20 个，含导出任务状态与是否可下载）、`nextStatuses`、`canWrite`、`supportCases`（P2b-04 之前固定 `NOT_CONNECTED`）；**响应里没有时间线数组**：状态变化写入了 `EntityEvent`，评论与关注走 `/comments`，把事件时间线展示出来留待后续包。`POST /reimbursements/:id/evidence-pack` 需要 `reimbursements.write` 与 `export.create`：先把证据清单快照落库（`EvidencePack`），再通过导出中心创建 `reimbursement-evidence` 导出任务并回填 `exportJobId`，导出任务创建失败时撤掉清单。`GET /reimbursements/stats`：按状态的案件数、待处理机会数、回收率（按币种，实收 ÷ 应收，只算已提交且填了应收的案件）、平均到账时长、各类机会成功率、未归属赔付、时限设置（`windows`、`windowsDefault`、`windowsVersion`）；案件超过 2 万个时不计算并说明。时限设置存企业设置 `reimbursement.windows`，走 `GET/PUT /settings/preferences`（修改需 `settings.write` 与原因）。

> **P2b-02 实现说明（CR-040）**：退货共 4 条路由：`GET /returns`、`/returns/analysis`、`/returns/awaiting`（**冻结表里没有，本包新增**）、`/returns/:id`；静态路径排在 `:id` 之前，权限检查先于参数校验与查询。**`/returns` 为游标分页**（只按退货日期排序，响应 `pageInfo`；坏游标 400，参数错误 422）。查询参数：全局范围参数加 `q`（订单号前缀或退货件编号完全匹配）、`asin`、`sku`、`reason`（报告原因代码，不分大小写）、`disposition`（`SELLABLE`/`DAMAGED`/`CARRIER_DAMAGED`/`WAREHOUSE_DAMAGED`/`DEFECTIVE`/`EXPIRED`，按报告详细处置原值归并后筛选；“其他”与“处置未知”不能筛选）、`refunded`（先找出有退款交易的订单号再套用，上限 5000，超出时 `filterLimited=true`）。不带日期范围默认最近 90 天（按退货日期、企业时区），响应 `range` 写明实际范围与 `defaulted`；没有退货时 `state = NO_DATA` 并带 `note`。每行含订单号、`orderId`（订单已同步才有）、退货日期、商品、数量、原因（代码与中文）、`disposition`（分组、中文、是否可售、报告原值）、运营中心、退货件编号、`refund`（**订单口径**：同一订单有多个商品时是整个订单的退款；没有任何财务交易是 `PENDING_DATA`，不是“无退款”）、`receipt`（退款与收到退货的先后：`PENDING_DATA`/`NO_REFUND`/`RECEIVED_AFTER_REFUND`/`REFUNDED_AFTER_RECEIPT`）、`reimbursement`（`NOT_REVIEWED` 显示“尚未核查”，P2b-03 回填案件）；**列表不含买家备注**。`/returns/:id` 返回订单与商品、原因、**买家备注文本（只在详情，页面默认隐藏）**、处置、退款交易与退货相关费用、同单其他退货、赔付状态、处理时间线（下单、退款入账、仓库处理退货、同步入库）；不在成员数据范围内或不存在返回 404。`/returns/awaiting`：订单第一笔退款入账已满 30 天（默认值，设置页在 P2b-03）、而退货报告里没有该订单任何退货记录的订单，按退款早到晚排，最多 200 行，触到上限时 `truncated=true`；响应的 `basis` 写明口径，这是待核实清单，不是赔付结论。`/returns/analysis`：整体与退货件数前 5 个 ASIN 的趋势（范围不超过 120 天按周、更长按月）、按 ASIN 前 20 与按原因的排行；退货率 = 退货件数（按退货日期）÷ 销售件数（`AsinDailySummary.units`），没有销售汇总时为 `null`（页面写“尚无记录”，不是 0%）；与评论主题的交叉分析 `reviewCross` 固定为 `NOT_CONNECTED`（P4-13）；趋势明细最多读 20000 行，超出时 `truncated=true`。`GET /products/:id/returns`（ASIN 360 退货页签）仍未做（P2b-17）。

## 十一、广告

所有广告写接口：先经权限与对应开关，再调用 `POST /ads/preview` 得到影响预览，修改后自动生成前后对照。

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/ads/overview` | `ads.read` | `ScopeQuery` + `granularity`（日、周、月，默认日；P3-05 已实现） | 控制台指标、图表、指标树归因 | — | — | — | — | — |
| GET | `/ads/today` | `ads.read` | `ScopeQuery`（只有全局范围参数；P3-06 已实现，CR-061） | 见下方“P3-06 实现说明”；数据流未接入时 `streamState = NOT_CONNECTED`，各块写“尚未接入”，并退化返回最近一天的日汇总 `fallback` | — | — | — | — | — |
| GET | `/ads/campaigns` | `ads.read` | `AdsCampaignListQuery`（范围参数 + 名称与“包含/不包含”、广告产品、状态、广告组合、标签、负责人、异常筛选 + `sort=字段:方向`；P3-07 已实现，CR-062） | 活动列表（游标；指标来自广告日汇总，只含美元活动） | — | — | — | — | 游标 |
| PATCH | `/ads/campaigns` | 见右侧 | `AdsWriteBatchBody`（`{ ops: [{ kind, entityId, state/amount/strategy/placement }] }`，最多 50 项，整批全有或全无；P3-17 已实现，CR-072） | 批量暂停、启用、改预算、改竞价策略、改广告位调整；按变更类型分别校验：状态 `ads.campaign.write`、预算 `ads.budget.write`、竞价 `ads.bid.write`、广告位 `ads.placement.write`；返回 `{ runs, state: 'QUEUED' }`，只表示已排队 | 按类型：`sw.ads.status`、`sw.ads.budget`、`sw.ads.bid`、`sw.ads.placement` | 影响 | 是 | — | — |
| PATCH | `/ads/campaigns/meta` | `ads.campaign.write` | `AdsCampaignMetaBody`（每个活动带 `version`；标签 ADD/REMOVE/SET；负责人可为 null）（P3-07 新增，CR-062） | 批量设置标签与负责人（**只改本系统，不写亚马逊**；整批全有或全无；审计 `ADS_CAMPAIGN_META_UPDATED`） | — | — | 是 | — | — |
| GET | `/ads/campaigns/:id` | `ads.read` | `ScopeQuery` | 活动身份区、关键指标、建议规则与页签清单（P3-07 已实现，CR-062；范围外与不存在都是 404） | — | — | — | — | — |
| GET | `/ads/campaigns/:id/trend` | `ads.read` | `ScopeQuery` | 表现趋势 | — | — | — | — | — |
| GET | `/ads/campaigns/:id/hourly` | `ads.read` | `ScopeQuery` | 分时表现热力图 | — | — | — | — | — |
| GET | `/ads/campaigns/:id/ad-groups` | `ads.read` | `CursorQuery` | 广告组 | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/targets` | `ads.read` | `CursorQuery` | 投放对象 | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/search-terms` | `ads.read` | `CursorQuery` | 搜索词 | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/products` | `ads.read` | `CursorQuery` | 广告商品与库存状态 | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/placements` | `ads.read` | `ScopeQuery` | 广告位表现与调整 | — | — | — | — | — |
| GET | `/ads/campaigns/:id/creatives` | `ads.read` | — | 创意与着陆页（仅品牌推广与展示型推广） | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/audiences` | `ads.read` | — | 受众（仅展示型推广） | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/history` | `ads.read` | `CursorQuery` | 预算与竞价历史 | — | — | — | — | 游标 |
| GET | `/ads/campaigns/:id/forecast` | `ads.read` | `ForecastQuery` | 官方活动预测 | — | — | — | — | — |
| GET | `/ads/campaigns/:id/recommendations` | `ads.read` | — | 官方推荐列表与采纳记录 | — | — | — | — | 游标 |
| POST | `/ads/recommendations/:id/adopt` | 按推荐类型 | `AdoptBody` | 采纳推荐（等同对应写操作）（补） | 按类型 | 影响 | 是 | — | — |
| POST | `/ads/recommendations/:id/dismiss` | `ads.campaign.write`（CR-062：复用已有权限，没有新增点） | `{ reason }`（至少 2 个字） | 忽略推荐并记录（只改本系统状态，不写亚马逊；P3-07 已实现） | — | — | 是 | — | — |
| GET | `/ads/ad-groups/:id` | `ads.read` | — | 广告组身份区 | — | — | — | — | — |
| PATCH | `/ads/ad-groups/:id` | `ads.bid.write`（改默认竞价）或 `ads.campaign.write`（暂停、启用） | `AdsWriteBodySchema`（`{ kind: AD_GROUP_BID/AD_GROUP_STATE, amount/state }`，对象编号在路径里；**没有 `VersionBody`**，写入以亚马逊为准、本地回写在确认之后；P3-17 已实现，CR-072） | 修改 | `sw.ads.bid` 或 `sw.ads.status` | 影响 | 是 | — | — |
| GET | `/ads/ad-groups/:id/{trend,targets,search-terms,products,negatives,hourly,history}` | `ads.read` | `ScopeQuery`/`CursorQuery` | 广告组 7 个页签数据（补） | — | — | — | — | 游标 |
| GET | `/ads/targets/:id` | `ads.read` | — | 投放对象身份区、建议竞价区间 | — | — | — | — | — |
| PATCH | `/ads/targets/:id` | `ads.bid.write`（调价）或 `ads.campaign.write`（暂停、启用） | `AdsWriteBodySchema`（`{ kind: TARGET_BID/TARGET_STATE, amount/state }`；P3-17 已实现，CR-072） | 调价（先预览）、暂停 | `sw.ads.bid` 或 `sw.ads.status` | 影响 | 是 | — | — |
| GET | `/ads/targets/:id/{trend,search-terms,placements,hourly,bid-history,brand-analytics}` | `ads.read` | `ScopeQuery` | 投放对象 6 个页签数据（补） | — | — | — | — | — |
| POST | `/ads/negatives` | `ads.negative.write` | `AdsWriteBodySchema`（`{ entityId: 活动或广告组编号, level, text, matchType: NEGATIVE_EXACT/NEGATIVE_PHRASE }`，返回 200；P3-17 已实现，CR-072） | 添加否定投放；**本系统不写本地行（没有否定投放的同步器），要等下次同步才出现** | `sw.ads.negative` | 影响 | 是 | — | — |
| GET | `/ads/negatives` | `ads.read` | `AdTermListQuerySchema`（P3-10 已实现，CR-065） | 否定词库（补）；等同 `GET /ads/terms?tab=negatives`，见下方“P3-10 实现说明” | — | — | — | — | 游标 |
| POST | `/ads/keywords` | `ads.keyword.write` | `AdsWriteBodySchema`（`{ entityId: 广告组编号, text, matchType: EXACT/PHRASE/BROAD, amount? }`，返回 200；P3-17 已实现，CR-072） | 添加关键词（品牌分析"加入投放"的入口未做）；**不写本地行，下次同步才出现** | `sw.ads.keyword` | 影响 | 是 | — | — |
| POST | `/ads/preview` | `ads.read` + 对应写权限 | `AdsWriteBatchBody`（P3-17 已实现，CR-072；返回 200，不写审计） | 统一的写前预览：逐项修改前后值与变化幅度、提醒、开关状态、`canSubmit` 与原因；改预算时附带本系统已保存的官方活动预测（没有就写原因）；**“预计节省”未做**；只读本系统数据、不调用亚马逊 | — | 影响 | 是 | — | — |
| GET | `/ads/writes` | `ads.read` | — | 广告写入记录与各类写入当前可用性（P3-17 新增，CR-072）：`kinds[]`（权限、开关）与最近 50 条 `runs[]`（手动、自动规则、分时策略；状态排队中/执行中/已完成/失败，失败写原因） | — | — | — | — | — |
| GET | `/ads/products` | `ads.read` | `AdsProductListQuery`（P3-09 已实现，契约名 `AdsAsinListQuerySchema`，CR-064） | 按 ASIN 汇总的广告；见下方“P3-09 实现说明” | — | — | — | — | 游标 |
| PATCH | `/ads/products` | `ads.campaign.write` | `AdsProductBatchBody` | 按 ASIN 批量暂停或启用（补）；**P3-09 未实现（404），随 P3-17** | `sw.ads.status` | 影响 | 是 | — | — |
| POST | `/ads/products/copy` | `ads.campaign.write` | `AdsProductCopyBody` | 复制到其他广告组（补）；**P3-09 未实现（404），随 P3-17** | `sw.ads.status` | 影响 | 是 | — | — |
| GET | `/ads/terms` | `ads.read` | `AdTermListQuerySchema`（P3-10 已实现；`tab` 取 `targets`、`search-terms`、`negatives`、`quadrant`，词根分析走下面的独立接口） | 词级列表与异常分组；服务端库内汇总 | — | — | — | — | 游标 |
| GET | `/ads/terms/detail` | `ads.read` | `AdTermDetailQuerySchema`（P3-10 已实现，参数 `term`） | 词级分析：趋势、投放关系、同文字的投放与否定记录、规则建议、历史调价与效果；品牌份额 `brand`（**P4-04 已接入，CR-079**：需另有 `analytics.brand.read`，没有权限或该词没有品牌分析记录时为 `null`，页面不显示该块） | — | — | — | — | — |
| GET | `/ads/terms/roots` | `ads.read` | `AdTermRootsQuerySchema`（P3-10 已实现） | 词根分析：跨店铺词频与词形还原（补；词形还原是英文单复数的规则还原，不是词典） | — | — | — | — | 游标 |
| GET | `/ads/portfolios` | `ads.read` | `CursorQuery`（P3-11 已实现，契约名 `AdsPortfolioListQuerySchema`，CR-066） | 广告组合列表与预算节奏；见下方“P3-11 实现说明” | — | — | — | — | 游标 |
| POST | `/ads/portfolios` | `ads.portfolio.write` | `AdsPortfolioBody` | 设置组合预算与预算规则；**P3-11 未实现（404），随 P3-17** | `sw.ads.budget` | 影响 | 是 | — | — |
| GET | `/ads/portfolios/:id` | `ads.read` | — | 组合详情：节奏图、预算分配、预算规则（补）；P3-11 已实现，`:id` 是 `AdsPortfolio` 系统编号 | — | — | — | — | — |
| PATCH | `/ads/portfolios/:id` | `ads.portfolio.write` | `AdsPortfolioUpdateBody` + `VersionBody` | 修改（补）；**P3-11 未实现（404），随 P3-17** | `sw.ads.budget` | 影响 | 是 | — | — |
| GET | `/ads/dayparting` | `ads.read` | `ScopeQuery`（P3-12 已实现，只认全局范围参数） | 热力图、策略列表、执行记录与可选账户；见下方“P3-12 实现说明” | — | — | — | — | — |
| POST | `/ads/dayparting` | `ads.rule.write` | `DaypartingBody`（P3-12 已实现，`dayparting-query.ts`） | 创建策略，**只保存在本系统**（调度执行与写亚马逊随 P3-17） | `sw.ads.dayparting.run`（执行时，P3-17 才用） | 影响 | 是 | — | — |
| PATCH | `/ads/dayparting/:id` | `ads.rule.write` | `DaypartingUpdateBody`（含 `version`，P3-12 已实现） | 修改、启停、基准值，**只改本系统里的策略** | `sw.ads.dayparting.run`（执行时，P3-17 才用） | 影响 | 是 | — | — |
| POST | `/ads/dayparting/:id/simulate` | `ads.read` | — | 策略效果模拟（模型估算标注）（补）；P3-12 已实现，只读，不写审计，仍要幂等键 | — | — | — | — | — |
| GET | `/ads/rules` | `ads.read` | `ScopeQuery`（P3-13 已实现，只认全局范围参数，不分页，最多 200 条） | 规则列表、可选账户、自动模式是否可选、执行未接入说明；见下方“P3-13 实现说明” | — | — | — | — | — |
| POST | `/ads/rules` | `ads.rule.write` | `AdsRuleBody`（条件、动作、频率、范围、护栏、模式） | 创建（P3-13 已实现，**只保存在本系统**）；自动模式需 `sw.ads.rule.run` 开启，没开返回 409 `WRITE_SWITCH_OFF`，不悄悄降级 | `sw.ads.rule.run`（执行时） | 影响 | 是 | — | — |
| GET | `/ads/rules/:id` | `ads.read` | — | 规则详情与规则质量（补；P3-13 已实现） | — | — | — | — | — |
| PATCH | `/ads/rules/:id` | `ads.rule.write` | `AdsRuleUpdateBody` + `VersionBody` | 修改（P3-13 已实现，带 `version`，**只改本系统里的规则**） | `sw.ads.rule.run`（执行时） | 影响 | 是 | — | — |
| POST | `/ads/rules/:id/dry-run` | `ads.rule.write` | `DryRunBody` | 试运行：历史数据模拟命中对象与动作（P3-13 已实现；**只读，不写审计、不生成待办**，权限实际取 `ads.read`，见下方说明） | — | — | 是 | — | — |
| GET | `/ads/rules/:id/runs` | `ads.read` | `CursorQuery` | 执行记录与前后对照（补；P3-13 已实现，`cursor`、`pageSize`） | — | — | — | — | 游标 |
| GET | `/ads/changes` | `ads.read` | `AdsChangeQuery`（来源：手动、自动规则、分时策略、外部变更；P3-13 之后的 P3-14 已实现，`source`、`entityType`、`adsProfileId`、`q`、`from`、`to`、`cursor`、`pageSize`） | 变更记录；各来源条数、快照新鲜度、写入未接入说明；见下方“P3-14 实现说明” | — | — | — | — | 游标 |
| GET | `/ads/changes/:id/compare` | `ads.read` | — | 前后对照（补；P3-14 已实现） | — | — | — | — | — |
| GET | `/ads/reports` | `ads.read` | `AdsReportListQuery`（`status`、`source`、`templateKey`、`adsProfileId`、`cursor`、`pageSize`；P3-15 已实现） | 报告任务列表（新报告接口任务与旧版任务一起，含失败原因、导入行数、警告、能否重试、各状态条数）；见下方“P3-15 实现说明” | — | — | — | — | 游标 |
| POST | `/ads/reports` | `ads.report` | `AdsReportCreateBody`（`profileId`、`templateKey`、`adProduct`、`from`、`to`；P3-15 已实现，**不再接受旧的 `reportType`**） | 创建报告任务（202，只排任务；时间范围按粒度检查，失败 422 `ADS_REPORT_WINDOW`） | — | — | 是 | — | — |
| POST | `/ads/reports/:id/retry` | `ads.report` | — | 失败重试（补；P3-15 已实现，202；只有新报告接口的失败任务能重试，每个失败任务只能重试一次） | — | — | 是 | — | — |
| POST | `/ads/reports/backfill` | `ads.report` | `AdsReportBackfillBody`（`profileId`、`adProduct`、`months`） | 历史回补（补；P3-15 已实现，202）：从今天往前取 N 个月的活动日报，按 120 天切片各建一个任务 | — | — | 是 | — | — |
| GET | `/ads/report-templates` | `ads.read` | — | 模板库（补；P3-15 已实现）：8 个模板、可选广告档案（可用与否及原因）、历史可用起点 | — | — | — | — | — |
| GET | `/ads/metrics` | `ads.read` | `AdsMetricsQuery`（`dataset`、`dims`、`metrics`、`grain`、`adProduct`、`adsProfileId`、`sort`、`cursor`、`pageSize`；P3-15 已实现） | 自由分析结果：在 8 个已入库数据集里组合维度与指标；见下方“P3-15 实现说明” | — | — | — | — | 游标 |
| GET | `/ads/parity` | `ads.read` | — | 迁移期新旧接口核对总览（补；P3-15 已实现，只读） | — | — | — | — | — |
| POST | `/ads/parity/run` | `ads.report` | `AdsParityRunBody`（`profileId`） | 手动触发一次核对（补；P3-15 已实现，202，只排任务） | — | — | 是 | — | — |
| GET | `/ads/parity/:runId/diffs` | `ads.read` | — | 一次核对的差异明细（补；P3-15 已实现，未解释的排最前，最多 200 行） | — | — | — | — | — |

> **P3-06 实现说明（CR-061）**：`GET /ads/today` 先 `authorizeScoped(ads.read)` 再校验范围参数。响应 `AdsTodayResponse`（`packages/api-contracts/src/ads-today.ts`）：`streamState`（`LIVE` 接收端已配置且今日有小时指标 / `NOT_CONNECTED` 接收端未配置（14.10）/ `NO_DATA` 已配置但今天还没有）、`note`、`updateNote`（固定的更新节奏说明：花费与点击最快 15 分钟，转化滞后数小时）、`businessDate`（企业时区的今天）、`asOf`（小时指标最近更新时刻）、`currency = USD`、`otherCurrencies`（非美元花费，不折算）、`totals{state, note, value, yesterdaySameHour}`（今日花费、点击、曝光、单次点击成本、广告销售额、订单；昨日同时段对比）、`fallback`（非 `LIVE` 时退化返回的最近一天日汇总：`summaryDate`、`totals`、`refreshedAt`；没有日汇总为 `null`）、`hours{state, note, items[24], historyDays}`（逐小时花费、点击；没有指标行的小时为 `null` 不是 0；`band` 是过去 14 天同一小时的下限与上限，同时段样本少于 3 天不给）、`budget`（带日预算的启用中美元活动：日预算、今日花费、进度、预计耗尽时间，**线性外推的估算**）、`outOfBudget`（活动管理接口里投放状态含 `OUT_OF_BUDGET` 的启用中活动，**不是实时**）、`anomalies`（单次点击成本突增、花费突增但今天没有转化，规则写在 `rules`）、`stockout`（近 3 天有花费、而最近一次库存快照可售为 0 的 ASIN，**日级快照，不是实时库存**）、`truncated`（活动级读取是否被 5000 上限截断）。小时指标与活动对应靠“广告档案 + 活动编号”（小时指标没有广告产品，同档案内活动编号重复的活动不计入预算与花费）。**接收端是否配置看环境变量 `AMAZON_ADS_STREAM_SINK`（本包自定名，未写入 `.env.example`）**；没配置时不查小时表，一律“未接入”。没有同步器写 `AdsPerformanceHourly`、`AdsAdvertisedProductMetric`，生产里多数块会是“尚无记录”或“尚未接入”。

> **P3-07 实现说明（CR-062）**：列表 `GET /ads/campaigns` 响应 `AdsCampaignListResponse`（`packages/api-contracts/src/ads-campaigns.ts`）：`items[]`（`id` 是系统编号 `AdsCampaign.id`、`externalCampaignId`、`totals`（范围内合计，没有汇总行或非美元活动为 `null`，不是 0）、`ratios`、`adsShare`、`budgetUtilization`（估算）、`anomaly`、`tags`、`ownerId`、`version`）、`pageInfo`（偏移游标，签名并绑定全部查询条件，换条件复用返回 400）、`range`（未选日期时默认最近 30 天，`defaulted = true`）、`filterOptions`、`members`（只有可写者返回）、`canWrite`、`avgOverBudget`（恒 `NOT_CONNECTED`）、`write`（写亚马逊的动作 `NOT_CONNECTED`，随 P3-17）、`truncated`、`metricsTruncated`。排序字段白名单：花费、销售额、订单、ACoS、ROAS、点击率、单次点击成本、转化率、预算、名称、最近同步；空值永远排最后。详情 `AdsCampaignDetailResponse`：`identity`、`metrics`（≤6 项关键指标，带对比）、`advice`（4 条规则，状态 `HIT`/`NO_HIT`/`NOT_CONNECTED`）、`tabs`（按广告产品过滤：创意只有品牌推广与展示型推广，受众只有展示型推广，其余产品访问这两个接口 404）。页签接口列表型用游标（每页 1 至 200）、`status` 与 `q` 筛选；搜索词页签的“已投放/已否定”只认完全相同（不分大小写与空格）；`hourly` 在 `AMAZON_ADS_STREAM_SINK` 未配置时 `NOT_CONNECTED`；`history` 里亚马逊侧的预算与竞价变更是 `NOT_CONNECTED`（没有同步器）。`PATCH /ads/campaigns/meta` 校验顺序：权限 → 参数（422）→ 负责人在职（409）→ 活动存在且在范围（404，整批）→ 标签合法（409）→ 事务内逐个 `updateWithVersion`（冲突 409）。写亚马逊的批量动作（冻结的 `PATCH /ads/campaigns`）未实现，归 P3-17。

> **P3-08 实现说明（CR-063）**：`GET /ads/ad-groups/:id`（响应 `AdsGroupDetailResponse`：`identity`（含 `campaign` 视图，活动未同步时 `id = null`）、`metrics`（范围内合计、对比期、比率）、`tabs`、`write`）与 `GET /ads/targets/:id`（`AdsTargetDetailResponse`：`identity` 含 `suggestedBid` 区间 `{ low, high, point, receivedAt }`、所属 `adGroup` 与 `campaign`）；`:id` 是系统编号（投放对象先按关键词表、再按投放表找）。权限 `ads.read` 先于参数校验，范围外与不存在都是 404。广告组页签路径 `{trend,targets,search-terms,products,negatives,hourly,history}`（`history` 页面名为“操作记录”），投放对象页签路径 `{trend,search-terms,placements,hourly,bid-history,brand-analytics}`；列表型（`targets`、`search-terms`、`products`、`negatives`）用 P3-07 的游标（每页 1 至 200，换条件复用 400）与 `q`、`status` 筛选；`trend`、`hourly` 与活动同形；`brand-analytics` 只有关键词类，其余类型 404；`placements` 恒 `NOT_CONNECTED`（广告位报告只到活动级）；`bid-history` 返回 `current`（竞价与建议区间）、`changes`（读 `EntityEvent`：`entityType = ADS_TARGET`、`kind = ads.target.bid`、`detailJson = { before: { bid }, after: { bid } }`，每条带调价前后各 7 天的合计与比率，调价当天不计，窗口里没有指标是 `totals = null`）、`amazonSide`（恒 `NOT_CONNECTED`）、`write`。**`PATCH /ads/ad-groups/:id`、`PATCH /ads/targets/:id` 没有实现，随 P3-17**；调价事件的写入也随 P3-17，必须按上面的格式写。P3-07 的 `AdsAdGroupRow`、`AdsTargetRow` 新增必填 `id`（系统编号）。

> **P3-09 实现说明（CR-064）**：`GET /ads/products`（权限 `ads.read` 先于参数校验；参数：全局范围、`q`（匹配 ASIN 或商品名称）、`stock`（`OUT_OF_STOCK`/`IN_STOCK`/`UNKNOWN`）、`sort`（`spend`、`sales`、`orders`、`acos`、`roas`、`adsShare`、`organicSales`、`totalSales`、`campaigns`、`asin`，默认 `spend:desc`，空值永远排最后）、`cursor`、`pageSize`；未知参数 422，换条件复用旧游标 400）。响应 `AdsAsinListResponse`（`packages/api-contracts/src/ads-products.ts`；类型叫 `AdsAsin*` 是因为 `AdsProductRow` 已被“广告产品（商品推广、品牌推广、展示型推广）”占用）：`items[]` 每行是一个**店铺 × ASIN**（`key`、`asin`、`title`、`storeId`、`totals`（被推广商品日报表合计，美元）、`ratios`、`totalSales`（该 ASIN 在该店铺的全部销售额，读 `AsinDailySummary`，没有行或广告账户未绑定店铺为 `null`）、`adsShare`（花费 ÷ 全部销售额）、`organicSales`（全部销售额 − 广告销售额；**广告销售额大于全部销售额时为 `null` 并带 `organicIssue = ATTRIBUTION_EXCEEDS_TOTAL`**，不夹成 0）、`haloSales`（转化商品日报表里 `isHalo` 的销售额；有转化商品行但没有光环行为 0，完全没有行为 `null`）、`campaigns`（推广它的活动数，按“广告档案 × 活动编号”去重）、`ads`（广告表里该 ASIN 的 `{ enabled, total }`，没有行为 `null`）、`stock`/`sellable`/`snapshotDate`（最近一次接口库存快照，同 ASIN 多 SKU 相加）），同一店铺下多个广告档案推广同一 ASIN 合成一行；`summary`（过滤后全部行的商品数、花费、广告销售额、断货商品数与其花费）、`halo`（转化商品日报表在可见范围里一行都没有时 `NOT_CONNECTED`）、`profit`（恒 `NOT_CONNECTED`，广告分摊在 P3-16）、`organicBasis`、`write`（恒 `NOT_CONNECTED`，随 P3-17）、`truncated`（“店铺 × ASIN”超过 3000，只处理花费最高的）、`metricsTruncated`（报表分组超过 19,999）。只读被推广商品日报表里 `currency = USD` 且花费不为空的行；非美元行不并入，页面说明里披露。

> **P3-10 实现说明（CR-065）**：词级中心的 4 条只读路由，权限 `ads.read` 先于参数校验，数据范围走 `adsRelationWhere`。契约在 `packages/api-contracts/src/ad-terms.ts`（常量与类型）、`ad-terms-math.ts`（纯函数）、`ad-terms-query.ts`（zod，单独成文件）。**聚合都在数据库里做**：词级报表（`AdsTermMetric`，`level = KEYWORD` 是投放层、`SEARCH_TERM` 是搜索词层）按词 `groupBy`，只读美元且 `cost` 不为空的行，最多读 19,999 个分组（多读一行判断是否截断，响应 `truncated`）；旧 `GET /analytics/ad-terms` 的内存截断下线。
> - `GET /ads/terms`：参数 全局范围、`tab`（缺省 `search-terms`）、`q`（词包含，不分大小写）、`anomaly`（`HIGH_SPEND_NO_ORDER`、`SCALE_UP`、`ADD_KEYWORD`、`NEGATIVE_CANDIDATE`）、`status`（`TARGETED`/`NEGATED`/`UNTARGETED`，只适用于 `search-terms`）、`level`（`CAMPAIGN`/`AD_GROUP`，只适用于 `negatives`）、`matchType`（文字，不分大小写，适用于 `targets`、`negatives`）、`subject`（`search-terms`/`targets`，只适用于 `quadrant`）、`sort`（`field:dir`，字段 `spend`、`sales`、`orders`、`clicks`、`impressions`、`acos`、`roas`、`cvr`、`cpc`、`ctr`、`term`，默认 `spend:desc`，空值排最后；否定词库只认 `term`，默认 A 到 Z）、`cursor`、`pageSize`。**不适用于当前页签的筛选返回 422，不静默忽略**（`termFilterIssue`）；未知参数 422，换条件复用旧游标 400。`targets` 与 `search-terms` 响应带 `summary`（词数、合计、比率与每个异常分组命中的词数，计数在异常分组过滤之前）、`basis`、`write`；`search-terms` 另有 `undisclosedSpend`（被亚马逊合并成“其他”的花费，没有这类行为 `null`）与 `targetingNote`（关键词、投放、否定记录没同步或被截断时的说明，此时“未投放”不代表真的没有投放）；`negatives` 响应带 `total`；`quadrant` 响应是一次性的点集 `points`（花费最高的 200 个）、`counts`、`withoutSales`（有花费没广告销售额、画不出的词数与花费）、`spendLine`/`acosLine`、`total`/`truncated`。状态按**活动**逐个判断（与关键词、投放表达式、否定词文字完全相同；广告组级否定也算该活动已否定；否定优先于投放），再汇总到词：全部否定为 `NEGATED`，任一投放为 `TARGETED`，否则 `UNTARGETED`；广泛、词组匹配的命中不算。
> - 异常分组的阈值是自定默认值（`AD_TERM_RULES`，08 章只给了名字没给数，响应与页面都写明）：高花费无成交 = 花费不低于 20 美元、点击不少于 20 次、没有订单；可扩量 = 订单不少于 3 且广告成本销售比不高于 25%；可加词 = 未投放、订单不少于 2 且转化率不低于 10%；否定候选 = 未投放也未否定、点击不少于 10 次、花费不低于 5 美元、没有订单。各分组适用的页签见 `AD_TERM_ANOMALY_TABS`（高花费无成交不适用于四象限：没有订单就没有广告销售额，画不出）。
> - `GET /ads/terms/roots`：参数 全局范围、`q`（词根包含）、`sort`（上面的字段加 `terms`、`stores`）、游标；每行 `root`、`forms`（并进该词根的写法）、`terms`、`stores`、合计与比率、花费最高的 3 个 `examples`；响应 `termCount`（参与统计的不同搜索词数）。一个搜索词含几个词根，花费就分别计入每个，**词根之间不能相加**；拆词去掉常见虚词与 ASIN 样式的词，英文单复数按规则还原。
> - `GET /ads/terms/detail?term=`：词按文字不分大小写整串匹配（多余空格不合并）。响应 `status`、`campaigns`（出现、已投放、已否定的活动数）、`totals`/`ratios`、`anomalies`、`trend`（逐日，没有报表行的日期不补 0）、`relations`（投放词 → 搜索词，按活动与广告组，最多 200 行）、`targeting`（文字完全相同的关键词、投放表达式、否定词）、`advice`（`NEGATE`/`ADD_KEYWORD`/`LOWER_BID`/`RAISE_BID` 与依据）、`history`（读 `EntityEvent`：`ADS_TARGET` + `ads.target.bid`，最多看 5 个投放对象各 50 条，每条带调价前后各 7 天的合计；与 P3-08 同一格式）、`brand`（**P4-04 已接入，CR-079**：有 `analytics.brand.read` 且该词在品牌分析搜索查询表现里有记录时给搜索量、点击份额、购买份额、周期与更新时间，否则 `null`，页面不显示该块）。
> - `POST /ads/negatives`、`POST /ads/keywords` 写亚马逊，随“广告写入接入”（P3-17）；本包页面上的“添加否定”“添加为关键词”“调整竞价”“移除否定”按钮禁用并写明原因（取自响应里的 `write.note`），请求会 404。`GET /ads/negatives` 与 `GET /ads/terms?tab=negatives` 等价（路径里的 `tab` 若不是 `negatives` 返回 422）。

> **P3-11 实现说明（CR-066）**：广告组合与预算的 2 条只读路由，权限 `ads.read` 先于参数校验，数据范围走 `adsRelationWhere`（范围外与不存在都是 404）。契约在 `packages/api-contracts/src/ads-portfolios.ts`（常量与类型）、`ads-portfolios-math.ts`（纯函数：预算周期窗口、星期节奏权重、理想累计曲线、节奏判断、调整建议、排序汇总、规则参数摘要）、`ads-portfolios-query.ts`（zod，单独成文件）。
> - `GET /ads/portfolios`：参数 全局范围、`from`/`to`（只影响“范围内”的关键指标；预算节奏按各组合自己的周期算，与日期范围无关）、`q`（组合名称包含）、`pace`（`AHEAD`/`ON_TRACK`/`BEHIND`）、`sort`（`name`、`budget`、`spent`、`paceRatio`、`campaigns`、`spend`、`sales`、`acos`、`roas`，默认 `spend:desc`，空值永远排最后）、`cursor`、`pageSize`；未知参数 422，换条件复用旧游标 400。每行（`AdsPortfolioRow`）：`budget`（上限、周期类型 `MONTHLY`/`DATE_RANGE`/`UNKNOWN`、起止日）、`spent` 与 `spentSource`（`REPORTS` 是广告日汇总里组合下全部美元活动截至昨天的花费；没有汇总行时退回亚马逊同步来的已用金额，来源 `PORTFOLIO`）、`pace`（`state` 为 `OK` 才有 `verdict`/`ratio`/`idealSpent`；算不出时 `NO_BUDGET`/`UNKNOWN_PERIOD`/`OTHER_CURRENCY`/`NO_SPEND_DATA`/`NOT_STARTED` 并写原因）、`campaigns`（启用中与全部）、`totals`/`ratios`（所选范围内的美元合计，非美元组合为 `null`）；响应另有 `summary`（偏快、正常、偏慢各几个，预算上限与已用合计）、`paceBasis`（口径原文）、`write`（写入暂未接入的说明）、`truncated`、`metricsTruncated`。
> - `GET /ads/portfolios/:id`：响应 `AdsPortfolioDetailResponse`：`row`、`curve`（整个预算周期逐日 `ideal`/`actual`/`daily`，今天及以后没有实际；没有逐日汇总时实际整条为 `null`）、`advice` 与 `adviceNote`（偏快：按近 7 天日均估算会不会提前用完；偏慢：看启用中日预算合计是否低于剩余预算每天可花；已达上限；没有建议时写原因）、`allocation`（各活动的日预算占比与统计区间内花费占比，`period.basis` 为 `BUDGET_PERIOD` 或周期未知时的 `SELECTED_RANGE`）、`rules`（预算规则，见下）。
> - **预算规则是测试版资源**：统一接口里的规则资源仍是 beta（`verification-log.md` 第 10 节），读取由环境变量 `ADS_BUDGET_RULES_BETA`（`1`/`true`/`on`/`yes`）控制，默认关闭，关闭时 `rules.state = DISABLED` 只给说明；打开后读 `AdsBudgetRule`（目前没有同步器写这张表，所以是“尚无记录”）。
> - 节奏口径（自定默认值，不是亚马逊口径，`ADS_PORTFOLIO_PACE_RULES`）：偏差不超过 ±10% 算正常；理想曲线用最近 56 天花费的**星期分布**（只有日级数据，没有小时节奏），不足 14 天按天均摊；只比较到昨天；实际花费只认美元活动级日汇总行。
> - `POST /ads/portfolios`、`PATCH /ads/portfolios/:id` 写亚马逊，随“广告写入接入”（P3-17），本包没有实现（请求会 404）；页面上对应按钮禁用并写明原因。

> **P3-12 实现说明（CR-067）**：分时策略的 4 条路由。**策略只存在本系统里，保存与修改不会改变亚马逊账户；调度执行（每小时按取值写亚马逊）受写入开关 `sw.ads.dayparting.run` 控制，随 P3-17**，响应里的 `execution` 固定写明这一点。契约在 `packages/api-contracts/src/dayparting.ts`（常量与类型）、`dayparting-math.ts`（纯函数：取值校验 `gridIssue`、此刻应执行 `daypartingDueOf`、摘要、效果模拟 `simulateGrid`）、`dayparting-query.ts`（zod，单独成文件）。
> - 策略 = 一个广告档案（`adsProfileId`）+ 一组活动或广告组（`level` 为 `CAMPAIGN`/`AD_GROUP`，**没有投放对象粒度**）+ 168 个小时格的取值 `grid`（周一 0 点为第 0 格，按策略自己的 `timezone` 对应星期与小时）。`kind = BID_MULTIPLIER`：每格是竞价系数 0.1 至 3（最多两位小数），可带参考用的 `baseBid`（美元，目前不参与任何计算）；`kind = ON_OFF`：每格只能是 0（暂停）或 1（启用），不能带 `baseBid`。**全部格子都是 1（不会改变任何东西）不允许保存。** 状态 `ACTIVE`/`PAUSED`，创建默认 `PAUSED`。一个广告档案下策略名称唯一（重名 409）。
> - `GET /ads/dayparting`：权限 `ads.read` 先于参数校验。响应 `DaypartingListResponse`：`heatmap`（`state` 为 `NOT_CONNECTED`（营销数据流接收端没配置，环境变量 `AMAZON_ADS_STREAM_SINK`）/`NO_DATA`/`OK`；`cells` 是近 14 天范围内全部美元活动级小时指标按企业时区累计到“星期 × 小时”，没有行的格子不出现）、`strategies`（范围内最多 100 个，按名称升序，`truncated`；每行含 `targets`（系统编号与名称，已被同步删除的对象 `name` 为 `null`）、`summary`、`due`（此刻按策略时区应执行的值与文字）、`version`）、`runs`（最近 50 条执行记录，没有时 `NOT_CONNECTED` 并说明随 P3-17）、`profiles`（范围内可选的广告账户）、`canWrite`（有 `ads.rule.write`）、`execution`、`assumptions`。
> - `POST /ads/dayparting`（201）：权限 `ads.rule.write` 先于参数校验；广告档案在数据范围内才找得到（404），**作用对象必须全部在同一广告档案、同一层级、数据范围内，有一个找不到整批拒绝（404），什么也不保存**；时区取请求里的，其次广告档案自己的，最后企业时区；审计 `ADS_DAYPARTING_CREATED`（只存摘要，不存 168 个数）。
> - `PATCH /ads/dayparting/:id`：必须带 `version`（乐观锁，旧版本 409）并至少改一项；广告档案、策略类型、层级创建后不能改（要换就新建）；取值要按**该策略的类型**再校验一次（422，`fieldErrors.grid`）；审计 `ADS_DAYPARTING_UPDATED`（含修改前后摘要）。范围外、别的企业与不存在都是 404。
> - `POST /ads/dayparting/:id/simulate`（200）：权限 `ads.read`，只读不写库。用作用对象近 14 天的小时指标按“星期 × 小时”累计后逐格套用策略，响应 `baseline`（历史实际）与 `estimated`（按策略估算）、`coveredCells`、`changedCells`、`model`、`assumptions`。**这是模型估算，不是亚马逊的预测**：竞价系数 m 使点击量按 m 的 0.5 次方变化、单次点击成本按 m 变化，转化率与客单价不变；启停把暂停的格子整格归零，不考虑预算挪到别的时段（参数 `DAYPARTING_SIM_MODEL`，自定，未对真实店铺校准）。数据流没配置 `NOT_CONNECTED`、对象没有小时指标 `NO_DATA`，都不返回估算数字。

> **P3-13 实现说明（CR-068）**：自动规则的 6 条路由。**规则只存在本系统里，保存与修改不会改变亚马逊账户；命中只生成待办；自动执行（写亚马逊）受写入开关 `sw.ads.rule.run` 控制，随 P3-17**，响应里的 `execution` 固定写明这一点，在那之前自动模式的规则命中同样只生成待办（运行记录里写明）。契约在 `packages/api-contracts/src/ads-rules.ts`（常量与类型）、`ads-rules-math.ts`（纯函数：条件评估、动作前后值与护栏收窄）、`ads-rules-text.ts`（中文摘要、内容合法性、是否到期、执行后效果）、`ads-rules-query.ts`（zod，单独成文件）。
> - `GET /ads/rules`：权限 `ads.read` 先于参数校验。响应 `AdsRuleListResponse`：`rules`（范围内最多 200 条，按名称升序，`truncated`；每行含条件、过滤、动作、护栏、范围的中文摘要、最近一次定时评估的对象数与命中数、`version`）、`profiles`（可选的广告账户）、`canWrite`、`auto`（自动模式能不能选，`allowed=false` 时带原因）、`execution`。
> - `POST /ads/rules`（201）：权限 `ads.rule.write` 先于参数校验；广告账户在数据范围内才找得到（404）；**限定的活动必须都在同一广告账户与数据范围内，有一个找不到整批拒绝（404）**；内容整体合法才保存（动作要与层级相配：活动管暂停、启用、调日预算，投放词管调竞价、暂停、启用，搜索词管否定与加词；调整竞价或预算必须设置单次幅度上限，422）；`mode=AUTO` 要写入开关已开启（409 `WRITE_SWITCH_OFF`）；同一广告账户下重名 409；审计 `ADS_RULE_CREATED`（只存条件、动作、护栏的中文摘要）。
> - `PATCH /ads/rules/:id`：必须带 `version`（乐观锁，旧版本 409）；广告账户与对象层级创建后不能改；改动后的整体内容合并后再校验一次；从建议模式改成自动模式同样要开关（已经是自动模式的规则不因开关关闭而不能改别的项）；审计 `ADS_RULE_UPDATED`（含修改前后摘要）。范围外、别的企业与不存在都是 404。
> - `GET /ads/rules/:id`：规则与质量（`quality`）：最近一次评估的命中率、近 30 天运行记录数、待办采纳率（已处理 ÷ 已关闭，没有已关闭待办为 `null`）、**执行后效果（执行前后各 7 天对比，需要“已执行”的运行记录，在 P3-17 之前恒为 `NOT_CONNECTED`）**。
> - `POST /ads/rules/:id/dry-run`（200）：用规则现在的内容与库里的日级指标算一遍；**只读，不写审计、不生成待办、不改规则的评估统计**；权限实际取 `ads.read`（冻结写 `ads.rule.write`，试运行只读，所以放宽到只读成员，需你确认）；`asOf` 可选，默认昨天（按企业时区），晚于昨天返回 422；没有任何日指标返回 `NO_DATA`，不当作“没有命中”。命中最多返回 200 个、跳过最多 100 个，超出带 `truncated`；读取的对象或指标行数超限带 `incomplete`。动作前后值按“现在的对象状态、竞价、预算”算，历史上可能不同（响应里的 `caveats` 写明）。
> - `GET /ads/rules/:id/runs`：运行记录（时间倒序，签名偏移游标，`pageSize` 最大 100）；每条含对象、动作、前后值、触发时的指标取值、结果（已生成待办、已跳过、已执行、失败）、关联待办编号。

> **P3-14 实现说明（CR-069）**：变更记录的 2 条只读路由，权限 `ads.read`，没有写路由。契约在 `packages/api-contracts/src/ads-changes.ts`（常量、类型、每类对象追踪的字段表 `ADS_CHANGE_FIELDS`）、`ads-changes-math.ts`（纯函数：字段值规整、状态差异、是否本系统自己的写入）、`ads-changes-query.ts`（zod，单独成文件）。**外部变更由 worker 每 30 分钟对比广告实体快照识别；手动、自动规则、分时策略三类来源在广告写入接入（P3-17）之前没有任何程序写入，响应里的 `write` 固定写明这一点。**
> - `GET /ads/changes`：权限先于参数校验；范围走广告档案绑定的店铺（`adsRelationWhere`，未绑定店铺的档案只有“全部店铺”成员看得到）。筛选 `source`（`MANUAL`/`AUTO_RULE`/`DAYPARTING`/`EXTERNAL`）、`entityType`（`CAMPAIGN`/`AD_GROUP`/`TARGET`/`KEYWORD`/`PORTFOLIO`）、`adsProfileId`、`q`（对象名称或改前改后的值，不分大小写）、日期范围（`from`、`to`，缺省最近 30 天，按企业时区）。按发生时间倒序，签名偏移游标（绑定租户与全部查询条件，条件变了游标失效 400），`pageSize` 最大 200。响应：`items`（每行一个字段的一次变化：来源、对象类型与编号、对象名称、字段与中文名、改前、改后、发生时间、`sinceAt`、操作人、广告账户与店铺、详情页路径）、`counts`（四种来源各自条数，**按其他筛选条件算、不受 `source` 影响**）、`tracking`（范围内最近一次快照时间；一次都没有为 `NOT_CONNECTED`）、`write`、`externalNote`、`profiles`（可选的广告账户，最多 200 个）、`pageInfo`。`state`：有记录 `OK`；一条也没有时，没有快照且没有筛选条件为 `NOT_CONNECTED`（“尚未接入”），其余为 `NO_DATA`（“尚无记录”）。
> - 外部变更行：`occurredAt` 是检测到的时间，`sinceAt` 是上一份快照的时间（**只能确定改动发生在两者之间**）；没有操作人，页面写“未知（外部）”。手动变更的 `actorName` 是操作人姓名（已离开的成员写“已离开的成员”）。对象“新出现”是特殊字段 `__created`（改后放名称）。空值的 `before`/`after` 是 `null`，不是 0。
> - `GET /ads/changes/:id/compare`：同一对象、同一时刻、同一来源的这一批改动的前后对照。有该对象在变更时刻或之前的最近一份快照时 `basis = SNAPSHOT`，所有追踪字段都列出（改动的 `changed = true`，没改的显示快照里的值）；没有快照 `basis = CHANGE_ONLY`，只列被改的字段并在 `basisNote` 写明。`related` 是同一对象前后的其他变更（最近 10 条）。编号写法不合法、范围外、别的企业与不存在都是 404，不泄露存在性。
> - **定时评估（worker，无接口）**：每 30 分钟扫描一次，“已启用”且按执行频率（每天、每 3 天、每周）到期的规则评估一遍；命中对象生成待办（来源 `SYSTEM`、类型 `ADVERTISING`、对象类型 `ADS_RULE`、72 小时内到期，负责人是规则创建人或第一位有 `ads.rule.write` 的在职成员，没有则不建待办并记为跳过）并写运行记录、通知负责人；**已有未处理待办的“规则 + 对象 + 动作”不重复生成；24 小时内最多处理“每日执行次数上限”个对象，超出的按近 30 天花费从高到低取舍并记为跳过（最多记 50 条）；广告账户从没有日指标时不评估也不记录；单条规则出错不影响其他规则**。

> **P3-15 实现说明（CR-070）**：广告报表与广告指标共 9 条路由（5 读 4 写），写路由返回 **202**（只排任务，真正的取数在 worker 里）。契约在 `packages/api-contracts/src/ads-reports.ts`（8 个模板 `ADS_REPORT_TEMPLATES`、状态与来源、失败码说明、历史可用起点说明、`backfillWindowsOf`）、`ads-metrics.ts`（8 个数据集的可用维度与指标 `ADS_METRICS_DATASETS`、限制 `ADS_METRICS_LIMITS`）、`ads-metrics-math.ts`（纯函数：合计、请求检查、排序、导出行）；zod 在 `ads-reports-query.ts`、`ads-metrics-query.ts`（单独成文件）。**模板里的维度与指标名是按新报告接口的描述整理的，没有对真实账户验证过（集中在 `ADS_REPORT_TEMPLATES` 与 worker 的 `ads-reports/rows.ts`）。**

> **P3-16 实现说明（CR-071）**：没有新增接口，`/profit/ads` 的响应形状不变，`allocation.state` 在范围内有分摊结果时为 `ALLOCATED`，否则为 `NOT_ALLOCATED`；商品行 `adsAllocated` 为 null 表示“广告尚未分摊”（不是 0）。分摊在 worker 刷新 `ProfitDaily` 时完成（`apps/worker/src/profit/ads-allocation.ts`）：各 SKU 的 `adsSpendAllocated` 之和加店铺级行的 `adsUnallocated` 恰好等于账户当天的活动级总花费。规则取自财务口径 `adsAllocationMode`（按天取生效版本）。新增数据质量标记 `ADS_ATTRIBUTION_EXCEEDS`（报表归属超出总花费，已按比例缩小）与 `ADS_ASIN_UNMAPPED`（归属对不上 SKU，并入剩余）；`PROFIT_METRIC_VERSION` 为 `p3-16@1`。

> **P3-17 实现说明（CR-072）**：广告写入 7 条路由（`POST /ads/preview`、`GET /ads/writes`、`PATCH /ads/campaigns`、`PATCH /ads/ad-groups/:id`、`PATCH /ads/targets/:id`、`POST /ads/negatives`、`POST /ads/keywords`），全部进同一条流水线 `AdsWriteService`：权限（先于参数）→ 参数（422）→ 对象存在且在范围内（404，整批）→ 与当前值相同（422）→ 广告档案有统一接口账户编号（409）→ 动作守卫（权限、广告连接、动作开关与来源开关）→ 事务内建 `AdsWriteRun`（PENDING）与同步任务 `ADS_WRITE` 并写审计 `ADS_WRITE_SUBMITTED` → 提交后登记流程并入队。**响应只表示已排队**（`state: 'QUEUED'`），亚马逊的结果以 `GET /ads/writes` 的状态为准；整批全有或全无地受理，调用亚马逊在 worker 里逐项进行、成败独立。十种写入类别（`ADS_WRITE_KINDS`）各归属一个开关；**自动规则与分时策略发起的写入要同时开着动作开关与来源开关**（`sw.ads.rule.run`、`sw.ads.dayparting.run`）。`POST /ads/preview` 只读本系统的数据、不调用亚马逊、不写审计；改预算时附带本系统已保存的官方活动预测（没有就写原因）。请求体取值范围由 `adsWriteOpIssue` 判断（前后端共用）：日预算大于 0 且不超过 1,000,000，竞价 0.02 至 1000，广告位调整 0 至 900%，词最长 80 字符，一批最多 50 项。**广告位调整（`CAMPAIGN_PLACEMENT`）后端支持，但页面没有入口，且本地没有对应列，修改前的值显示“尚未同步”。**契约在 `packages/api-contracts/src/ads-write.ts`（常量、纯函数、响应类型）与 `ads-write-query.ts`（zod，单独成文件）。**Worker 写请求的路径与请求体形状是按统一接口的惯例写的，没有对真实广告账户验证过，全部集中在 `apps/worker/src/connectors/ads-v1-write.ts`；动作开关默认关闭，没有开启就不会向亚马逊发出任何写入请求。**自动执行：规则评估（每 30 分钟）与分时策略（每 30 分钟，启停与广告组级竞价系数）命中后经 `submitAutoWrite` 进同一流水线，`AdsAutomationRun`、`DaypartingRun` 的结果先记 `QUEUED`（`writeRunId` 关联），亚马逊确认后改 `APPLIED`（`executed = true`），失败改 `FAILED`；搜索词层级的规则没有所属广告组，只生成待办；活动级竞价系数没有对应的亚马逊字段，记 `SKIPPED`。本系统自己的写入记入 `AdsChangeLog`（来源 MANUAL / AUTO_RULE / DAYPARTING）与 `EntityEvent`，外部变更扫描器不会把它们当成外部修改。
> - `GET /ads/reports`：权限与范围先于参数校验（范围经广告档案绑定的店铺）。按创建时间排序，签名偏移游标（条件变了游标失效 400），`pageSize` 最大 200。每行：模板与名称、来源（`V1` 新报告接口 / `LEGACY` 旧版，旧版任务只列出不能重试）、广告产品、粒度、起止日期、状态（`PENDING`/`GENERATING`/`READY`/`FAILED`）、`importedRows`/`skippedRows`（没导入过是 `null`，不是 0）、`warnings`、`failureCode` 与 `failureText`、`attempt`、`retryOfId`、`canRetry`。`counts` 是范围内各状态条数（不受状态筛选影响）。没有任务 `state = NO_DATA` 并说明从哪里创建。
> - `POST /ads/reports`：先权限，再解析请求体，再检查档案（不存在、范围外、别的企业都是 404）、`adsAccountId`（没有 409 `ADS_ACCOUNT_MISSING`）与已授权的广告连接（没有 409 `ADS_CONNECTION_REQUIRED`）、时间范围（日报最多 120 天、小时报最多 14 天且只能取最近 14 天、不能晚于今天，不合法 422 `ADS_REPORT_WINDOW`，说明文字写明原因）。通过后依次建任务记录与同步任务（类型 `ADS_REPORT_V1`，队列域 `ads`，两条记录不在同一事务里）再入队；入队失败把任务标成失败（`QUEUE_UNAVAILABLE`）。响应 `{ report, syncJobId }`。
> - `POST /ads/reports/:id/retry`：新建一个任务（同模板、产品、范围，`attempt + 1`，`retryOfId` 指向原任务）。原任务不是新报告接口的失败任务 409 `ADS_REPORT_NOT_RETRYABLE`；原任务已被重试过 409 `ADS_REPORT_ALREADY_RETRIED`。
> - `POST /ads/reports/backfill`：从今天（企业时区）往前 `months`（1 至 25，缺省 24）个月，按 120 天切片，最多 8 个活动日报任务，最近的一片排在最前；同一档案还有排队中或生成中的新报告接口活动日报任务时 409 `ADS_BACKFILL_RUNNING`；月数不合法 422 `ADS_BACKFILL_RANGE`。各片依次建任务，**不是整体原子**：中途入队失败时，前面已排的切片保留。**能取到多早以接口实测为准**：取不到的更早日期任务会失败并写原因，页面“历史可用起点”只记已经取得数据的最早日期。
> - **历史可用起点**：日级模板的任务成功导入后，worker 把 `AdsProfile.historyFrom` 登记为导入数据的最早日期（只往前推，不往后拉），`GET /ads/report-templates` 的每个档案带 `historyFrom` 与 `historyProbedAt`，页面标“历史可用起点”。没有取过数据是 `null`，页面写“尚未取得数据”。保留期的 15 与 24 个月两种说法写在 `historyNote`（CR-001）。
> - `GET /ads/metrics`：`dataset`（缺省 `CAMPAIGN`）决定能选的维度与指标，`dims`、`metrics` 是逗号分隔的键（`dims=none` 表示不分组，只看合计），最多 3 个维度、6 个指标；维度或指标不属于该数据集、重复、超限都是 422（带原因）。`grain`（`day`/`week`/`month`）只在含日期维度时生效，周从周一算起。排序字段必须是 `key` 或已选指标（否则 422 `ADS_METRICS_SORT`），**空值永远排最后**。读数据库分组最多 19,999 个，超过 `truncated = true`，合计与排序只覆盖已读到的部分。**只汇总美元行**，非美元行数放在 `otherCurrencyRows`，不折算。**空值不当 0**：来源没给的金额是 `null`，合计里只要有一个值就求和，一个都没有是 `null`；比率（点击率、单次点击成本、转化率、广告成本销售比、广告投入产出比）由合计现算，分母为 0 或没有是 `null`。活动维度的名称取报告里的值，缺失用实体表补，能对上系统里的活动时返回详情页地址。没有记录 `state = NO_DATA`。
> - `GET /ads/parity`：只读总览：每个广告档案的新报告接口是否可用、旧通道是否还开着、连续通过次数与要求次数、最近一次核对的时间与结果，以及最近的核对记录（每次的窗口、新旧行数、一致数、四类差异条数）；`sunsetNote` 说明旧接口 2027 年 6 月 30 日停止。`GET /ads/parity/:runId/diffs`：差异分四类（时间口径、归因口径、范围、未解释），**未解释排最前**，其余按类别，最多 200 行（`truncated`）；范围外与别的企业 404。`POST /ads/parity/run`：只排一个 `ADS_PARITY` 同步任务，每个档案每天最多真正核对一次（worker 里再检查）。
> - **定时核对（worker，无接口）**：每 6 小时看一遍，给已发现广告账户编号、旧通道仍开着、距上次核对满 24 小时的档案各排一个核对任务（该档案已有排队中或运行中的就不重复排；企业没有已授权的广告连接不排）。

## 十二、风险、数据与报表、治理

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/alerts` | `alerts.read` | `AlertListQuery`（`view`：待处理、已处理、已忽略、已恢复、全部；`domain`、`severity`、`ruleId`、`q`；**P6-15 增**：`handleState`（取值同 `view`，优先于 `view`）、`readState`（`unread`/`read`，按当前用户）） | 预警列表（标题、对象、店铺、影响金额区间、负责人、状态；**P6-15 增**每行 `read`、`triggerCount`、`lastTriggeredAt`）、各视图条数、各业务域待处理数、**`unreadCount`（当前用户的预警未读数，与顶栏一致）** | — | — | — | — | 游标 |
| GET | `/alerts/:id` | `alerts.read` | — | 证据（中文名）、规则说明与**触发时的阈值**（版本快照）、同对象历史触发、规则近 30 天趋势、关联待办、处理时间线、关闭信息、可分派成员；评论与关注走 `/comments`（对象类型 `ALERT`） | — | — | — | — | — |
| POST | `/alerts/:id/ack` | `alerts.handle` | `AlertAckBody`（备注可选） | 确认：新预警 → 处理中，关联待办同步；返回 200；已确认或已结束 409 | — | — | 是 | — | — |
| POST | `/alerts/:id/ignore` | `alerts.handle` | `AlertIgnoreBody`（原因必填） | 忽略（必须原因）：预警与待办一并关闭，结论记 `IGNORED`；返回 200；已结束或被他人抢先处理 409 | — | — | 是 | — | — |
| POST | `/alerts/:id/assign` | `alerts.handle` | `AlertAssignBody` | 分派给在职成员（非在职 422）：改待办负责人并通知；预警没有待办时新建并回写；返回 200 | — | — | 是 | — | — |
| POST | `/alerts/:id/close` | `alerts.handle` | `AlertCloseBody`（结论必填：已处理、无需处理、误报） | 关闭：已处理 → `HANDLED`，无需处理与误报 → `IGNORED` 状态（`closeConclusion` 保留原结论，规则误报率据此统计）；返回 200 | — | — | 是 | — | — |
| GET | `/alerts/rules` | `alerts.read` | — | 全部规则（不分页，最多 500）：阈值与默认阈值、作用范围、通知对象、静默时段、最近 20 个版本、近 90 天质量统计（命中、待处理、已处理、误报率、平均处理时长，只算成员数据范围内的预警）；`unconnected` 是 09 章列出但依赖项未交付的预警类型（尚未接入） | — | — | — | — | — |
| POST | `/alerts/rules` | `alerts.manage` | `AlertRuleCreateBody` | 新建自定义规则（沿用预置评估逻辑，编号 `CUSTOM_001` 起，最多 50 条）；返回 201 | — | — | 是 | — | — |
| PATCH | `/alerts/rules/:id` | `alerts.manage` | `AlertRuleUpdateBody`（含 `version` 乐观锁与必填 `changeReason`） | 修改阈值、严重度、冷却、启停、范围并生成新版本（快照存全部设置）；阈值按评估器登记范围校验（422，`fieldErrors` 键为 `params.<键>`、`scope.<键>`）；没有改动 422；版本冲突 409；返回 200 | — | — | 是 | — | — |
| GET | `/account-health` | `account.health.read` | `ScopeQuery` | P5-02 已实现（CR-092）：每个可见店铺一块——账户状态与最近一次变化、状态变更历史（近 90 天，只含变化点）、评级与趋势、订单缺陷率（指标、三个构成项、趋势）、政策合规（指标、未解决问题数按类型）、其他指标；店铺 `state`：`OK` / `NO_DATA` / `NOT_CONNECTED` / `ROLE_PENDING`，没有的指标不返回行（页面写“尚无记录”，不补 0）；比率是小数（`unit = RATIO`，0.0085 = 0.85%）；`push` 说明状态推送尚未接入；读取行数超限带 `truncated` | — | — | — | — | — |
| GET | `/account-health/issues` | `account.health.read` | `PolicyIssueListQuery`（`status`、`kind`、`handlingStatus`、`ownerId`、`q`；排序 `firstSeenAt` / `lastSeenAt`，未解决的排前） | 政策合规问题列表（类型、标题、涉及 ASIN、状态、处理状态、负责人、关联案件编号）、未解决与已解决条数、报告同步状态；游标是偏移游标 | — | — | — | — | 游标 |
| GET | `/account-health/issues/:id` | `account.health.read` | — | 问题详情：处理备注、处理记录时间线（最近 50 条）、关联的支持案件（手填案件编号精确匹配，或案件主题含问题编号；没有 `support.read` 写 `RESTRICTED`）、可指定的负责人（在职成员）；看不到的店铺的问题 404 | — | — | — | — | — |
| PATCH | `/account-health/issues/:id` | `alerts.handle`（同时要求 `account.health.read`） | `PolicyIssueUpdateBody`（`version` 乐观锁必填；`ownerUserId`、`handlingStatus`、`handlingNote`、`amazonCaseId` 给了才改，`null` 清空） | 只改本系统的处理信息，**不调用亚马逊，也不改“解决”状态**（解决只由每日报告决定）；负责人必须是在职成员（422）；版本冲突 409；什么都没变不写库不加版本；一次修改在一个事务里写问题、时间线（`EntityEvent`，类型 `POLICY_ISSUE`）、审计（`POLICY_ISSUE_UPDATED`）与给新负责人的站内通知；返回 200 | — | — | 是 | — | — |
| GET | `/reports` | `reports.read` | `ReportCenterListQuery`（`domain`、`status`、`source`、`q`、`cursor`、`pageSize`；P5-03 已实现） | 报告任务（亚马逊报告、广告报告、数据中心查询三类合并）：申请条件、周期、状态、文件与解析状态、导入行数、保留期、失败码与原因、各状态与各业务域条数；见下方 — | — | — | — | 游标 |
| GET | `/reports/:id` | `reports.read` | — | 请求参数、状态时间线（亚马逊侧与本系统分开）、导入统计、解析警告、关联同步任务（P5-03 已实现） | — | — | — | — | — |
| POST | `/reports` | `reports.create` | `ReportCenterCreateBody`（`reportType`、`marketplaceId`、`from`、`to`；报告类型必须在目录里且 — | — | 是 | — | — |
| POST | `/reports/:id/cancel` | `reports.create` | — | 取消（200；只取消本系统任务，P5-03 已实现） | — | — | 是 | — | — |
| POST | `/reports/:id/retry` | `reports.create` | — | 重试（202；新建一个任务，P5-03 已实现） | — | — | 是 | — | — |
| GET | `/reports/:id/download` | `reports.read` | — | 原始文件签名链接（5 分钟有效；P5-03 已实现，写审计） | — | — | 是 | — | — |
| GET | `/connections` | `connection.read` | — | **P5-04 实现，响应由数组改为对象（CR-094）**：`{ items, summary, roles, legalEntities, canManage, manageBlockedReason, truncated }`。`items` 是四类连接的行（卖家接口、广告接口是授权连接；报告权限、品牌分析资格由同步结果推断，每个已授权店铺各一行）：授权主体（法人主体）、授权人、卖家编号或广告账户、授权范围、令牌是否存在（令牌永不返回）、最近健康检查（三项检查）、最近成功同步、失败码与中文原因、令牌更新时间与预计失效、可做的动作及不能做的原因。`roles` 是角色对照（各板块所需角色与状态、影响的页面、逐角色状态、推断依据）。按成员数据范围过滤，最多 200 条并标记截断 | — | — | — | — | — |
| POST | `/connections/:id/health-check` | `connection.manage` | — | **与原设计的出入**：令牌只有后台任务能解密，所以接口只排一个 `CONNECTION_HEALTH_CHECK` 同步任务并立即返回 `{ connectionId, syncJobId, alreadyRunning }`（同一连接已有排队或运行中的检查时不再排第二个）；检查结果由后台写入 `ConnectionHealth`，页面轮询 `GET /connections` 取得。写审计 `CONNECTION_HEALTH_CHECK_REQUESTED`。已断开、没有令牌、授权未完成的连接返回 409 `CONNECTION_UNAVAILABLE` | — | — | 是 | — | — |
| POST | `/connections/:id/reauthorize` | `connection.manage` | — | 返回 `{ connectionId, provider, authorizationUrl }`，沿用现有授权流程；回调时卖家账号与原连接不一致返回 409 `OAUTH_SELLER_MISMATCH`（广告授权没有这道校验）；授权成功清空错误码并自动排一次健康检查。写审计 `CONNECTION_REAUTHORIZE_STARTED` | — | — | 是 | — | — |
| POST | `/connections/:id/disconnect` | `connection.manage` | `ReasonBody` | **P5-04 实现**：需再次验证身份（`connection.disconnect`）；同一事务里把状态改为 `REVOKED`、清除令牌密文、取消排队中的同步任务（运行中的不动，由后台在下次检查时发现并收尾），审计 `CONNECTION_DISCONNECTED` 带前后状态、原因与取消数量；重复断开返回 409 `CONNECTION_ALREADY_DISCONNECTED`。返回 `{ connectionId, state: 'REVOKED', cancelledJobs }` | — | — | 是 | 是 | — |
| GET | `/connections/ads-accounts` | `connection.read` | — | 广告账户清单（P3-03 补，CR-058）：每个账户的绑定状态、绑定店铺、未绑定原因（无卖家编号、没有匹配店铺、匹配多个店铺、店铺已移除）、同卖家编号的候选店铺数、绑定人与时间；各状态计数；可选店铺（仅有权绑定时返回）；是否可绑定及不可绑定的原因；按数据范围过滤，最多 500 行并标记截断 | — | — | — | — | — |
| POST | `/connections/ads-accounts/:id/bind` | `ads.account.bind` | `AdsAccountBindBody`（`sellerAccountId` 为店铺编号或 `null`，`reason` 改绑与解除时必填） | 人工绑定、改绑、解除绑定广告账户与店铺（P3-03 实现，CR-058）。`:id` 是 `AdsProfile.id`（广告档案编号），不是 `AdsAccount.id`。需要“全部店铺”范围；乐观并发，别人先改过返回 409；写审计 `ADS_ACCOUNT_BOUND` 或 `ADS_ACCOUNT_UNBOUND`（含改动类型、前后店铺、原因） | — | — | 是 | — | — |
| GET | `/notifications/subscriptions` | `connection.read` | — | **P5-04 之后（P5-05，CR-095）响应改为 `SubscriptionCenterResponse`（契约 `subscription-center.ts`）**：`{ destination, canManage, affectedPages, stores, items, summary, truncated }`。`items` 是“店铺 × 推送类型”每行一条（18 类型），带订阅状态（有效、处理中、已失效、未订阅、店铺未授权、接收端未接入）、过滤条件、该行的接收端末 4 位、最近收到、近 24 小时事件数与失败数（现算）、版本号、四个动作各自的可用性与不能做的原因；`destination` 给出接收端是否已配置、所需配置步骤与退化说明；接收端未配置时 `affectedPages` 列出因此退化的页面。**按成员数据范围过滤店铺**，最多 200 个店铺并标记截断 | — | — | — | — | — |
| POST | `/notifications/subscriptions` | `notifications.manage` | `SubscriptionCreateBody` | 订阅（202）。**P5-05 补**：店铺不在数据范围内或不存在返回 404；需要卖家授权的类型而该店铺没有有效授权返回 409 `FBA_CONNECTION_REQUIRED`；接收端未配置返回 503 `DEPENDENCY_UNAVAILABLE` 且不写任何记录 | — | — | 是 | — | — |
| PATCH | `/notifications/subscriptions/:id` | `notifications.manage` | `SubscriptionUpdateBody` | 修改过滤条件（补）。**P5-05 补**：数据范围外的订阅 404；接收端未配置 503；不支持过滤的类型 422；版本号不符 409 | — | — | 是 | — | — |
| DELETE | `/notifications/subscriptions/:id` | `notifications.manage` | — | 取消订阅。**P5-05 补**：数据范围外的订阅 404；没有亚马逊订阅编号的直接删除（`removed: true`），已创建的交后台任务（记录先保留，`removed: false`） | — | — | 是 | — | — |
| POST | `/notifications/subscriptions/:id/replay` | `notifications.manage` | `ReplayBody` | 重放失败事件（补）。**P5-05 补**：数据范围外的订阅 404；只重置本店铺本类型的失败事件，没有则 409 | — | — | 是 | — | — |
| GET | `/sync/jobs` | `sync.read` | `SyncJobListQuery`（`domain`、`state`、`q`、`cursor`、`pageSize`；P5-06 已实现） | 任务：队列状态、进度、请求编号、尝试次数、日志摘要、失败原因、能否重试，外加各状态条数与各数据域近 24 小时概况；见下方 | — | — | — | — | 游标 |
| POST | `/sync/jobs` | `sync.manage` | `SyncJobCreateBody`（现有契约扩展数据域） | 发起同步 | — | — | 是 | — | — |
| GET | `/sync/jobs/:id` | `sync.read` | — | 参数、过程时间线与流程分步、写入统计、错误详情（失败原因、死信、连接状态）、关联报告任务（P5-06 已实现） | — | — | — | — | — |
| POST | `/sync/jobs/:id/retry` | `sync.manage` | — | 重试（202）。**P5-06 补**：只有失败的任务可以重试，排队、运行、等待中的任务与已作废的任务（连接已断开、报告已取消、归属校验未通过）返回 409 `SYNC_JOB_NOT_RETRYABLE`；重试把尝试次数清零重新计，时间线记一笔 `RETRY_REQUESTED` | — | — | 是 | — | — |
| GET | `/sync/dead-letters` | `sync.read` | `queue`、`includeReplayed`（补，P1-20） | 失败任务（死信）：队列、任务名、失败码、去敏详情、尝试次数、关联同步任务、重放人与时间；不返回任务载荷；受限成员只见范围内同步任务的失败记录 | — | — | — | — | 最近 100 条 |
| POST | `/sync/dead-letters/:id/replay` | `sync.manage` | — | 重放失败任务（补，P1-20）：同步任务沿用重试流程，其他队列按原载荷入队；同一条只能重放一次，重复返回 409 `DEAD_LETTER_ALREADY_REPLAYED`；不带同步任务的需“全部店铺”范围 | — | — | 是 | — | — |
| GET | `/sync/queues` | `sync.read` | — | 队列积压（等待、执行、延后、队列内失败）、本企业在各同步队列的占用与近 1 小时完成与失败数、本企业并发槽位占用（P5-06 已实现）；队列或缓存读不到时 `state = UNAVAILABLE`，不拿 0 冒充 | — | — | — | — | — |
| GET | `/sync/rate-limits` | `sync.read` | — | 各店铺各接口族令牌桶的剩余令牌、补充速率、是否冻结与最近一次限速时间；受限成员只见范围内店铺的桶；最多 200 个并标记截断；没有令牌桶 `state = NO_DATA`，缓存读不到 `state = UNAVAILABLE`（P5-06 已实现） | — | — | — | — | — |
| GET | `/sync/parity` | `sync.read` | `domain`（`ORDERS`\|`FINANCE`）、`runId`、`category`（补，CR-021） | 新旧接口并行核对报告：各店铺各数据域的旧通道状态（是否仍在对照、连续通过次数、关闭时间与原因）、最近 30 次核对记录；带 `runId` 时附差异明细（未解释优先，最多 200 条）与四类计数；受限成员只见范围内店铺；差异里只有订单号与金额，不含买家信息 | — | — | — | — | — |
| GET | `/entities` | `entity.read` | `LegalEntityListQuery`（`q`、`status`、`page`、`pageSize`；P5-07 已实现） | 主体列表。**P5-07 响应由数组改为分页对象** `LegalEntityListResponse`（契约 `legal-entity.ts`）：`{ items, total, page, pageSize, summary: { total, active, inactive }, canWrite, writeBlockedReason }`；每行带 `version`、店铺数、广告账户数（只统计当前账号数据范围内的；广告账户数 = 绑定在名下店铺上的广告档案数）。受限成员只见与自己授权相关的主体，**没有任何数据范围授权的成员返回 403 `SCOPE_NOT_GRANTED`** | — | — | — | — | 页码 |
| POST | `/entities` | `entity.write` | `LegalEntityCreateSchema`（现有） | 新增（201）。**P5-07 补**：主体名称企业内唯一（重名 409 `CONFLICT`）；写审计 `LEGAL_ENTITY_CREATED` 带新建内容；需要“全部店铺”数据范围（否则 403） | — | — | 是 | — | — |
| GET | `/entities/:id` | `entity.read` | — | 详情（P5-07 已实现）：`LegalEntityDetail`——资料、名下店铺（含卖家授权状态）与广告账户、被授权成员（`member.read` 才有，没有时 `members.state = 'RESTRICTED'`，不返回空列表冒充）、最近 50 条变更记录（取自审计前后快照，含原因）；店铺、广告账户、成员各最多 200 条并标记截断；`canWrite`、`canDeactivate` 及不能做的原因由服务端给出。范围外或不存在返回 404 | — | — | — | — | — |
| PATCH | `/entities/:id` | `entity.write` | `LegalEntityUpdateBody` + `VersionBody` | 修改（P5-07 已实现）：可改名称、注册地、注册号（传 `null` 清空）、状态；至少改一项，带 `version`（别人先改过 409 `CONFLICT`）；**停用（`status: 'INACTIVE'`）必须填 `reason`（缺则 422），且名下没有店铺（有则 409 `DATA_CONDITION_FAILED`）**；重名 409 `CONFLICT`；字段没有变化返回 `changed: false`（仍会留下通用审计，但没有前后快照）；写审计 `LEGAL_ENTITY_UPDATED` 带前后快照与原因。已停用的主体不能再发起新的卖家授权（连接中心 409），连接中心的主体选择里也不再出现。需要“全部店铺”数据范围 | — | — | 是 | — | — |
| GET | `/members` | `member.read` | `MemberListQuery`（`q`、`status`、`roleId`、`page`、`pageSize`；P5-08 已实现） | 成员列表。**P5-08 响应由数组改为分页对象** `MemberListResponse`（契约 `members.ts`）：`{ items, total, page, pageSize, summary: { total, active, disabled, pendingInvitations }, roles, invitations, canInvite, inviteBlockedReason, canManage, manageBlockedReason }`；每行带角色、数据范围概括、最近登录（从未登录为 `null`）。只要 `member.read`，**不要求自己有数据范围授权**（没有授权记录的成员与支持访问可读，但 `canManage` 为假）；邀请与管理需要“全部店铺”数据范围 | — | — | — | — | 页码 |
| GET | `/members/options` | `member.read` | — | 选人用轻量列表（P5-08 新增，比冻结表多一条）：`[{ status, user: { id, displayName, email } }]`，最多 1000 人；待办指派、评论 @、改进跟进、协作区使用；必须注册在 `/members/:id` 之前 | — | — | — | — | — |
| GET | `/members/:id` | `member.read` | — | 成员详情（P5-08 已实现）：`MemberDetail`——角色与字段权限、可选角色、授权记录（带主体或店铺编号）、最近 30 条登录会话（用户级，不区分企业）、与该成员有关的最近 50 条审计（需 `audit.read`，没有时 `audit.state = 'RESTRICTED'`，不返回空列表冒充）、停用信息，以及停用、恢复、改角色、改范围四个动作各自能不能做及原因 `actions`。别的企业的成员 404 | — | — | — | — | — |
| POST | `/members/invite` | `member.invite` | `MemberInviteBody`（`email`、`roleId`、`scope`） | 邀请（P5-08 已实现，201）：需要“全部店铺”数据范围；只能授予自己拥有的权限，所有者角色只有所有者能授予且范围必须是全部；邮箱已是成员或已注册账号 409 `DATA_CONDITION_FAILED`；再次邀请同一邮箱作废上一封；令牌只存哈希；邮件通道未配置时 `link` 只在这次响应里出现一次（`emailed = false`），审计不含令牌；成员数超过报价约定时 `warnings` 给提示，不阻止 | — | — | 是 | — | — |
| POST | `/members/:id/disable` | `member.manage` | `MemberDisableBody`（`reason` 必填，至少 2 字） | 停用（P5-08 已实现，200）：再次验证身份；不能停用自己，不能管权限比自己高的人，不能停用最后一位所有者；收回登录会话（用户在别的企业有使用中的成员身份时不收回）；写审计带前后快照；重复停用返回 `changed: false` | — | — | 是 | 是 | — |
| POST | `/members/:id/enable` | `member.manage` | `MemberEnableBody`（`reason` 可选） | 恢复（P5-08 新增，比冻结表多一条，200）：再次验证身份；角色与范围保持停用前的设置；写审计；重复恢复返回 `changed: false` | — | — | 是 | 是 | — |
| POST | `/members/:id/role` | `member.manage` | `MemberRoleBody`（`roleId`、`reason` 可选） | 修改角色（P5-08 已实现，200）：再次验证身份；不能授予自己没有的权限；设为所有者前范围必须是全部；同角色返回 `changed: false`；写审计带前后角色 | — | — | 是 | 是 | — |
| POST | `/members/:id/scopes` | `member.manage` | `MemberScopesBody`（`scope`、`reason` 可选） | 授权数据范围（P5-08 已实现，200）：整体替换；全部或指定主体与店铺二选一且至少一项（422），主体与店铺必须属于本企业；所有者不能缩小；再次验证身份；写审计 | — | — | 是 | 是 | — |
| GET | `/roles` | `role.manage` | — | 角色与权限矩阵、字段级权限（P5-08 已实现）：`RolesResponse`——预设与自定义角色、使用中成员数与待接受邀请数、每个角色能不能改及原因（预设与旧版角色只能复制）、自定义角色数量与上限（50）。权限树（模块 → 页面 → 动作与影响范围）在 `@nova/authz` 的 `permissionTree()`，前端直接用，不走接口 | — | — | — | — | 页码 |
| POST | `/roles` | `role.manage` | `RoleCreateBody` | 新角色（P5-08 已实现，201）：可 `copyFromRoleId` 复制预设或自定义角色再覆盖名称、权限、字段权限；不能含通配权限；权限点必须认识、至少一个；分离职责冲突 422；不能授予自己没有的权限点或看不到的字段；“仅负责人可见”只对成本与利润；重名 409；再次验证身份；写审计 | — | — | 是 | 是 | — |
| PATCH | `/roles/:id` | `role.manage` | `RoleUpdateBody` + `VersionBody` | 修改（P5-08 已实现）：预设与旧版角色不可改（409 `DATA_CONDITION_FAILED`，请复制）；带 `version`（别人先改过 409 `CONFLICT`），改权限使版本加一，使用该角色的成员下次请求按新权限判断；分离职责约束校验；再次验证身份；写审计带前后快照 | — | — | 是 | 是 | — |
| GET | `/audit` | `audit.read` | `AuditQuery`（操作人 `actorId`、动作 `action`、资源类型 `resourceType`、资源编号 `resourceId`、结果 `result`、时间范围 `fromAt`/`toAt`（ISO 时间）、请求编号 `requestId`、所属页面 `page`、来源 `source`、关键词 `q`；P5-09 已实现） | 审计列表（服务端搜索与筛选；每行带来源、所属页面与操作人，系统任务的操作人写“系统”；`canExport`/`exportBlockedReason`） | — | — | — | — | 游标 |
| GET | `/audit/options` | `audit.read` | — | 筛选候选项（P5-09 新增）：近 90 天出现过的动作、资源类型、操作人、所属页面，超过 300 项时 `truncated` 为真 | — | — | — | — | — |
| GET | `/audit/pii-views` | `audit.read` | `PiiViewQuery`（查看人、时间范围、订单关键词 `q`；P5-09 新增） | “个人信息明文查看”专门视图：谁、什么时候、为什么、看了哪个对象的哪些字段（只有字段名，没有明文）、用什么方式；`summary`（近 24 小时与近 7 天次数、查看最多的人）与大量查看预警规则的当前状态和阈值 | — | — | — | — | 游标 |
| GET | `/audit/:id` | `audit.read` | — | 修改前后差异（逐字段脱敏）、请求上下文（来源 IP、访问方式）、关联资源 | — | — | — | — | — |

> **P5-09 实现说明（CR-100）**：`/audit`、`/audit/options`、`/audit/pii-views`、`/audit/:id` 全部只读，静态路径写在 `:id` 之前；比冻结表多两条路由（`options`、`pii-views`）。游标分页（坏游标 400，参数不合法 422，权限检查先于参数校验）。`AuditEvent` 新增可空列 `source`（`PAGE`、`API`、`SYSTEM`）与 `page`；写入时前端请求头 `X-Nova-Page` 由服务端核对后记录，**该请求头由浏览器自报**；worker 写入的记 `SYSTEM`；旧记录不回填，读取时没有来源且没有操作人的按“系统”处理，其余显示“未记录”。导出走导出中心（`audit-events`，`storeScoped:false`，需要 `export.create` 与 `audit.read`，导出本身写审计）。新增预置预警规则 `SYS_PII_BULK_VIEW`（类型 `audit.pii-bulk-view`，参数 `windowMinutes` 默认 60、`maxViews` 默认 20，可在预警规则里调整）。
| GET | `/settings` | `settings.read` | — | 基本信息、数据保留、刷新策略、风险规则版本、内部访问模式（只读状态） | — | — | — | — | — |
| PATCH | `/settings` | `settings.write` | `SettingsUpdateBody` + `VersionBody` | 修改基本信息、数据保留、刷新策略 | — | — | 是 | — | — |

> **P5-10 实现说明（CR-101）**：冻结的两条路由都实现，没有新增路由，没有再次验证身份要求。`GET /settings`（`settings.read`）一次返回五块：`basic`（企业名称、标识、运行模式、数据口径时区、企业本地时区、默认币种，`version` 是企业记录最近更新时间的毫秒数）、`retention`（三项保留天数，含默认值、取值范围、影响范围与“修改对已有数据的影响”；`auditLog` 是只读说明）、`refresh`（19 个数据域（P5-12A 起含广告实体 `ADS_ENTITY_SYNC` 与广告报表 `ADS_REPORT_V1`）的当前取值、系统内置间隔、可选的放慢间隔与影响范围；`fixed` 是固定频率的定时任务清单，只读；`pausedCount`）、`risk`（预警规则总数、已启用数、最近一次规则修改，版本 1 不算修改）、`internal`（内部访问模式状态 `OFF`/`ON_THIS_TENANT`/`ON_OTHER_TENANT`/`MISCONFIGURED`，只有对本企业开启时才返回绑定角色与网络段数，不返回具体地址与校验头；以及平台支持访问授权的有效数与使用中数），另有 `canWrite`。`retention`、`refresh` 各带自己的 `version` 与最近修改人和时间。`PATCH /settings`（`settings.write`）请求体按 `section` 分三种，都必须带 `version`（读取时该部分的版本号，不一致 409）与 `reason`（2 至 500 字）：`basic`（`name`、`localTimezone` 至少一项；数据口径时区与默认币种不开放修改）、`retention`（`values` 三项齐全，各自在取值范围内：原始报告文件 30 至 1095 天、导出文件 1 至 30 天、买家信息 1 至 30 天）、`refresh`（`changes`：数据域 → `DEFAULT`（恢复内置）/`PAUSED`/`EVERY` 加 `minutes`，间隔必须比系统内置的更长，只能放慢或暂停，不能更快）。与当前设置完全相同返回 422。审计动作：基本信息 `TENANT_PROFILE_UPDATED`（资源 `Tenant`），保留与刷新 `TENANT_SETTING_UPDATED`（资源 `TenantSetting`，键 `retention.policy`、`refresh.policy`）。数据保留与刷新策略存企业设置项 `retention.policy`、`refresh.policy`（不进 `PREFERENCE_KEYS`，不走 `/settings/preferences`）。保留策略被谁读取：导出中心创建任务时读 `exportFileDays` 写有效期；worker 保存原始报告文件时读 `rawReportDays`、写入订单买家信息时读 `customerInfoDays`；刷新策略被 `scheduleProductionSync` 读取，只管定时同步，手动同步、回补与写入后的刷新不受影响。
| GET | `/settings/preferences` | `settings.read` | — | 企业设置项（已登记的键与当前值、默认值、最近修改）（补，CR-022；冻结清单的 `/settings` 保持企业基本信息） | — | — | — | — | — |
| PUT | `/settings/preferences/:key` | `settings.write` | `PreferenceUpdateBody` + `VersionBody` | 保存单个设置项（按键校验取值范围）（补，CR-022） | — | — | 是 | — | — |
| GET | `/settings/integrations/summary` | 基础 | — | 写入状态汇总：模式（只读/部分/全部）、开启项数、是否被平台紧急强制关闭；顶栏标识使用，不含凭据与明细（补，CR-022） | — | — | — | — | — |
| GET | `/settings/integrations` | `settings.read` | — | 开关总览与 20 项开关：状态、前置条件、最后修改人、原因、历史、近 7 天写调用与失败 | — | — | — | — | — |
| PATCH | `/settings/integrations` | `settings.integration.write` | `IntegrationSwitchBatchBody` + `VersionBody` | 批量更新（补） | — | — | 是 | 是 | — |
| POST | `/settings/integrations/readonly-all` | `settings.integration.write` | `ReasonBody` | 一键全部只读（紧急） | — | — | 是 | — | — |
| POST | `/settings/integrations/:key/enable` | `settings.integration.write` | `SwitchEnableBody`（必填原因、二次确认） | 开启：自动检查前置条件，通知管理员 | — | — | 是 | 是 | — |
| POST | `/settings/integrations/:key/disable` | `settings.integration.write` | `ReasonBody` | 关闭 | — | — | 是 | — | — |
| GET | `/settings/fx` | `settings.read` | `FxQuery` | 币种对、汇率曲线、来源、最近获取状态、手工覆盖记录 | — | — | — | — | 游标 |
| POST | `/settings/fx` | `settings.fx.write` | `FxOverrideBody` / `FxSourceBody` | 手工覆盖或选择主源与备源 | — | — | 是 | 是 | — |
| POST | `/settings/fx/currencies` | `settings.fx.write` | `FxCurrenciesBody`（含原因） | 管理附加币种（供采购、费用使用）（补，CR-022） | — | — | 是 | — | — |
| POST | `/settings/fx/refresh` | `settings.fx.write` | — | 立即获取汇率：只入队，由后台任务获取，结果刷新后查看（补，CR-022） | — | — | 是 | — | — |
| DELETE | `/settings/fx/overrides/:id` | `settings.fx.write` | — | 撤销手工覆盖（已被关账锁定的不可撤销）（补，CR-022） | — | — | 是 | 是 | — |

> **P5-06 实现说明（CR-097）**：同步中心 `GET /sync/jobs`（改写）、`GET /sync/jobs/:id`、`GET /sync/queues`、`GET /sync/rate-limits` 四条读路由，写路由沿用（重试补了前置条件）。契约 `packages/api-contracts/src/sync-center.ts`（数据域 19 个 = 9.8 的 18 个 + `SYSTEM`、数据域可用性、任务类型名称、状态机 `syncStateOf`、失败码到中文、重试前置条件）、`sync-center-trace.ts`（时间线与写入统计的读写）、`sync-center-views.ts`（响应类型、队列名称、令牌桶折算）、`sync-center-query.ts`（zod，单独成文件）。迁移 `20261202010000_sync_center`：`SyncJob` 增 `resultJson`（写入统计，只存数字）与 `timelineJson`（过程时间线，最多 40 条）两列，可空，旧任务为空。
>
> - `GET /sync/jobs`：权限与范围先于参数校验（未知参数 422）。每行是一个同步任务：`state` 由 `status`、尝试次数与失败码推出（`QUEUED` 排队中、`RETRY_WAIT` 等待重试、`POLL_WAIT` 等待亚马逊报告、`RUNNING`、`SUCCEEDED`、`FAILED`），失败原因是中文说明另带失败码，`logSummary` 是最近一条过程事件，没有过程记录的旧任务为 `null`。数据域筛选：普通类型按类型列表，报告申请与轮询任务按上下文里的 `reportType` 归到账户健康、品牌分析、财务交易或业务报告，认不出的类型归 `SYSTEM`（连接与系统任务）。游标是签名的偏移游标，筛选条件变了游标失效 400；`counts` 不受状态筛选影响；`domains` 是各数据域近 24 小时的概况（最多读 5000 个任务，超过时 `summaryTruncated`），同步器没交付的数据域 `availability` 标 `NOT_CONNECTED`（营销数据流）；广告实体、广告报表原为 `PARTIAL`，P5-12A（CR-104）交付落库同步器后改为 `LIVE`（`PARTIAL` 取值保留，目前没有数据域使用）。没有任务 `state = NO_DATA` 并写“尚无记录”。
> - `GET /sync/jobs/:id`：查询条件带租户与数据范围，找不到 404。`params` 只列有白名单中文名的上下文字段（站点、报告类型、数据集、时间窗口），不原样输出整份上下文；`stats` 没有记录为 `null`；`workflows` 是该任务登记的流程运行与分步；`deadLetter` 是最近一条失败任务记录；`reports` 是关联的亚马逊报告、广告报告或数据中心查询（带报表中心路径）。
> - `GET /sync/queues`：积压来自队列（整个平台的合计，队列本身不区分企业），本企业的占用来自 `SyncJob` 表（等待与执行取当前状态，完成与失败取近 1 小时），并发槽位来自缓存里的 `tenant-slots:<企业>`，上限读 `TENANT_MAX_CONCURRENT_JOBS`（默认 2，与后台任务进程同一个环境变量）。
> - `GET /sync/rate-limits`：令牌桶在缓存里按 `ratelimit:<企业>:<连接>:<接口族>` 记录（一小时没人用就过期，最近一次限速时间随之消失），接口只读；`limitedAt` 是本包新增的字段，收到 429 时由后台任务写入。

> **P5-03 实现说明（CR-093）**：报表中心 6 条路由（2 读 + 下载、3 写），契约在 `packages/api-contracts/src/report-center.ts`（常量、标签、时间线、失败原因表、纯函数）、`report-center-catalog.ts`（目录 `REPORT_CATALOG`：每个能创建、检索或登记的报告与数据集一行，含业务域、创建方式、数据周期、导入器编号、申请条件、分析页）、`report-center-query.ts`（zod，单独成文件）。**目录里每一项都有导入器，worker 的 `report-catalog.test.ts` 逐项核对；目录里没有的报告类型不能创建，也不会被导入；`report-import.ts` 与 `dispatch.ts` 遇到未登记的类型抛不可重试的 `REPORT_TYPE_NOT_REGISTERED` / `SYNC_JOB_TYPE_UNKNOWN`，代码里不再有“未实现”分支。**
>
> - `GET /reports`：权限与范围先于参数校验。三类任务（`FbaReportJob`、`AdsReportJob`、`SyncJob` 里类型为 `DATA_KIOSK_QUERY` 的）各自按创建时间取前 `offset + pageSize + 1` 条再合并，读取窗口最多 `REPORT_LIST_WINDOW_MAX` = 1000 条，超过时 `truncated = true`；游标是签名的偏移游标，筛选条件变了游标失效 400。`counts` 不受状态筛选影响、`domainCounts` 不受业务域筛选影响。没有任务 `state = NO_DATA` 并写“尚无记录”。每行的文件状态 `fileState`：`NONE` 尚未生成、`STORED` 已留存、`EXPIRED` 已过保留期、`NOT_STORED` 已完成但没有留存原始文件（内容相同的文件只留第一份）、`NOT_APPLICABLE` 广告与数据中心任务的结果直接入库，报表中心不提供文件。
> - `POST /reports`：先权限，再解析请求体，再检查数据周期（快照类不要日期；起止日期类最长 `REPORT_RANGE_MAX_DAYS` = 31 天、不能晚于今天；品牌分析类必须是完整的自然周、月或季；不合法 422 `REPORT_PERIOD_INVALID`，只能检索的类型也是这个码）、店铺连接与数据范围；同一店铺、类型、周期有排队中或生成中的任务时 409 `REPORT_ALREADY_RUNNING`。通过后建任务与同步任务（类型 `FBA_REPORT_CREATE`，互相关联）、登记写流程（`report.create`）、入队；入队失败两条记录分别标 `FAILED` 与 `FAILED_PERMANENT`（`QUEUE_UNAVAILABLE`）。响应 `{ report, syncJobId }`。站点固定美国站。
> - `POST /reports/:id/cancel`：**只取消本系统的任务**，亚马逊侧已开始生成的报告不会被撤回；状态置为 `CANCELLED`、失败码 `REPORT_CANCELLED`；已开始下载解析的任务不能取消，已结束的任务也不能（409 `REPORT_NOT_CANCELABLE`）。后台任务发现任务已取消就返回 `cancelled`，同步任务记为 `FAILED_PERMANENT` / `REPORT_CANCELLED`。只有亚马逊报告任务能在报表中心取消，广告与数据中心任务去各自页面。
> - `POST /reports/:id/retry`：只对 `FAILED` 与 `CANCELLED` 的“可创建”类型任务，且只能重试一次（再次 409 `REPORT_ALREADY_RETRIED`，状态不对 409 `REPORT_NOT_RETRYABLE`）；新建任务 `attempt + 1`、`retryOfId` 指向原任务，并在原任务时间线记一笔 `RETRIED`。
> - `GET /reports/:id`：时间线只存过程事件（已向亚马逊申请、亚马逊侧排队、生成、完成、开始下载），`REQUESTED`、`IMPORTED`、`FAILED`、`CANCELLED` 由状态与时间列补出；广告与数据中心任务没有逐阶段的亚马逊侧记录，`notes` 里写明。导入统计：读到、导入、跳过、忽略；**新增与更新不区分（恒为 `null`，页面写“未区分”）**；失败行数只在已完成的任务写 0，其余 `null`。解析警告只有“字段名与上一份报告相比新增或消失”两类。
> - `GET /reports/:id/download`：只有 `STORED` 且在保留期内的亚马逊报告任务发 5 分钟有效的链接并写审计 `REPORT_DOWNLOAD_LINK_ISSUED`；其他情况 409 `REPORT_FILE_UNAVAILABLE`。找不到、范围外、别的企业的任务一律 404。
> - **没有建 `ReportSubscription`**（定时订阅与投递）：本表没有它的路由，投递渠道（邮件、站内信之外的通道）也未定，留待后续决定。
## 十三、现有 59 个接口的去向

| 现有路径 | 去向 |
| --- | --- |
| `GET health` | 保留 |
| `commerce/*`（官网商业化 12 个：套餐、订单、支付、退款、管理端） | **保留不变**，不属于 ERP 范围，不改动 |
| `payments/alipay/notify` | 保留不变 |
| `POST auth/login`、`POST auth/refresh` | 保留路径，行为按 P1-17 加固（刷新轮换、来源校验） |
| `GET auth/me` | 保留，响应扩展 |
| `GET\|POST entities`、`GET members`、`GET audit` | 保留路径，契约改游标或页码（P1-10、P1-11） |
| `GET orders`、`GET orders/:id/items` | 保留；订单列表改游标；字段迁移订单接口新版（P1-26、P2b-01） |
| `GET inventory` | 迁移到 `GET /inventory`（新契约）；旧的内部路径已在 P5-12 删除（CR-103） |
| `GET fba/summary`、`GET fba/products`、`GET fba/inventory`、`GET fba/inbound-plans`、`POST fba/inbound-plans`、`GET fba/fees`、`GET fba/settlements`、`GET fba/returns` | 分别迁移到 `/products`、`/inventory`、`/inbound/plans`、`/finance/events`、`/settlements`、`/returns`；**旧路径已在 P5-12 删除，请求直接 404**（`routes.test.ts` 断言；CR-103） |
| `POST fba/sync/jobs`（P5-12 已删除）、`GET\|POST reports/jobs`（P5-03 已移除，由 `/reports*` 取代）、`GET sync/jobs`、`POST sync/jobs`、`POST sync/jobs/:id/retry` | 合并到 `/sync/jobs`、`/reports` |
| `GET analytics/profit` | **已下线**（有内存汇总截断缺陷），由 `/profit/*` 替代（P2b-10 完成，路由清单与 `routes.test.ts` 已移除） |
| `GET analytics/ad-terms` | **已下线**（有内存汇总截断缺陷），由 `/ads/terms` 替代（P3-10 完成，路由清单与 `routes.test.ts` 已移除，路由 58 变 57） |
| `GET procurement/suppliers`、`GET\|POST procurement/purchase-orders` | 迁移到 `/suppliers`、`/purchase-orders` |
| `GET warehouses`、`GET inventory/movements` | 迁移到 `/domestic-warehouse` 与 `/domestic-warehouse/movements` |
| `GET connections` | 保留，响应扩展 |
| `POST sp-api/oauth/start`、`GET sp-api/oauth/callback`、`POST ads/oauth/start`、`GET ads/oauth/callback` | 保留，由 `/connections/:id/reauthorize` 调用 |
| `GET ads/profiles`、`GET ads/campaigns`、`GET ads/reports`、`POST ads/reports`、`GET ads/metrics`、`POST ads/sync` | 迁移到 `/ads/*` 新契约 |
| `POST contact-requests`（公开）、`GET\|PATCH contact-requests` | 保留（官网线索，后端接口保留；前端不再进导航） |

## 十四、统计

| 分组 | 接口行数 |
| --- | --- |
| 平台运营后台（含租户侧授权 2 行） | 14 |
| 租户开通与认证 | 13 |
| 范围与平台 | 21 |
| 首页 | 24 |
| 运营分析 | 20 |
| 商品 | 53 |
| 库存与补货 | 36 |
| 采购、国内仓、头程、入仓 | 48 |
| 订单与售后、财务 | 54 |
| 广告 | 56 |
| 风险、数据与报表、治理 | 63 |
| **合计** | **402 行** |

说明：
- 个别行用花括号合并了同类页签接口（如 `/ads/ad-groups/:id/{trend,targets,...}`），展开后接口数更多；
- 10.4 中每一条接口均已出现；标"补"的 93 行（含 CR-022 新增的 7 行），是页面实际需要、10.4 未逐条列出的接口（详情、批量、导入、试运行、前后对照等），**需你确认**；
- 现有 59 个接口的去向见第十三节；官网商业化接口保持不变。

## 十五、需要你确认的事项（P0-03 产生）

| 编号 | 事项 | 我的处理建议 |
| --- | --- | --- |
| Q-03-1 | 写入开关 `sw.inbound.plan.create` 同时覆盖"取消入仓计划"，页面显示名改为"创建与取消入仓计划" | 9.13 原文只写"创建入仓计划"；取消也是亚马逊写操作，需要被开关管住，否则开关可被绕过 |
| Q-03-2 | 写入开关 `sw.inbound.transport.confirm` 同时覆盖"回填追踪号"，页面显示名改为"确认承运方式与回填追踪号" | 原文只写"确认承运方式"；回填追踪号同样调用亚马逊写接口 |
| Q-03-3 | 新增权限点 `data.import`（文件导入）；评分与评分数、仓储限额导入使用 | 评分与仓储限额没有官方来源，方案要求"文件导入并标注来源"，需要独立权限 |
| Q-03-4 | `POST /inbound/plans/:id/confirm` 定义为"标记已发货"（我方状态流转，不调用亚马逊） | 入仓接口没有"发货"操作；该步骤只在我方推进状态链 |

---

## 十六、阶段 6 新增与修改接口（CR-107，P6-00 登记；均未实现）

依据：14 章阶段 6 各工作包的“接口”一项，本文第一节通用约定全部适用（范围、租户归属、字段权限过滤、游标或页码、幂等、乐观锁）。**这里登记的是路径、方法、权限与要点，契约的字段在各包实现时写进 `packages/api-contracts`。** 实现前，接口不得引用 `permissions.md` 第十节里尚未进目录的权限点（见该节说明）。静态路径要排在 `:id` 之前（如 `/alerts/read`、`/alerts/templates`、`/alerts/rules/preview` 先于 `/alerts/:id`；`/promotions/stacking` 先于 `/promotions/:id`；`/first-mile/carriers` 先于 `/first-mile/:id`；`/inbound/shipments/discrepancies` 先于 `/inbound/shipments/:id`；`/finance/profit-items/unmapped` 在 `:id` 之前）。

### 16.1 对已有接口的修改

| 方法 | 路径 | 包 | 修改内容 |
| --- | --- | --- | --- |
| GET、PUT | `/me/preferences` | P6-01 | 与 P5-11 合并成同一个接口：响应增加 `favorites`（收藏的路由模板数组）与 `density`（`COMPACT`/`STANDARD`）。`PUT` 的请求体仍带 `version`（同一把乐观锁），`notify`、`favorites`、`density` 三项**各自可省略，省略的项保持不变**（原先“整份覆盖”只对出现的项成立）；收藏数量上限与不存在的路由模板的处理由 P6-01 定稿并写进 CR；与当前完全相同仍返回 422。**P6-01 已定稿（CR-108）**：收藏最多 30 个、不得重复，每项必须是 `/app/` 下由小写字母数字与连字符组成的静态路径（不含 `:参数`，至多 120 字）；服务端只校验形状，不校验页面是否上线或有权限，前端显示时过滤 |
| GET | `/notifications/unread-count` | P6-01 | 响应由 `{ unreadCount }` 扩为 `{ unreadCount, messages, alerts }`：`messages` 与 `unreadCount` 同值（站内消息，不含免打扰期间收到的），`alerts` 是预警未读数（见 P6-15）；`unreadCount` 保留到前端全部改用新键为止，之后由 P6-01 的 CR 记录删除时点。**P6-01 已定稿（CR-108）**：`alerts` 在 P6-15 之前为 `null`；`unreadCount` 仍保留（`@nova/api-contracts` 的 `UnreadCountResponse`），没有定删除时点 |
| GET | `/events` | P6-06 | **P6-06 已实现（CR-114）**：查询参数固定为 `objectType`（`ENTITY_TYPES` 之一）、`objectId`、`from`、`to`（`YYYY-MM-DD` 按企业时区取整日，或完整时间点；缺省为最近 90 天；跨度最多 400 天，超出 422）、`types`（逗号连接，`OPERATION`/`PRICE`/`ADS`/`ALERT`/`LISTING`/`AUDIT`/`OTHER`，缺省全部）；响应 `{ items:[{ id, type, occurredAt, day, title, summary, link, actor }], truncated, truncatedTypes, unavailableTypes }`（比冻结多 `day`、`truncatedTypes`、`unavailableTypes` 三个字段）；每种类型最多 200 条（每个来源多读一行判断截断），超出时 `truncated` 为 true 并在 `truncatedTypes` 列出；按对象的数据范围过滤（店铺、商品、库存记录、广告活动在范围外按 404；其余对象类型按 `EntityAccessService` 判读权限）；先要有对象读权限（随 `objectType`，缺权限 403 先于参数校验），再逐类按 `permissions.md` 10.2 过滤，没有权限的类型不报错、不查库，列在 `unavailableTypes`。旧的“对象事件时间线”（P1-28 的 `GET /events`）已并入本接口，路径不变 |
| GET | `/metrics/definitions` | P6-03 | 每条指标增加三个字段：`reconcileWith`（和哪里对数，`[{label, route}]`）、`mismatchReasons`（可能对不上的原因，字符串数组）、`configurableAt`（在哪里配置，`{label, route}` 或 `null`）；定义与公式、数据来源、刷新频率、口径版本沿用已有的 `definition`、`source`、`refresh`、`version`，不再另设 `caliber`、`dataSource`。登记见 `metrics.md` 10.7。没有补充记录的指标是空数组、空数组、`null`。新增查询参数 `ids`（逗号分隔的指标编号，至多 50 个）：列头问号只取本表格用到的指标。**P6-03 已定稿（CR-111）** |
| GET | `/metrics/definitions` | P6-07 | 每条指标再增加 `ruleUse`（`{ domain, unit, aggs }` 或 `null`）：标记能否用于规则条件，登记见 `metrics.md` 10.8；`domain` 取 `sales`、`ads`、`inventory`、`profit`、`aftersales`，`unit` 取 `money`、`percent`、`count`、`days`、`ratio`，`aggs` 取 `sum`、`avg`、`last`、`min`、`max`。新增查询参数 `ruleUsable=true`（只返回 `ruleUse` 非空的指标，目前 20 个；写成别的值 422）：条件构造器的指标级联取这一份。条件的数据结构、校验、中文描述与判断函数在契约 `rule-conditions*.ts`（零 zod，前端与 worker 共用），不是接口。**P6-07 已定稿（CR-115）** |
| GET | `/orders`、`/inventory` | P6-04 | 增加查询参数 `qs`（批量精确搜索）：换行、制表符、逗号、分号（含全角）分隔，每项去首尾空白、丢空项、去重（不区分大小写）；**最多 500 个词、每个词不超过 80 个字符、逗号连接后总长不超过 12000 个字符**，超限 422（`path: ['qs']`）。`/orders` 按订单号或包裹追踪号精确匹配（`in`）；`/inventory` 按 SKU、ASIN、FNSKU 精确匹配（不区分大小写）。与 `q`（开头或包含匹配的单项搜索）同时给出时两个条件取交集。拆分规则在 `packages/api-contracts/src/batch-terms.ts`（不带 zod，前端筛选栏与接口共用）。词放在 GET 请求里，所以 `infrastructure/aliyun/nginx.conf` 的 `large_client_header_buffers` 放宽到 `4 32k`。筛选方案沿用 `/grid-views`（`kind=FILTER`），不新增接口。**P6-04 已定稿（CR-112）** |
| GET | `/alerts` | P6-15 | 增加 `readState`（**已实现为小写 `read`/`unread`，与 `view` 取值风格一致，CR-123**）与 `handleState`；默认只看“待处理”；每行增加 `read`（当前用户是否已读）与 `triggerCount`、`lastTriggeredAt`（复用 `AlertInstance` 已有列） |
| POST、PATCH | `/alerts/rules`、`/alerts/rules/:id` | P6-16 | 请求体增加 `conditionGroups`、`notifyFrequency`、`escalation`，带校验（422 的 `fieldErrors` 键沿用 `params.<键>`）；评估器类型增加 `CUSTOM_METRIC` |
| POST、PATCH | `/pricing/rules`、`/pricing/rules/:id` | P6-17 | 请求体增加 `scenarioMatrix`（五种情形 × 五种动作）；目标价超出护栏时不执行，并写原因 |
| GET | 广告各层级列表（`/ads/campaigns`、`/ads/ad-groups`、`/ads/targets`、`/ads/search-terms` 等） | P6-23 | 增加汇总行与区间筛选参数（`<指标>Min/Max`：spend、sales、acos、ctr、cpc、cvr、impressions、clicks、orders，比率用小数，下限大于上限 422）与分类筛选 `bucket`（CONVERTED、CLICK_NO_ORDER、IMPRESSION_NO_CLICK、NO_IMPRESSION，四类互斥）；汇总是筛选后全部对象的合计：活动、广告组、词级响应放在 `summary`，广告商品放在 `level`（它的 `summary` 另有含义）；`GET /ads/ad-groups` 为新增列表（排序、`state`、`portfolioId`、`campaignId`、`q`）；投放与搜索词沿用 `GET /ads/terms?tab=targets|search-terms`，不新增 `/ads/targets`、`/ads/search-terms` 列表路由，投放行新增 `entityId`；`GET /ads/:level/counts` 另列于下表 |
| GET | `GET /inbound/plans/:id` | P6-10 | 响应增加 `steps[]` 与 `actions{}`（当前可做的动作与不可做的原因）。**P6-10 已定稿（CR-118）**：`actions{}` 早已存在（P2a-12），保持不变；`steps[]` 改为五步流程 `[{ key, label, state, stateLabel, note, actions:[{ action, label, allowed, reason }] }]`（`key` 取 `ITEMS`/`BOXES`/`PLACEMENT`/`TRANSPORT`/`LABELS_SHIP`；`state` 取 `NOT_STARTED`/`IN_PROGRESS`/`DONE`/`ERROR`），原来的阶段链（草稿 → 已完成的十几个阶段）改名为 `stageChain[]`，内容不变；每步里的按钮与 `actions{}` 是同一份规则，不另算 |
| POST | `/replenishment/to-inbound-draft` | P6-08 | **已移除（CR-116）**：由批次级的 `to-inbound-drafts` 取代为真实草稿；没有保留兼容（调用方只有补货页自己，已一并改掉）；以前登记的意图用 `GET /replenishment/intents` 查、用新接口补建 |
| GET | `/returns/analysis` | P6-13 | 保持不变（按 ASIN、原因的退货率趋势）；新增的 `/returns/analysis/*` 子路径排在 `/returns/:id` 之前 |

### 16.2 新增接口

下表“权限”列：**粗体**为 `permissions.md` 第十节登记的待新增点位；“基础”表示所有登录成员；写入开关一列只有调用亚马逊写接口的动作才有值。

| 方法 | 路径 | 权限 | 契约 | 响应要点 | 开关 | 预览 | 审计 | 验证 | 分页 | 包 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/grid-views` | 基础（`view.manage`，无需新点位） | `gridId`、`kind` | `{ items, canShare, limits }`：当前用户可见的视图与筛选方案（我的、团队、系统，按此顺序）；每个 `gridId` 个人 20 条、团队 30 条（合计 50），`canShare` 表示当前成员能否共享给团队 | — | — | — | — | — | P6-03 |
| POST | `/grid-views` | 基础；`scope=TEAM` 需 **`grid.view.share`** | `GridViewBody` | 新建个人或团队视图；同名 409（`fieldErrors.name`）；超出条数上限 409；缺共享权限创建团队视图 403（`details.permission`）；`isDefault` 同事务清掉同组旧默认 | — | — | 是 | — | — | P6-03 |
| PUT | `/grid-views/:id` | 同上 | `GridViewBody`（`name`、`config` 至少一项，否则 422）+ `VersionBody` | 修改；版本冲突 409；别人的个人视图 404；团队视图缺共享权限 403；系统视图 409（只读） | — | — | 是 | — | — | P6-03 |
| DELETE | `/grid-views/:id` | 同上 | — | 删除；别人的个人视图 404；团队视图缺共享权限 403；系统视图 409 | — | — | 是 | — | — | P6-03 |
| POST | `/grid-views/:id/default` | 基础 | — | 设为默认；同一表格同一用户至多一个（部分唯一索引兜底），不升版本；**写审计**（`GRID_VIEW_DEFAULT_SET`）；没有“取消默认”接口，要换默认就设另一个 | — | — | 是 | — | — | P6-03 |

以上写接口在内部直连与技术支持访问模式下一律返回 `INTERNAL_ACCESS_UNSUPPORTED`；审计动作为 `GRID_VIEW_CREATED`、`GRID_VIEW_UPDATED`、`GRID_VIEW_DELETED`、`GRID_VIEW_DEFAULT_SET`。
| GET | `/ship-from-addresses` | `inbound.read` | `ScopeQuery` | 发货地址列表，含店铺默认标记 | — | — | — | — | 页码 | P6-08 |
| POST、PUT、DELETE | `/ship-from-addresses`、`/ship-from-addresses/:id` | **`shipfrom.manage`** | `ShipFromBody` + `VersionBody` | 新增（201）、修改（带版本号，冲突 409）、停用与启用（改 `status`）、删除；被入仓计划用过的不能删除（409，只能停用）；同一店铺内名称不重复；每店铺最多 50 个；店铺的第一个地址自动成为默认；列表响应带 `summary` 与 `canManage` | — | — | 是 | — | — | P6-08 |
| POST | `/ship-from-addresses/:id/default` | **`shipfrom.manage`** | — | 设为店铺默认；每店铺至多一个 | — | — | 是 | — | — | P6-08 |
| POST | `/replenishment/batches/:id/to-inbound-drafts` | `replenishment.plan.create` | `ToInboundDraftsBody`（`dryRun`） | `dryRun` 默认 true，只返回预览（分组、数量、缺地址、已转过的建议、`canConfirm`、`blockers`、`remedy`），**状态码 200**；`dryRun=false` 确认：按“店铺 + 发货地址”各生成一份 `FbaInboundPlan` 草稿，`sourceType=REPLENISHMENT_BATCH`、**`sourceRefId` 存批次 id（不是批次号，批次号在草稿名称里）**，并给每条建议追加一条 `INBOUND_DRAFT` 的 `DONE` 动作；另需 `inbound.plan.write`；缺地址、数量为 0、SKU 不在商品目录、建议已转过（已取消的草稿不算）都不能确认，409；同一批次并发确认以批次行锁串行；不调用亚马逊；审计 `FBA_INBOUND_PLAN_CREATED`（每份草稿）与 `REPLENISHMENT_INBOUND_DRAFTED`，预览请求审计为 `REPLENISHMENT_INBOUND_DRAFT_REQUESTED` | — | — | 是 | — | — | P6-08 |
| GET | `/replenishment/intents` | `replenishment.read` | `ScopeQuery` + 分页 | 以前登记过、没有生成草稿的“入仓计划草稿”意图（`PENDING_TARGET` 的 `INBOUND_DRAFT` 动作，且同一建议没有后来的 `DONE` 草稿动作）；受数据范围限制；响应 `{ items: InboundIntentRow[], page, pageSize, total }`，行带批次、店铺、SKU、登记数量与时间 | — | — | — | — | 页码 | P6-08 |
| GET | `/replenishment/forecast-overrides` | `replenishment.read` | `ForecastListQuery`（`status` = UPCOMING/ACTIVE/EXPIRED、`scopeType`、`q`、`sort` 白名单 `from/to/scopeId/updatedAt`） | 人工预测规则列表；响应除分页外带 `today`（企业时区）、`activeCount`/`activeLimit`（未结束规则数与上限 300）、`canManage`、`manageBlockedReason`、`priorityNote`；行带 `status`、`version`、`summary`（一句话规则效果） | — | — | — | — | 页码 | P6-09 |
| POST、PUT、DELETE | `/replenishment/forecast-overrides`、`/replenishment/forecast-overrides/:id` | `replenishment.policy.write`；另要求数据范围是“全部店铺”（规则按 SKU/品类生效、不分店铺） | `ForecastOverrideBody`（`scopeType`、`scopeId`、`from`、`to`、`mode`、`value`、`note`；修改不能换对象，带 `version`） | 新增（201）、修改（乐观锁，冲突 409）、删除；`mode` 为 `FIXED`（件/天，0 表示不卖，上限 1,000,000）或 `YOY_FACTOR`（去年同期日均 × 系数，0.01 到 20）；起止含首尾、最长 366 天、结束日期不能早于今天（422）；对象必须是已有商品（SKU 对应卖家 SKU、品类对应商品类型，否则 404）；**同一对象时间段不能重叠（409，并指出冲突的规则）**；全企业未结束规则最多 300 条（409）；已结束的规则不能改（409）；审计 `REPLENISHMENT_FORECAST_OVERRIDE_CREATED/UPDATED/DELETED`；**规则只影响之后重新计算的批次，已冻结批次不变** | — | — | 是 | — | — | P6-09 |

> **P6-09 实现说明（CR-117）**：
> - **优先级**：同一天里 SKU 规则 > 品类规则 > 模型预测（含订阅省与趋势调整）；同一对象时间段不重叠，所以同一天同一级别至多一条规则。逐天解析：规则 `rate` 为 null（`YOY_FACTOR` 且去年同期没有销量记录）视为规则不生效，这一天回落到模型，并在 `appliedOverride` 里写明原因，不当 0。
> - **`GET /replenishment/recommendations`**：新增查询 `due`（`WEEK` = 建议发货日在今天至今天 + 6 天；`OVERDUE` = 建议发货日早于今天；建议发货日取 `shipDate`，没有发货日时取 `dueDate`）与排序字段 `shipDate`；行新增 `suggestedShipDate`、`shipInDays`（距今天数，负数 = 已逾期）、`supplyInLeadTime`、`supplyBeyondLeadTime`、`unavoidableShortage`、`unavoidableIncluded`、`appliedOverride`（`AppliedOverride[]`）。**旧批次（P6-09 之前计算）没有后五个字段的记录，返回 null / 空数组，页面写“旧批次没有记录”，不显示 0。**
> - **提前期内外供给**：按入库类型估算预计到仓时间（已接收 = 接收天数；在途（已发货）= 最慢运输时效 + 接收天数；备货中 = 国内段 + 最慢运输时效 + 接收天数；策略里没有运输选项时全部算提前期内）；预计到仓晚于“目标覆盖的提前期”的部分是提前期外供给，**只有提前期内供给参与建议量**。没有逐票预计到仓时间，所以是按类型的估算。
> - **必断货量**：快船也赶不上的缺口 = max(0, 最快运输提前期内的需求 − 最快提前期内能到的供给)；默认不计入建议量（建议量里先扣掉）；策略开关 `includeUnavoidableShortage`（`PUT /replenishment/policies` 请求体与策略行、审计快照都带它，属于策略版本，默认 false）打开后计入。
> - **快照**：`snapshot` 新增 `overrideUsed`（用了人工规则的 SKU 数）、`unavoidableSkus`、`unavoidableIncludedSkus`；`calcStepsJson` 新增冻结键 `supplyInLeadTime`、`supplyBeyondLeadTime`、`unavoidableShortage`、`unavoidableIncluded`、`appliedOverride`。
| PUT | `/inbound/plans/:id/boxes` | `inbound.plan.write` | `InboundBoxesBody`（沿用 P2a-12：`version` + `boxes[]`）+ `VersionBody` | 保存装箱草稿（整体替换现有箱子）；版本冲突 409；状态不是“装箱方案已确认”或有操作在途 409；**P6-10 已实现（CR-118）**，与文件导入共用同一个保存函数（箱号查重、SKU 须在计划内、缺箱号自动编号 BOX-001、版本锁事务、审计 `FBA_INBOUND_BOXES_SAVED`） | — | — | 是 | — | — | P6-10 |
| POST | `/inbound/plans/:id/boxes/import` | `inbound.plan.write` | `InboundBoxImportBody`（`version`、`kind`=`MIXED`/`ORIGINAL`、`fileName`、`content`，严格模式）；`content` 是 CSV 文本，不超过 400000 字符 | 导入装箱：关键列缺失、任何一行有错整份拒绝（422，`fieldErrors.content` 逐行写“第 N 行：原因”，不改数据）；最多 2000 行；完全相同的行跳过并写进响应的 `skipped`；成功响应 201 `{ plan, state:'SAVED', imported:{ boxTypes, boxes, units }, skipped }`；整体替换现有箱子；审计 `FBA_INBOUND_BOXES_IMPORTED`（带文件名、行数、跳过行数）；状态与版本规则同上 | — | — | 是 | — | — | P6-10 |
| GET | `/inbound/box-templates/:kind` | `inbound.read` | — | 装箱导入模板 `{ kind, label, fileName, content, hint, maxRows, columns:[{ label, required }] }`（`kind` 为白名单 `MIXED`/`ORIGINAL`，其余 404）；`content` 是 UTF-8 带 BOM、CRLF 的 CSV（表头加示例行），页面拿它生成下载文件 | — | — | — | — | — | P6-10 |

> **P6-10 实现说明（CR-118）**：
> - **文件格式是 CSV，不是 xlsx**：仓库没有 xlsx 依赖，也不新增（Excel 里“另存为 CSV”即可）；分隔符认逗号、制表符、分号；表头认中英文别名（`BOX_COLUMNS`）。如要支持 xlsx，要先决定引入哪个库，留给 P6-11（装箱单自动匹配要读供应商的 xlsx，一起解决）。
> - **混装模板**列：箱号、SKU、每箱数量、重量(磅)、长、宽、高(英寸)、相同箱数（选填，默认 1）；同箱号的多行合并成一个箱子，尺寸重量以第一行为准、其余行必须一致。**原厂包装模板**列：SKU、每箱件数、箱数、重量、长、宽、高；一行一种规格，不写箱号，保存时自动编号。
> - **整份拒绝的情形**：缺关键列、数字不合法（每箱数量与相同箱数要正整数，重量与尺寸要大于 0 且不超过 100000）、SKU 不在计划内、同箱号规格不一致、同箱同 SKU 重复、箱型超过 500 个（`INBOUND_MAX_BOXES`，行数上限 2000 是行，不是箱型）、行数超 2000；最多收集 50 条错误。
> - **两个纯函数契约（零 zod）**：`inbound-box-draft.ts`（装箱草稿：加箱、复制、批量设箱规、底部合计、保存前本地校验）与 `inbound-box-file.ts`（模板与文件解析），页面与服务端共用同一份解析规则；只有请求体的 zod 校验放在 `inbound-box-import-query.ts`（前端不引用）。
> - **流程骨架**：`inbound-flow.ts`（零 zod）按阶段算五步状态：各步的起止阶段固定（选品=草稿到已创建；装箱=已创建到箱内物品已提交；分仓=到分仓已确认；运输=到运输已确认；标签与发货=到已发货）；有操作在途时落在该操作所属的步骤（取消不属于任何一步，落在当前步骤），该步写“亚马逊正在处理：…”；上一次失败的信息记在当前步骤并标“出错”（当前版本不记录是哪一步的操作失败，只能算到当前步骤）；已取消的计划各步“未开始”并写“计划已取消”。
| POST | `/inbound/plans/:id/packing-list/parse` | `inbound.plan.write` | `PackingListParseBody`（`fileName`、`format`=`CSV`/`XLSX`、`content`（CSV 文本，或 xlsx 的 base64）、`supplierId?`、`sheet?`、`headerLine?`、`columns?`、`units?`、`defaults?`，严格模式） | 解析与匹配预览，**不改任何数据**（状态码 200；`@Write` 用 `audit:false`，只做权限与幂等）；CSV 不超过 400000 字符，xlsx 的 base64 不超过约 600 KB，最多 2000 行，超限 422；响应 `PackingPreviewResponse`（表头、列对应及来源、单位及来源、逐行匹配结果、候选、跳过的行、`canApply`、`canRemember`、`existingBoxTypes` 等） | — | — | — | — | — | P6-11 |
| POST | `/inbound/plans/:id/packing-list/apply` | `inbound.plan.write` | 同上 + `version` + `decisions[]`（`{ line, sku?, ignore?, remember? }`，最多 2000 条，行号不得重复） | 服务端**重新读取同一份文件并重新匹配**，只信任人工决定；有任何未解决的行或箱规问题整份拒绝（422，`fieldErrors.content` 逐条写行号）；整体替换现有箱子（与 `PUT /boxes` 共用同一个保存函数）；`remember` 为真的行在**同一个事务里**写入外部货号映射（要 `skualias.manage`，没有则 403，箱子也不写）；版本冲突 409；审计 `FBA_INBOUND_PACKING_LIST_APPLIED`（带文件名、新增与更新的映射数、忽略行数）；响应 `{ plan, state:'SAVED', imported:{ boxTypes, boxes, units }, ignored, remembered }` | — | — | 是 | — | — | P6-11 |
| GET | `/sku-aliases` | `inbound.read` | 查询 `q`、`supplierId`（或 `GENERAL` 只看通用）、`source`、`sort`（`externalCode`/`sku`/`updatedAt`）、`page`、`pageSize` | 外部货号映射列表（带目录里的 SKU 标题、统计、`canManage`） | — | — | — | — | 页码 | P6-11 |
| POST、PUT、DELETE | `/sku-aliases`、`/sku-aliases/:id` | **`skualias.manage`** | `SkuAliasCreateBody`（`supplierId?`、`externalCode`、`sku`）；`SkuAliasUpdateBody`（`version`、`externalCode?`、`sku?`，供应商不能改） | 新增、修改、删除；`(供应商, 外部货号)` 唯一（供应商为空时用部分唯一索引兜底），冲突 409；SKU 须是商品目录里已有的（422）；改带版本号；每个企业最多 50000 条；审计 `SKU_ALIAS_CREATED`/`_UPDATED`/`_DELETED` | — | — | 是 | — | — | P6-11 |
| POST | `/sku-aliases/import` | **`skualias.manage`** | `{ fileName, content }`（CSV，不超过 400000 字符、2000 行） | 整份校验、一个事务、按（供应商, 外部货号）更新或新增；任何一行有错整份拒绝（422，逐行写原因）；状态码 200；响应 `{ total, created, updated }`；审计 `SKU_ALIAS_IMPORTED` | — | — | 是 | — | — | P6-11 |
| GET | `/sku-aliases/export` | `inbound.read` | — | `{ fileName, content（UTF-8 带 BOM 的 CSV，与导入模板同列）, rows, truncated }`；最多 19999 行（单次查询上限 20000，多取一行判断是否被截断） | — | — | — | — | — | P6-11 |
| GET | `/packing-list-mappings`、`/packing-list-mappings/:supplierId` | `inbound.read` | — | 各供应商保存的装箱单列映射（标准列 → 表头文字，单位）；单个接口在没有保存时 `mapping` 为 null | — | — | — | — | — | P6-11 |
| PUT、DELETE | `/packing-list-mappings/:supplierId` | **`skualias.manage`** | `PackingListMappingBody`（`version?`、`columns`、`units?`） | 保存与删除；**已有映射时必须带 `version`，没有时不带**（否则 409）；审计 `PACKING_LIST_MAPPING_SAVED`/`_DELETED` | — | — | 是 | — | — | P6-11 |

> **P6-11 实现说明（CR-119）**：
> - **匹配顺序**：SKU → FNSKU → ASIN 精确比对 → 外部货号映射（供应商专属优先于通用，且目标 SKU 必须在这个计划里）→ 相似候选（Dice 二元组相似度加包含关系加成，≥0.35，最多 5 个，**只提示，永远不自动采用**）。商品条码（UPC、EAN）目录里没有这个字段，**尚未接入**，页面如实说明，可以先把条码记到外部货号映射里。
> - **文件格式**：CSV（逗号、制表符、分号）与 xlsx。xlsx 用仓库已有的 `fflate` 自写最小读取器（`platform/xlsx-reader.ts`），不引入新的重依赖：只解压工作簿、关系、共享字符串与工作表，限制文件大小、行数、列数；**老版 `.xls` 不支持**，页面提示另存为 xlsx 或 CSV。
> - **两步分析**：先 `preparePacking`（读表头、列、单位、行）→ 取出所有货号 → **一次**查映射 → `finishPacking`（匹配、算箱规）；不存在逐行查库。单位按“本次选择 → 该供应商保存的 → 表头里写的（kg、lb、cm、in）→ 默认厘米与千克”确定，换算成入仓接口用的英寸与磅（保留两位小数）。
> - **契约与前端共用**：`packing-list*.ts`（零 zod）里的 `analyzePacking`、`resolvePacking`、`buildPackingBoxes` 页面与服务端共用，应用按钮的状态与服务端判断一致；请求体 zod 在 `packing-list-query.ts`（前端不引用）。
> - **权限与写入**：预览与应用要 `inbound.plan.write`（先验权限再解析）；列映射与外部货号映射的写要 `skualias.manage`（预设管理员与供应链角色有，权限点共 95 个）；读要 `inbound.read`。应用只改本地装箱草稿，提交给亚马逊是单独的动作。
| GET、POST、PUT、DELETE | `/label-templates` | `inbound.read`；写 **`labeltemplate.manage`** | `LabelTemplateCreateBody`、`LabelTemplateUpdateBody`（带 version，乐观锁） | 标签模板与箱号规则；同名 409，每企业最多 50 个，全企业一个默认；列表带 `canManage` 与 `manageBlockedReason` | — | — | 写入是 | — | 页码（排序 name、updatedAt） | P6-12（已实现） |
| POST | `/inbound/shipments/:id/labels/custom` | `inbound.plan.write`（另需 `inbound.read`、`export.create`） | `CustomLabelBody`（templateId?、startNumber?） | 返回 `LabelGenerateResponse`（导出任务编号与说明）；`:id` 是我方货件行编号；以已取到的亚马逊箱标签 PDF 为底（缺则 409 并写明页面类型）；本地生成，不调用亚马逊，不受写入开关控制 | — | — | 是 | — | — | P6-12（已实现） |
| POST | `/inbound/plans/:id/item-labels` | `inbound.plan.write`（另需 `inbound.read`、`export.create`） | `ItemLabelBody`（size、shipmentId?、showTitle、showCondition、skipMissingFnsku） | 返回 `LabelGenerateResponse`；body 里的 `shipmentId` 是我方货件行编号；缺 FNSKU 默认 409 并列出 SKU；一次最多 1000 个 SKU、20000 张（超出 422） | — | — | 是 | — | — | P6-12（已实现） |
> **P6-13 实现说明（CR-121）**：
> - **时间口径**：`timeBasis=return`（默认，按退货发生日）或 `order`（按下单日，只统计能确定下单时间的退货）；缺下单时间的退货不并入也不丢弃，响应的 `unknownOrderRows`（条数）与 `unknownOrderUnits`（件数）单独计数（M-704），页面写“无法计算周期 N 条”。同一个子路径不接受它不适用的参数（422）：`anchor`（`order`/`ship`）、`bounds`（天数段上界，如 `7,14,30,60,90`，严格递增、最多 10 个、每个 1 至 1095）、`dimension`（`none`/`asin`/`reason`/`disposition`）只属于 `/cycle`。
> - **静态路径排在 `/returns/:id` 之前**；`GET /returns/analysis`（P2b-02 的旧接口）原样保留，新页面改读 `/returns/analysis/summary`（旧接口的“评论交叉”占位随旧页面一起去掉）。读取明细上限 20000 行，触到时 `truncated=true`；退款金额占比最多核对最近 500 个订单（`refund.state=PARTIAL`）。
> - **退货原因三层**：预置 22 个代码在代码里（`RETURN_REASON_PRESETS`），企业改过的预置项、自己加的项和导入时自动发现的新代码（大类“未分类”）存在 `ReturnReasonMap`，读时叠在预置之上；`/returns` 列表与 `/returns/:id` 详情的原因都带 `reasonCategory` / `reason.category`。
> - **映射写入**：`PUT /returns/reason-map` 一次最多 50 行、同一代码不重复；每企业映射表最多 500 行（超出 409）；写 `settings.write`、读 `returns.read`，写审计 `RETURN_REASON_MAP_UPDATED`（事务内），被拒也留一条 DENIED 审计；列表分页（排序 `code`、`category`、`updatedAt`，筛选 `category`、`q`），带 `summary`、`canManage` 与 `manageBlockedReason`。
| GET | `/returns/analysis/summary`、`/cycle`、`/cross-month`、`/cohort`、`/disposition-matrix` | `returns.read` | `ReturnBasisParams`（`/cycle` 为 `ReturnCycleParams`）加 `ScopeQuery` | 概览（趋势、ASIN、原因三层、大类、处置、异常榜与改善榜）、退货周期（M-700、M-701）、跨月退货（M-702）、队列退货率（M-703）、库存属性×处置结果矩阵；时间口径可切换，缺下单时间的退货单独计数（M-704） | — | — | — | — | — | P6-13（已实现） |
| GET、PUT | `/returns/reason-map` | `returns.read`；写 `settings.write` | `ReturnReasonMapQuery`（读）、`ReturnReasonMapBody`（写） | 原因代码到中文释义与大类的映射；未映射的新代码导入时自动加入并标“未分类”；列表页码分页，每企业最多 500 行 | — | — | 写入是 | — | 页码（排序 code、category、updatedAt） | P6-13（已实现） |
> **P6-14 实现说明（CR-122）：`POST /pii/reveal` 是全站个人信息明文的唯一出口。**
>
> - 请求 `{ objectType: 'ORDER' | 'RETURN' | 'SUPPORT_CONTACT', objectId, fields[], reason }`（严格模式；字段必须属于该对象：订单 `buyerName`、`buyerEmail`、`buyerPhone`、`addressLine1`、`city`、`state`、`postalCode`、`country`，退货 `customerComments`，支持沟通 `body`；一次最多 8 个；理由 2 至 500 字）。响应 `{ objectType, objectId, state, values, expiresAt, retainedUntil, note }`，`state` 为 `OK`、`EXPIRED`（过了保留期、已清除）、`NOT_SYNCED`（没有内容）；`expiresAt` 是明文展示的截止时间（默认 60 秒，不超过 `retainedUntil`）。**HTTP 200**。
> - 判定顺序：`field.buyer`（无 403，先于参数校验，并写一条 DENIED 审计）→ 请求体校验（理由为空等 422）→ 取对象（先过对象自己的读权限与数据范围，别的企业或不在成员范围内都是 404）→ 解密 → **写审计 `PII_REVEALED` 成功后才返回明文**（审计写入失败则不返回明文）。审计的对象类型是真实对象（`Order`、`FbaReturnCase`、`SupportContact`），详情含对象编号、字段名、理由、结果状态，不含明文。
> - 其他接口一律不返回明文：订单详情只给 `buyerInfo` 状态；退货详情的 `buyerComments` 是 `{ state: NONE | AVAILABLE | EXPIRED, kinds[], retainedUntil }`（不再有 `text`）；支持案件沟通的 `body` 是**已掩码的文字**（电话、邮箱、地址换成 `[电话已隐藏]` 等），并带 `piiKinds[]`。`POST /orders/:id/pii-access` 已下线。
> - 退货买家备注加密保存（`FbaReturnCase.customerCommentsCipher`、`customerCommentsExpiresAt`、`customerCommentsKinds`），与买家信息同一密钥用途（`buyer-pii`）与保留规则（发货日起不超过 30 天）；存量明文由后台任务 `backfill-return-comments` 加密并清空。
| POST | `/pii/reveal` | `field.buyer` | `{ objectType, objectId, fields[], reason }` | 返回 `{ objectType, objectId, state, values, expiresAt, retainedUntil, note }`；理由为空 422；没权限 403；跨企业 404；写审计；**全站个人信息明文唯一出口** | — | — | 是 | 沿用“查看买家信息” | — | P6-14（已实现） |
| POST | `/alerts/read` | `alerts.read` | `{ ids[] }`（1 至 100 条，**已实现，CR-123：上限由 200 改为 100**） | 批量标记已读，只写当前用户（`AlertRead`，幂等）；已处理状态不受影响；不在成员数据范围内或不存在的编号记入 `missing`；返回 `{ marked, missing, unreadCount }`；`@Write` 声明 `audit:false`（已读不进审计） | — | — | — | — | — | P6-15 |
| POST | `/alerts/handled` | `alerts.handle` | `{ ids[]（1 至 100）, note? }` | **CR-123 新增**：批量标为已处理；逐条走单条关闭（结论“已处理”，关联待办同步、时间线、逐条审计 `ALERT_CLOSED`）；不存在、范围外、已被他人处理的记入 `skipped[{id,reason}]`，不让整批失败；返回 `{ handled, skipped, unreadCount }` | — | — | 是 | — | — | P6-15 |
| GET | `/alerts/templates` | `alerts.read` | — | 由预置规则生成的模板，按库存、广告、销售、流量、店铺分组，每条一句话条件与适用维度；**已实现（CR-123）**：`{ state, note, items[{ code, type, group, name, condition, dimension, severity, cooldownMinutes, params, ruleCount, enabledCount }], can: { create } }`，`ruleCount` 是企业里同评估逻辑的规则数（含自定义与停用），`can.create` 看 `alerts.manage` | — | — | — | — | — | P6-15 |
| POST | `/alerts/rules/preview` | `alerts.manage` | `AlertRulePreviewBody` | 用最近 7 天数据试算会触发多少对象；有对象数上限与超时，超时返回已算部分并标 `partial` | — | — | — | — | — | P6-16 |
| GET | `/tools/hijack` | **`tools.read`** | `ScopeQuery` | 其他报价方列表（出现时间、报价、是否 FBA、是否拿到购物车），页面写明数据延迟 | — | — | — | — | 游标 | P6-17 |
| GET、POST、DELETE | `/tools/hijack/whitelist` | 读 **`tools.read`**；写 **`tools.manage`** | `HijackWhitelistBody` | 白名单；重复 409 | — | — | 写入是 | — | 页码 | P6-17 |
| GET | `/promotions/stacking` | `analytics.read`（与 `/promotions` 一致） | `ScopeQuery` | 同一 ASIN 同期叠加促销数与折扣深度 | — | — | — | — | 游标 | P6-17 |
| GET | `/finance/profit-items` | `finance.read` | — | 利润项目字典整树（最多三级）、交易类型映射、近 30 天笔数、未映射个数、当前版本号；企业第一次读取时按内置口径自动生成第一版（不写审计） | — | — | — | — | — | P6-18 ✓ |
| PUT | `/finance/profit-items` | **`finance.profititem.manage`** | `ProfitItemTreeBody` + `VersionBody` | 整树保存（items 全量、mappings 全量，缺少的自定义项目视为删除）；系统项目不可删、可改名；同级重名、超过三级、映射到不接收交易的项目 422；版本冲突 409（details.currentVersion）；成功后生成新口径版本并写审计 `PROFIT_ITEMS_SAVED` | — | — | 是 | — | — | P6-18 ✓ |
| GET | `/finance/profit-items/unmapped` | `finance.read` | — | 没有映射的交易类型（最近 90 天出现过），按近 30 天笔数排序，附内置口径下归到的项目 | — | — | — | — | 页码 | P6-18 ✓ |
| GET、POST、PUT | `/finance/allocation-rules` | `finance.read`；写 `finance.policy.write` | `AllocationRuleBody` | 费用分摊规则，按月生效；**已实现（CR-128）**：GET 分页（含费用项与依据说明），POST 新建（201；同费用项同月已有规则 409），PUT 带 `id`+`version` 改依据或手动比例（旧版本 409）；已关账月份拒绝；审批表未建，先直接写并留审计 | — | — | 写入是 | 沿用“修改财务口径” | — | P6-19 |
| POST | `/finance/allocation-rules/preview` | `finance.read` | `{ month, rule }` | 某月按新规则的分摊结果与差异；不改动已关账月份；**已实现（CR-128）**：返回 200、不落库、不写审计，按店铺×SKU 对比当前规则 | — | — | — | — | — | P6-19 |
| GET、POST、PUT、DELETE | `/finance/estimated-fees` | `finance.read`；写 **`finance.estimatedfee.write`** | `EstimatedFeeBody` | 预估与自定义费用；响应与利润里标“估算”；**已实现（CR-129）**：GET 分页（带可选费用项、店铺、说明），POST 新建（201；生效区间重叠 409），PUT 带 `id`+`version` 整条覆盖（旧版本 409），DELETE 走查询参数 `id`+`version`；写需要“全部店铺”数据范围；审批表未建，先直接写并留审计 | — | — | 写入是 | — | 页码 | P6-20 ✓ |
| POST | `/finance/estimated-fees/import` | **`finance.estimatedfee.write`** | 文件 | 一行有错整份拒绝；**已实现（CR-129）**：CSV，费用项按名称或“上级 / 项目”，店铺按名称或编号，文件内与库里区间重叠也整份拒绝，错误带行号 | — | — | 是 | — | — | P6-20 ✓ |
| GET | `/finance/cashflow/funnel` | `finance.read` | `ScopeQuery` | 回款漏斗；缺数据显示“未接入”而不是 0；**已实现（CR-129）**：最近 90 天入账→释放/递延→已公布打款→已到账/应收，回款率，近 180 天未退还预留金；各币种分别汇总、不换算 | — | — | — | — | — | P6-20 ✓ |
| GET、PUT | `/settings/business-rules`、`/settings/business-rules/:key` | 读 `settings.read`；写 **`settings.business.write`** | `BusinessRuleBody` + `VersionBody` | 业务口径；修改生成新口径版本，走审批；**已实现（CR-130）**：PUT 带 `version`（最新版本号）+`value`+`reason`，已有待审批 409，值与当前相同 422，需再验证身份 `finance.policy` | — | — | 是 | 沿用“修改财务口径（审批环节）” | — | P6-31 ✓ |
| GET、PUT | `/finance/profit-formula` | 读 `finance.read`；写 `finance.policy.write` | `ProfitFormulaBody` | **已实现（CR-130）**：利润公式（计入毛利润、毛利率分母的项目）；修改走审批，默认公式与改版前数字一致 | — | — | 是 | 沿用“修改财务口径（审批环节）” | — | P6-31 ✓ |
| GET | `/metric-versions` | `settings.read` | `kind` | 口径版本列表；**已实现（CR-130）** | — | — | — | — | 页码 | P6-31 ✓ |
| POST | `/metric-versions/:id/decision` | `finance.policy.write` | `{ decision, comment, version }` | **新增（CR-130）**：通过或驳回，发起人不能通过自己的修改（可撤回）；同一类型只保留一个生效版本；驳回写意见；需再验证身份 | — | — | 是 | — | — | P6-31 ✓ |
| POST | `/metric-versions/:id/diff-report` | `finance.read`、`settings.read`（并需 `field.profit`） | `{ from, to }` | 按新旧口径对同一区间出差异报告；区间不超过 366 天；不改写任何快照，已关账月份标出；**已实现（CR-130）** | — | — | 是 | — | — | P6-31 ✓ |
| GET | `/products/:id/compare` | `products.read` | `ScopeQuery` | 同一商品两个时间段（或两个站点）的指标对比 | — | — | — | — | — | P6-21 |
| GET | `/products/:id/competitor-compare` | `products.read`、`competitors.read` | `ScopeQuery` | 与竞品并列对比；事件走 `/events` | — | — | — | — | — | P6-21 |
| POST | `/analytics/product-performance/query` | `analytics.read` | `ProductPerformanceQuery` | 宽表行（`items`、`total`、`page`、`pageSize ≤ 200`，另含 `allowed`、`restrictions`、`gaps`、`truncated`、`compare`）；`dimension` 七选一，`parentAsin` 仅 ASIN 维度；`field.profit`、`field.cost`、`ads.read`、`inventory.read` 没有时整组不返回并写入 `restrictions`；按受限字段排序 403；聚合单元上限 19,999，超出 `truncated=true` | — | — | — | — | 页码 | P6-22 |
| POST | `/analytics/product-performance/summary`、`/trend`、`/async-columns` | `analytics.read` | 同上 | 汇总行 `{totals,currency}`（等于明细之和）；`trend` 请求 `{dimension,ids ≤ 100,metric}` 返回 `{rows:{id:{trend}},days}`；`async-columns` 请求 `{dimension,ids ≤ 100}` 返回 `{rows,gaps,truncated}`（库存、退货率、退款率、评分，缺数据的列单独标注） | — | — | — | — | — | P6-22 |
| GET | `/ads/:level/counts` | `ads.read` | 范围参数 + 对应层级列表的全部筛选（区间、状态等；忽略 `bucket`、`cursor`、`pageSize`、`sort`） | 分类计数（有成交、有点击无成交、有曝光无点击、无曝光，互斥，另给 `withoutMetrics`）；`level` 取值为白名单（campaigns、ad-groups、targets、search-terms、products），其余 404；权限先于参数校验 | — | — | — | — | — | P6-23 |
| GET | `/ads/campaigns/:id/budget-timeline` | `ads.read` | `from`、`to` | 预算调整时间线（CR-134 实现为“超预算时间条 + 归因窗口”：近 14 天每天 24 小时、累计花费对日预算；范围倒置或超 14 天 422；范围外活动 404；数据流未配置 `NOT_CONNECTED`） | — | — | — | — | — | P6-24 |
| POST | `/ads/keywords/bulk-add` | `ads.keyword.write` | `BulkKeywordBody` | 经过写入流水线；数量有上限；批量时每条独立记录结果（CR-134：`mode` 为 `KEYWORD`/`NEGATIVE`，否定投放走 `ads.negative.write` 与 `sw.ads.negative`；一批最多 50 个；已存在与批内重复的词跳过并返回 `skipped`；全部已存在返回 `NOTHING_TO_ADD`；支持 Idempotency-Key） | `sw.ads.keyword` | 影响 | 是 | — | — | P6-24 |
| GET | `/ads/conflicts`、`/ads/duplicate-keywords` | `ads.read` | `ScopeQuery` | 投放冲突与重复关键词（CR-134：`cursor`、`pageSize`≤200、`q`；冲突另有 `kind`，重复词另有 `matchType`） | — | — | — | — | 游标 | P6-24 |
| GET | `/analytics/sales-stat` | `analytics.read` | `SalesStatQuery`（dimension、granularity、metric、q、sort、page、pageSize + 范围） | 销量统计：返回 `buckets`、`rows[].values`、`summary`（全部行合计）、`inventoryBasis`、`truncated` | — | — | — | — | 页码 | P6-25 |
| GET | `/inventory/all-warehouses` | `inventory.read` | `AllWarehousesQuery`（q、sort、page、pageSize + 范围） | 跨仓总览：`items[].cells/children`、`summary`、`restrictions`（无仓库读取权限的列）；货值需 `field.cost` | — | — | — | — | 页码 | P6-25 |
| GET | `/inventory/movement` | `inventory.read` | `MovementQuery`（q、unbalanced、sort、page、pageSize + 范围） | 进销存报表：`items`（期初、6 类变动、期末、差额、周转、货值）、`totals`、`unbalancedCount`；货值需 `field.cost` | — | — | — | — | 页码 | P6-25 |
| GET、POST、PUT、DELETE | `/first-mile/carriers`、`/first-mile/carriers/:id`、`/:id/channels`、`/:id/channels/:channelId`、`/:id/channels/:channelId/rates`、`/:id/channels/:channelId/rates/:rateId` | `firstmile.read`；写 `firstmile.write` | `CarrierCreateBody`、`CarrierUpdateBody`、`ChannelCreateBody`、`ChannelUpdateBody`、`RateCreateBody`、`RateUpdateBody`（`packages/api-contracts/src/carriers.ts`） | 物流商 → 渠道 → 阶梯报价。列表一次带出物流商与其渠道（`canManage`、`manageBlockedReason`）；重复代码 409；修改带 `version`（乐观锁，过期 409）；渠道被运单使用不能删（409）；同渠道、同地区、重量段与生效区间同时重叠的报价 409；报价单价 `unitPrice` 属成本字段，无 `field.cost` 不返回 | — | — | 写入是 | — | 页码 | P6-26 |
| POST | `/first-mile/:id/estimate` | `firstmile.read` | `EstimateBody`（`channelId?`、`region`） | 预估头程费用：只读试算，**不落库**；计费重量 = 实重与体积重取较大（体积重 = 体积 × 1,000,000 ÷ 材积除数，超出实重的部分按分抛系数折算），按目的地区与重量段（含下限、不含上限）找生效阶梯价；缺重量体积、无报价、币种不一致时 `state=BLOCKED` 并写明原因；金额 `estimate.amount` 需 `field.cost`。采用预估走 `PATCH /first-mile/:id`（`carrierChannelId` + `estimatedCost`，同时记 `estimatedAt`） | — | — | 否（已声明 `@Write` 且 `audit:false`） | — | — | P6-26 |
| POST | `/first-mile/:id/items/fill` | `firstmile.write` | `FillItemsBody`（`version`、`rows[{sku, weightKg?, volumeCbm?}]`） | 批量补录明细缺失的重量或体积：只补空着的格子，已有值不覆盖；分摊或出库后拒绝；版本加一；审计 `FIRST_MILE_ITEMS_FILLED`。运单详情 `GET /first-mile/:id` 新增 `missingFields`（缺项与按商品档案算出的建议值）与 `qtyCheck`（运单明细、国内仓出库、关联货件已发三处数量核对） | — | — | 是 | — | — | P6-26 |
| GET | `/first-mile`（P6-26 增补） | `firstmile.read` | 新增 `deviation=1`、`deviationPct`（缺省 20） | 异常单筛选：预估与实际费用偏差比例绝对值达到阈值；需 `field.cost`；扫描上限 5000 | — | — | — | — | 页码 | P6-26 |
| GET | `/inbound/shipments/discrepancies` | `inbound.read` | `ScopeQuery` + `gap`（`DECLARED_GT_SHIPPED`、`DECLARED_GT_RECEIVED`、`SHIPPED_GT_RECEIVED`）、`q`、`page`、`pageSize` | 货件三种差异汇总：申报（分仓方案预计件数）、已发（各 SKU 已发合计）、签收（接收合计）三列，加两两相减的三种差异；签收相关差异只在货件关闭后判定，缺数据为 null（页面写“尚无记录”）；最近更新的 5000 个货件内过滤，超出时 `truncated=true`。**实现取页码分页**（需要跳页看第几页，且筛选在内存中完成，游标无法稳定） | — | — | — | — | 页码 | P6-26 |
| GET | `/approvals` | 基础 | `box`（`TODO`/`SENT`/`CC`/`DONE`，默认 `TODO`）、`state`（`PENDING`/`DONE`，默认 `PENDING`）、`limit`、`cursor`；响应带各信箱待处理数 | 只含与当前用户有关的单据；跨企业的单据不可见 | — | — | — | — | 游标 | P6-27 |
| POST | `/approvals/:id/decision` | 按单据类型沿用原模块审批权限 | `{ decision, comment, version }` | 通过或驳回；审批人与发起人相同拒绝；已被他人处理 409；状态变化回写各模块 | — | — | 是 | 沿用原单据 | — | P6-27 |
| POST | `/tools/pricing-calculator/estimate` | **`tools.read`** | `PricingEstimateBody`（`packages/api-contracts/src/pricing-calculator-query.ts`） | 新品定价试算（CR-154）：未上架也可算。无参考 ASIN 或未选店铺时按美国站公开费率表当场估算并标明“模型估算”（`US-FBA-2025-NONPEAK`）。有参考 ASIN 且店铺已授权时创建 `PRICING_FEE_ESTIMATE` 同步任务，由 worker 调 Product Fees `POST /products/fees/v0/items/{asin}/feesEstimate`（只对第一个售价打一次）。同样参数 24 小时内复用 `PricingCalcRecord`（不另用 Redis）。每企业每分钟最多 10 次新参数，超出 429 `RATE_LIMITED`。403 记新鲜度 `FEES_ROLE_PENDING` 并不再入队，响应写明“没有费用预估权限”。`@HttpCode(200)`，`@Write audit:false`（只读试算） | — | — | 否（已声明 `@Write` 且 `audit:false`） | — | — | P6-29 |
| GET、POST | `/tools/pricing-calculator/records` | **`tools.read`** | GET：`page`、`pageSize`；POST：`{ id, name? }` | 试算记录只看自己的，且只列出 `saved=true`（CR-154）。保存把本人提交的那条标成已保存，别人的编号 404。审计 `PRICING_CALC_SAVED` | — | — | 写入是 | — | 页码 | P6-29 |
| GET | `/analytics/brand/share-trend` | `analytics.read` | `asin`（10 位；可带店铺范围参数） | 关键词份额趋势（CR-154）：只读品牌分析搜索查询表现周报的展示份额与点击份额，同一周期同一搜索词多店只留展示次数最高的一行，不把市场总量相加。固定文案“这不是前台排名”。没有 `analytics.brand.read` 时 200 且 `state=RESTRICTED`，不返回 403。最近 16 个周期，超出 `truncated` | — | — | — | — | — | P6-29 |
| GET | `/report-sources` | `reports.read` | — | 可用数据源及其维度、指标。**已实现（CR-155）**：商品表现、订单利润、广告（仅活动维度）、库存、退货；查询复用各模块已有服务 | — | — | — | — | — | P6-32 |
| POST | `/report-sources/:code/query` | `reports.read` 再加数据源权限 | `ReportQuery`（`report-source-query.ts`）；日期在查询串 | **已实现（CR-155）**：先 `reports.read`，再数据源权限，最后校验。页大小上限 200，日期最长 366 天，8 秒超时返回 `QUERY_TIMEOUT`。没有字段权限的自定义指标整列不返回，并写入 `restrictions`。游标：商品表现与库存是 `p:页码`，其余沿用原接口游标 | — | — | 否（`@Write audit:false`） | — | 游标 | P6-32 |
| GET、POST、PUT、DELETE | `/custom-metrics` | 读 `reports.read`；写 **`reports.custom.write`** | `CustomMetricBody` + `version` | **已实现（CR-155）**：公式只能引用字典或本企业已有自定义指标；除以常数 0、未知指标、循环引用拒绝。expression 存 `{ text, ast }`。每企业最多 100 个。POST 201。保存后字典类型为“自定义” | — | — | 写入是 | — | 页码 | P6-32 |
| POST | `/custom-metrics/validate` | `reports.read` | `{ expression, key? }` | **已实现（CR-155）**：校验不落库，`@Write audit:false`，返回 `ok`、`issues`、`refs`、`gates` | — | — | 否 | — | — | P6-32 |
| GET、POST、PUT、DELETE | `/custom-reports` | 读 `reports.read`；写 **`reports.custom.write`**（把 `shared` 从否改成是需要 **`reports.custom.share`**） | `CustomReportBody` + `version` | **已实现（CR-155）**：列表是自己的加共享的。收藏是 `starredBy`（PUT `starred`）。定时 `{ frequency, hour, weekday? }` 按 UTC，存在 `schedule`。非所有者只能改自己的收藏。每企业最多 100 张。POST 201 | — | — | 写入是 | — | 页码 | P6-32 |
| POST | `/custom-reports/:id/run` | `reports.read`（结果超过一页另需 `export.create`） | `{ cursor?, pageSize? }` | **已实现（CR-155）**：按调用人权限取数。第一页没有更多则 `mode=INLINE`。否则由 API 翻页（最多 2000 行、约 20 秒）写入导出任务 `kind=custom-report`，列 `id`、`label`、`valuesJson`。`@Write audit:false` | — | — | 否 | — | — | P6-32 |
| GET | `/dashboards/tree` | 基础 | — | 文件夹与仪表盘树（自己的与共享的）。**P6-33 已实现（CR-156）**：另有文件夹增删改 `POST/PUT/DELETE /dashboards/folders` | — | — | — | — | — | P6-33 |
| GET、POST、PUT、DELETE | `/dashboards`、`/dashboards/:id` | 基础；写 **`dashboard.write`**（把 `shared` 设为 true 需要 **`dashboard.share`**，先于参数校验） | `DashboardBody` + `version` | 仪表盘。省略 `shared`、`folderId`、`refreshMinutes` 时保留原值。布局必须正好包含当前全部组件。每个成员最多 50 个仪表盘、50 个文件夹 | — | — | 写入是 | — | 页码 | P6-33 |
| GET、POST、PUT、DELETE | `/dashboards/:id/widgets`、`/dashboards/:id/widgets/:widgetId` | 同上；GET 为登录即可 | `WidgetBody` | 组件上限每盘 24。`GET .../:widgetId` 按查看人执行查询：没有数据源权限或查询被拒时 HTTP 200、`state=RESTRICTED`、`message=无权查看`；非表格且 0 行是 `EMPTY`；文本是 `TEXT`。列表与详情不批量执行查询 | — | — | 写入是 | — | — | P6-33 |

说明：

- 16.2 共 69 行，16.1 另有 11 行修改，其中“GET、POST、PUT、DELETE”合并行按资源计一行，展开后接口更多；本节不进入第十四节的统计（那一节记录的是 P0-03 冻结时的 402 行），阶段 6 实现后由 P6-30 汇总。
- 页面进入权限、沿用既有权限的写操作见 `permissions.md` 10.1、10.2；新增权限点共 13 个，未写入权限目录。
- 凡是批量接口都有数量上限，凡是汇总类接口都有时间范围与行数上限；超限返回 400 或 422，不静默截断（返回 `truncated` 的只读事件流除外）。
