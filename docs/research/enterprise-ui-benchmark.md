# NOVA ERP 企业级 UI 基准与落地清单

> 目的：把“高端 ERP / 企业官网 / Amazon 运营系统”的共性能力沉淀成可执行的页面、交互和验收标准。本文不是案例堆砌，而是本项目的设计约束。

## 1. 参考结论

### SAP Fiori：先按角色和任务组织，不按功能名堆菜单

SAP Fiori 的核心原则是 role-based、adaptive、simple、coherent、delightful。它把启动台、工作区、搜索、通知、个性化和任务入口组织成一个连续的企业 shell。

落到 NOVA：

- 左侧导航按“经营、供应链、广告与数据、企业治理”分组；
- 主页显示当前角色最重要的指标、待处理事项和连接异常，而不是只放图表；
- 任何列表都必须可以进入详情、筛选、导出、重试或发起下一步动作；
- 页面在小屏时收缩为可用的筛选栏、抽屉和横向表格，而不是简单缩小。

来源：[SAP Fiori Design Principles](https://www.sap.com/design-system/fiori-design-ios/discover/sap-design-system/vision-and-mission/sap-fiori-design-principles)

### Microsoft Fluent：把可访问性和可操作性作为企业体验的一部分

Fluent 2 的公开资源将焦点顺序、颜色对比、跨平台体验和性能作为设计系统资源的一部分。企业后台不能只看截图，需要让键盘、焦点、错误反馈和状态颜色都可理解。

落到 NOVA：

- 所有按钮、输入框、抽屉和弹层提供可见焦点；
- 成功、警告、失败不只依赖颜色，必须同时有文字状态；
- 数据表使用明确的表头、可读的行操作和空状态；
- 错误要告诉用户“哪条数据、哪个字段、下一步怎么处理”。

来源：[Fluent 2 Design System](https://fluent2.microsoft.design/)

### Salesforce Lightning：数据表是工作单元，不是静态展示

Lightning Data Table 支持行级/表级错误、单元格编辑、文本裁剪/换行、键盘导航、行选择和列调整。这是成熟后台与“看板”的重要分界线。

落到 NOVA：

- 订单、库存、同步任务、成员、审计都使用可操作数据表；
- 表格必须支持筛选、状态标签、详情抽屉和批量操作入口；
- 失败任务显示原因、重试入口和最近一次请求时间；
- 真实 API 接入后保留分页、排序、导出和权限校验的接口位置。

来源：[Salesforce Lightning Datatable](https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-datatable.html?type=Example)

### Oracle NetSuite Redwood：减少噪音，提高有效信息密度

NetSuite 将 dashboards、lists、forms、entities 等页面统一到 Redwood 体验，并强调滚动时收起页面头部，使列表一次显示更多有效行；它同时采用按角色的中心和可发布、可个性化的仪表板。

落到 NOVA：

- 页面头部保留标题、口径、更新时间和关键操作，不放大面积装饰；
- 指标、表格、详情和异常采用分层布局，优先保证阅读和决策；
- 角色不同看到不同的默认工作区，后续可扩展个人布局保存；
- 不使用深色渐变、霓虹发光、模拟 AI 的装饰性背景。

来源：[NetSuite User Experience](https://www.netsuite.com/portal/products/netsuite-experience.shtml)、[Publishing NetSuite Dashboards](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N633149.html)

### 领星：跨境 ERP 的信息架构必须覆盖业务链路

领星公开产品内容将供应链、利润分析、广告、库存预警、移动访问和报表放在同一个跨境经营链路中；其开放平台的业务模块还覆盖基础数据、销售管理、FBA 发货与库存、仓库、产品、财务和广告。

落到 NOVA：

- 不只做“概览、订单、库存”三个看板，要把采购、仓储、履约、广告、财务、报表、连接和治理串起来；
- 库存页面要能看到可售、在途、预留、周转天数和补货动作；
- 连接页面要区分 Seller、Ads、授权范围、健康检查、同步任务和异常；
- 报表页面要有异步任务生命周期：创建、排队、生成、可下载、过期、失败、重试。

来源：[LINGXING ERP](https://www.lingxing.com/en)、[LINGXING Cross-Border E-commerce ERP System](https://www.lingxing.com/en/contents/3156.html)、[领星开放平台](https://apidoc.lingxing.com/new)

## 2. NOVA 的正式信息架构

| 一级模块 | 落地页面 | 页面必须提供的闭环 |
| --- | --- | --- |
| 经营 | 经营概览、订单中心、退款与退货 | 指标口径 → 筛选 → 列表 → 详情 → 后续动作 |
| 供应链 | 产品与采购、库存工作台、仓储与履约 | SKU → 采购批次 → 入库/在途 → 补货风险 → 操作 |
| 广告与数据 | 广告经营、广告报表、经营报表 | Profile → 活动/报表 → 异步状态 → 下载/导出 |
| 财务 | 财务与结算、利润分析 | 销售 → 费用 → 退款 → 结算 → 币种/口径 |
| 连接与任务 | 数据连接、同步任务 | 授权范围 → 健康检查 → 队列 → 失败原因 → 重试 |
| 企业治理 | 法律主体、成员与角色、审计中心、企业设置 | 主体边界 → 权限 → 操作证据 → 策略配置 |

## 3. 视觉和交互基线

- 视觉：浅色画布、白色内容面板、蓝色主行动、灰色分隔线；强调信息层级，不使用深色 AI 风格。
- 密度：桌面端以 1200–1440px 工作区为基线，表格允许横向滚动，关键字段不被压缩隐藏。
- 反馈：按钮点击后必须有成功、失败、处理中或无权限反馈，不能只改变文字。
- 状态：所有连接、任务、审批、报表和同步操作均使用状态机表达，不伪造“已连接”或“已完成”。
- 权限：页面标题下方说明当前租户、主体、店铺和授权范围；敏感操作进入审计记录。
- 数据：演示数据必须带有“示例/演示”语义；生产环境由服务端数据和真实 API 状态驱动。

## 4. 本轮改造验收

- [x] 左侧导航补齐供应链、报表和治理入口。
- [x] 顶部提供全局搜索、通知、租户和当前角色上下文。
- [x] 占位的企业治理页面替换为真实工作区布局。
- [x] 补齐退款、采购、仓储、报表和角色矩阵等示例内容。
- [x] 详情抽屉、任务状态、错误提示、审计时间线可交互。
- [ ] 生产接入前仍需配置真实 Amazon LWA / SP-API / Ads 凭证、回调域名、数据库和 Redis；前端示例不等同于真实连接验收。
