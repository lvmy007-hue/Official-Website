import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './testing/harness'

// P1-10 回归基线：领域拆分前 api.controller.ts 暴露的全部接口（方法 + 路径）。
// 拆分后每一条都必须仍然存在，并且不能凭空多出未登记的接口。
const LEGACY_ROUTES = [
  'GET /api/v1/health',
  'GET /api/v1/commerce/plans',
  'GET /api/v1/commerce/payment-configuration',
  'POST /api/v1/commerce/orders',
  'GET /api/v1/commerce/orders/:orderNo',
  'POST /api/v1/commerce/orders/:orderNo/pay',
  'POST /api/v1/commerce/orders/:orderNo/refunds',
  'POST /api/v1/payments/alipay/notify',
  'GET /api/v1/commerce/admin/plans',
  'PATCH /api/v1/commerce/admin/plans/:id',
  'GET /api/v1/commerce/admin/orders',
  'POST /api/v1/commerce/admin/orders/:id/activate',
  'GET /api/v1/commerce/admin/refunds',
  'PATCH /api/v1/commerce/admin/refunds/:id',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'GET /api/v1/auth/me',
  'GET /api/v1/entities',
  'POST /api/v1/entities',
  'GET /api/v1/members',
  'GET /api/v1/audit',
  'GET /api/v1/orders',
  'GET /api/v1/orders/:id/items',
  'GET /api/v1/inventory',
  'GET /api/v1/procurement/suppliers',
  'GET /api/v1/procurement/purchase-orders',
  'POST /api/v1/procurement/purchase-orders',
  'GET /api/v1/warehouses',
  'GET /api/v1/inventory/movements',
  'GET /api/v1/connections',
  'GET /api/v1/sync/jobs',
  'POST /api/v1/sync/jobs/:id/retry',
  'POST /api/v1/sync/jobs',
  'POST /api/v1/sp-api/oauth/start',
  'GET /api/v1/sp-api/oauth/callback',
  'GET /api/v1/ads/profiles',
  'GET /api/v1/ads/campaigns',
  'GET /api/v1/ads/reports',
  'GET /api/v1/ads/metrics',
  'POST /api/v1/ads/reports',
  'POST /api/v1/ads/oauth/start',
  'POST /api/v1/ads/sync',
  'GET /api/v1/ads/oauth/callback',
  'POST /api/v1/contact-requests',
  'GET /api/v1/contact-requests',
  'PATCH /api/v1/contact-requests/:id',
]

// 拆分之后按工作包新增的接口：每新增一条在这里登记，并注明工作包。
const ADDED_ROUTES = [
  'POST /api/v1/auth/step-up', // P1-14：高风险操作再次验证身份
  'POST /api/v1/auth/logout', // P1-17：注销当前会话
  'GET /api/v1/auth/sessions', // P1-17：会话列表
  'DELETE /api/v1/auth/sessions/:id', // P1-17：注销指定会话
  'POST /api/v1/auth/mfa/enroll', // P1-17：获取多因素认证绑定信息
  'POST /api/v1/auth/mfa/verify', // P1-17：提交验证码完成绑定、领取恢复码
  'GET /api/v1/sync/parity', // P1-26：新旧接口并行核对报告
  'GET /api/v1/sync/dead-letters', // P1-20：失败任务（死信）列表
  'POST /api/v1/sync/dead-letters/:id/replay', // P1-20：重放失败任务
  'GET /api/v1/storage/local/:token', // P1-23：本地存储的签名下载链接
  'PUT /api/v1/storage/local/:token', // P1-23：本地存储的签名直传链接
  'GET /api/v1/scope/options', // P1-04：全局范围栏可选项
  'POST /api/v1/telemetry/web-vitals', // P1-09：前端性能埋点上报
  'GET /api/v1/auth/invitations/:token', // P1-19：邀请页预览（公开，一次性令牌）
  'POST /api/v1/auth/invitations/:token/accept', // P1-19：接受邀请并设置密码
  'GET /api/v1/onboarding', // P1-19：初始化向导进度
  'PATCH /api/v1/onboarding', // P1-19：保存或完成向导某一步
  'GET /api/v1/settings/quotas', // P1-19：配额占用（补）
  'GET /api/v1/settings/support-access', // P1-19：支持访问授权列表（补）
  'POST /api/v1/settings/support-access', // P1-19：所有者授权平台支持访问
  'DELETE /api/v1/settings/support-access/:id', // P1-19：撤销支持访问授权
  'POST /api/v1/platform/auth/login', // P1-19：平台账号登录第一步
  'POST /api/v1/platform/auth/mfa/verify', // P1-19：平台账号动态验证码（补）
  'GET /api/v1/platform/auth/me', // P1-19：平台账号自身信息（补）
  'POST /api/v1/platform/auth/logout', // P1-19：平台账号注销（补）
  'GET /api/v1/platform/tenants', // P1-19：企业列表
  'POST /api/v1/platform/tenants', // P1-19：开通企业
  'GET /api/v1/platform/tenants/:id', // P1-19：企业详情
  'GET /api/v1/platform/tenants/:id/usage', // P1-19：用量与配额占用
  'GET /api/v1/platform/tenants/:id/close-export', // P1-19：注销导出包下载链接（补）
  'POST /api/v1/platform/tenants/:id/invite', // P1-19：重发邀请
  'POST /api/v1/platform/tenants/:id/suspend', // P1-19：暂停
  'POST /api/v1/platform/tenants/:id/resume', // P1-19：恢复
  'POST /api/v1/platform/tenants/:id/deactivate', // P1-19：停用
  'POST /api/v1/platform/tenants/:id/close', // P1-19：注销
  'PUT /api/v1/platform/tenants/:id/quota', // P1-19：配额（补）
  'GET /api/v1/platform/support-access', // P1-19：可领取的支持访问授权（补）
  'POST /api/v1/platform/support-access', // P1-19：领取支持访问
  'GET /api/v1/settings/integrations', // P1-28：写入开关列表（含前置条件与最近变更）
  'GET /api/v1/settings/integrations/summary', // P1-28：写入状态汇总（顶栏标识）
  'PATCH /api/v1/settings/integrations', // P1-28：批量关闭开关
  'POST /api/v1/settings/integrations/readonly-all', // P1-28：一键全部只读
  'POST /api/v1/settings/integrations/:key/enable', // P1-28：开启开关（原因 + 确认 + 再次验证）
  'POST /api/v1/settings/integrations/:key/disable', // P1-28：关闭开关
  'GET /api/v1/notifications', // P1-28：站内通知列表
  'GET /api/v1/notifications/unread-count', // P1-28：未读数
  'POST /api/v1/notifications/read', // P1-28：标记已读
  'GET /api/v1/notifications/subscriptions', // P1-28：亚马逊消息订阅列表
  'POST /api/v1/notifications/subscriptions', // P1-28：创建订阅
  'PATCH /api/v1/notifications/subscriptions/:id', // P1-28：更新订阅
  'DELETE /api/v1/notifications/subscriptions/:id', // P1-28：删除订阅
  'POST /api/v1/notifications/subscriptions/:id/replay', // P1-28：重放失败的推送事件
  'GET /api/v1/settings/preferences', // P1-28：企业偏好设置
  'PUT /api/v1/settings/preferences/:key', // P1-28：保存企业偏好
  'GET /api/v1/settings/fx', // P1-28：汇率总览（最新、曲线、来源、手工覆盖）
  'POST /api/v1/settings/fx', // P1-28：手工覆盖汇率 / 调整来源
  'POST /api/v1/settings/fx/currencies', // P1-28：管理附加币种
  'POST /api/v1/settings/fx/refresh', // P1-28：立即获取汇率（交给后台任务）
  'DELETE /api/v1/settings/fx/overrides/:id', // P1-28：撤销手工覆盖
  'GET /api/v1/settings/finance-policy', // P2b-15：财务口径（当前、待审批、历史、使用情况）
  'PUT /api/v1/settings/finance-policy', // P2b-15：提交口径修改（待审批，再次验证）
  'POST /api/v1/settings/finance-policy/:version/approve', // P2b-15：审批或撤回口径修改（再次验证）
  'GET /api/v1/work-items', // P1-28：我的待办列表
  'GET /api/v1/work-items/:id', // P1-28：待办详情
  'POST /api/v1/work-items', // P1-28：创建待办
  'PATCH /api/v1/work-items', // P1-28：批量处理待办
  'POST /api/v1/work-items/:id/assign', // P1-28：转派
  'POST /api/v1/work-items/:id/ack', // P1-28：确认开始处理
  'POST /api/v1/work-items/:id/ignore', // P1-28：忽略
  'POST /api/v1/work-items/:id/close', // P1-28：关闭（带结论）
  'POST /api/v1/work-items/:id/defer', // P1-28：延期
  'GET /api/v1/views', // P1-28：保存的视图
  'POST /api/v1/views', // P1-28：保存视图
  'PATCH /api/v1/views/:id', // P1-28：修改视图
  'DELETE /api/v1/views/:id', // P1-28：删除视图
  'GET /api/v1/comments', // P1-28：对象评论与关注状态
  'POST /api/v1/comments', // P1-28：发表评论
  'POST /api/v1/watches', // P1-28：关注对象
  'DELETE /api/v1/watches/:id', // P1-28：取消关注
  'GET /api/v1/events', // P1-28：对象事件时间线
  'GET /api/v1/operation-logs', // P1-28：操作记录
  'POST /api/v1/operation-logs', // P1-28：新增操作记录
  'POST /api/v1/exports', // P1-28：发起导出
  'GET /api/v1/exports', // P1-28：我的导出列表
  'GET /api/v1/exports/:id', // P1-28：导出详情
  'GET /api/v1/exports/:id/download', // P1-28：换取导出文件的临时下载链接
  'GET /api/v1/freshness', // P1-28：数据新鲜度
  'GET /api/v1/metrics/definitions', // P1-28：指标口径
  'GET /api/v1/overview/source-health', // P1-30：数据源健康表（过渡期首页使用，P2a-02 继续沿用）
  'GET /api/v1/ads/overview', // P3-05：广告控制台
  'GET /api/v1/ads/today', // P3-06：今日广告
  'PATCH /api/v1/ads/campaigns/meta', // P3-07：批量设置标签与负责人（系统内）
  'GET /api/v1/ads/campaigns/:id', // P3-07：活动详情与 12 个页签
  'GET /api/v1/ads/campaigns/:id/trend',
  'GET /api/v1/ads/campaigns/:id/hourly',
  'GET /api/v1/ads/campaigns/:id/budget-timeline', // P6-24：超预算时间条与归因窗口（只读，小时数据 14 天窗口）
  'GET /api/v1/ads/conflicts', // P6-24：分时策略与自动规则的投放冲突（只读）
  'GET /api/v1/ads/duplicate-keywords', // P6-24：同词同匹配方式出现在多个广告组（只读）
  'GET /api/v1/ads/campaigns/:id/ad-groups',
  'GET /api/v1/ads/campaigns/:id/targets',
  'GET /api/v1/ads/campaigns/:id/search-terms',
  'GET /api/v1/ads/campaigns/:id/products',
  'GET /api/v1/ads/campaigns/:id/placements',
  'GET /api/v1/ads/campaigns/:id/creatives',
  'GET /api/v1/ads/campaigns/:id/audiences',
  'GET /api/v1/ads/campaigns/:id/history',
  'GET /api/v1/ads/campaigns/:id/forecast',
  'GET /api/v1/ads/campaigns/:id/recommendations',
  'GET /api/v1/ads/campaigns/:id/changes',
  'POST /api/v1/ads/recommendations/:id/dismiss', // P3-07：忽略官方推荐（系统内标记）
  'GET /api/v1/ads/ad-groups', // P6-23：广告组列表（只读，区间筛选、汇总、分类）
  'GET /api/v1/ads/:level/counts', // P6-23：五个层级共用的分类计数（level 白名单，其余 404）
  'GET /api/v1/ads/ad-groups/:id', // P3-08：广告组详情与 7 个页签（只读，写入随 P3-17）
  'GET /api/v1/ads/ad-groups/:id/trend',
  'GET /api/v1/ads/ad-groups/:id/targets',
  'GET /api/v1/ads/ad-groups/:id/search-terms',
  'GET /api/v1/ads/ad-groups/:id/products',
  'GET /api/v1/ads/ad-groups/:id/negatives',
  'GET /api/v1/ads/ad-groups/:id/hourly',
  'GET /api/v1/ads/ad-groups/:id/history',
  'GET /api/v1/ads/targets/:id', // P3-08：投放对象详情与 6 个页签（只读）
  'GET /api/v1/ads/targets/:id/trend',
  'GET /api/v1/ads/targets/:id/search-terms',
  'GET /api/v1/ads/targets/:id/placements',
  'GET /api/v1/ads/targets/:id/hourly',
  'GET /api/v1/ads/targets/:id/bid-history',
  'GET /api/v1/ads/targets/:id/brand-analytics',
  'GET /api/v1/ads/products', // P3-09：广告商品（按店铺 × ASIN 汇总，只读；批量暂停与复制写亚马逊，随 P3-17）
  'GET /api/v1/ads/portfolios', // P3-11：广告组合与预算（只读）；新建组合与改预算、预算规则（POST、PATCH）写亚马逊，随 P3-17
  'GET /api/v1/ads/portfolios/:id', // P3-11：组合详情（预算节奏、活动预算分配、预算规则测试版）
  'GET /api/v1/ads/dayparting', // P3-12：分时策略（热力图、策略列表、执行记录）
  'POST /api/v1/ads/dayparting', // P3-12：创建策略（只改系统内数据，不写亚马逊；调度执行随 P3-17）
  'PATCH /api/v1/ads/dayparting/:id', // P3-12：修改、启停、基准值
  'POST /api/v1/ads/dayparting/:id/simulate', // P3-12：策略效果模拟（只读，模型估算）
  'GET /api/v1/ads/rules', // P3-13：自动规则列表（含可选广告账户、自动模式开关状态）
  'POST /api/v1/ads/rules', // P3-13：创建规则（只改系统内数据；自动执行写亚马逊随 P3-17）
  'GET /api/v1/ads/rules/:id', // P3-13：规则详情（质量：命中率、采纳率、执行后效果）
  'PATCH /api/v1/ads/rules/:id', // P3-13：修改、启停、改模式
  'POST /api/v1/ads/rules/:id/dry-run', // P3-13：试运行（只读，不生成待办）
  'GET /api/v1/ads/rules/:id/runs', // P3-13：执行记录（游标翻页）
  'GET /api/v1/ads/changes', // P3-14：广告变更记录（四种来源；外部变更由实体快照对比识别）
  'GET /api/v1/ads/changes/:id/compare', // P3-14：一条变更的前后对照
  'GET /api/v1/ads/terms', // P3-10：词级中心（投放对象、搜索词、否定词库、四象限）；替代已下线的 GET /analytics/ad-terms
  'GET /api/v1/ads/terms/roots', // P3-10：词根分析
  'GET /api/v1/ads/terms/detail', // P3-10：词级分析页
  'GET /api/v1/ads/negatives', // P3-10：否定词库
  'POST /api/v1/ads/preview', // P3-17：统一的写前预览（只读本系统数据，不调用亚马逊）
  'GET /api/v1/ads/writes', // P3-17：每类写入当前能不能用（权限、开关）与最近的写入记录
  'PATCH /api/v1/ads/campaigns', // P3-17：活动状态、日预算、竞价策略、广告位调整（可批量）
  'PATCH /api/v1/ads/ad-groups/:id', // P3-17：广告组状态与默认竞价
  'PATCH /api/v1/ads/targets/:id', // P3-17：投放对象状态与竞价
  'POST /api/v1/ads/negatives', // P3-17：添加否定投放
  'POST /api/v1/ads/keywords', // P3-17：添加关键词
  'POST /api/v1/ads/keywords/bulk-add', // P6-24：词研究一键批量加词或否定（先去重，逐项进写入流水线）
  'GET /api/v1/ads/report-templates', // P3-15：报告模板库（含各广告档案是否可用、历史可用起点）
  'POST /api/v1/ads/reports/backfill', // P3-15：历史回补（按 120 天切片各建一个活动日报任务）；GET /ads/reports、POST /ads/reports、GET /ads/metrics 沿用旧路径、换成新契约
  'POST /api/v1/ads/reports/:id/retry', // P3-15：失败任务重试（建新任务，同一个失败任务只重试一次）
  'GET /api/v1/ads/parity', // P3-15：迁移期新旧接口核对总览
  'POST /api/v1/ads/parity/run', // P3-15：手动触发一次核对（只排任务）
  'GET /api/v1/ads/parity/:runId/diffs', // P3-15：一次核对的差异明细
  'GET /api/v1/overview/kpis', // P2a-02：经营控制台
  'GET /api/v1/overview/trend',
  'GET /api/v1/overview/attribution',
  'GET /api/v1/overview/store-compare',
  'GET /api/v1/overview/asin-rank',
  'GET /api/v1/overview/volatility',
  'GET /api/v1/overview/ad-anomalies',
  'GET /api/v1/overview/inventory-risk',
  'GET /api/v1/overview/growth-waterfall',
  'GET /api/v1/overview/cash',
  'GET /api/v1/today/summary', // P2a-03：今日实时
  'GET /api/v1/today/hourly',
  'GET /api/v1/today/events',
  'GET /api/v1/targets', // P2a-04：目标与预算
  'GET /api/v1/targets/history',
  'PUT /api/v1/targets',
  // P2a-06：库存健康与库存详情（GET /inventory 是原有路径，响应改为新的库存健康列表）
  'GET /api/v1/inventory/summary',
  'GET /api/v1/inventory/rules',
  'PUT /api/v1/inventory/rules',
  // P2a-09：库存台账、移除与弃置、仓储容量与费用（静态路径要排在 :id 之前）
  'GET /api/v1/inventory/ledger',
  'GET /api/v1/inventory/removals',
  'GET /api/v1/inventory/removals/recommended',
  'GET /api/v1/inventory/removals/:id',
  'POST /api/v1/inventory/removals/:id/receipt',
  'GET /api/v1/inventory/capacity',
  'POST /api/v1/inventory/capacity/limits-import',
  'GET /api/v1/inventory/:id',
  'GET /api/v1/inventory/:id/structure',
  'GET /api/v1/inventory/:id/snapshots',
  'GET /api/v1/inventory/:id/ledger',
  'GET /api/v1/inventory/:id/inbound',
  'GET /api/v1/inventory/:id/awd',
  'GET /api/v1/inventory/:id/replenishment',
  'GET /api/v1/inventory/:id/age-fees',
  'GET /api/v1/inventory/:id/disposition',
  'GET /api/v1/inventory/:id/forecast',
  // P2a-07：补货建议（GET /inventory/:id/replenishment 由补货模块提供）
  'GET /api/v1/replenishment/policies',
  'PUT /api/v1/replenishment/policies',
  'POST /api/v1/replenishment/recompute',
  'GET /api/v1/replenishment/recommendations',
  'GET /api/v1/replenishment/batches',
  'GET /api/v1/replenishment/batches/:id',
  'POST /api/v1/replenishment/batches/:id/decisions',
  'POST /api/v1/replenishment/batches/:id/evaluate',
  'POST /api/v1/replenishment/to-purchase-draft',
  // P6-08：补货批次一键转入仓计划草稿（取代只登记意向的 to-inbound-draft）与未补建的意向清单
  'POST /api/v1/replenishment/batches/:id/to-inbound-drafts',
  'GET /api/v1/replenishment/intents',
  // P6-09：人工预测规则（分时段取代模型预测）
  'GET /api/v1/replenishment/forecast-overrides',
  'POST /api/v1/replenishment/forecast-overrides',
  'PUT /api/v1/replenishment/forecast-overrides/:id',
  'DELETE /api/v1/replenishment/forecast-overrides/:id',
  // P6-08：发货地址（按店铺维护入仓用的发货方地址）
  'GET /api/v1/ship-from-addresses',
  'POST /api/v1/ship-from-addresses',
  'PUT /api/v1/ship-from-addresses/:id',
  'POST /api/v1/ship-from-addresses/:id/default',
  'DELETE /api/v1/ship-from-addresses/:id',
  'POST /api/v1/replenishment/to-awd-draft',
  'POST /api/v1/replenishment/simulate',
  'GET /api/v1/replenishment/simulations/:id',
  // P2a-08：亚马逊仓储分销（AWD）
  'GET /api/v1/awd/inventory',
  'GET /api/v1/awd/orders',
  'GET /api/v1/awd/orders/:id',
  'GET /api/v1/awd/shipments',
  'GET /api/v1/awd/shipments/:id/labels',
  'POST /api/v1/awd/shipments/:id/labels',
  'POST /api/v1/awd/orders',
  'PATCH /api/v1/awd/orders/:id',
  'POST /api/v1/awd/orders/:id/confirm',
  'POST /api/v1/awd/orders/:id/cancel',
  // P2a-12：入仓计划
  'GET /api/v1/inbound/plans',
  'POST /api/v1/inbound/plans',
  'GET /api/v1/inbound/plans/:id',
  'GET /api/v1/inbound/plans/:id/options',
  'GET /api/v1/inbound/plans/:id/boxes',
  'GET /api/v1/inbound/plans/:id/shipments',
  'GET /api/v1/inbound/plans/:id/operations',
  'GET /api/v1/inbound/plans/:id/labels',
  'POST /api/v1/inbound/plans/:id/eligibility',
  'POST /api/v1/inbound/plans/:id/submit',
  'POST /api/v1/inbound/plans/:id/packing-options',
  'PUT /api/v1/inbound/plans/:id/boxes',
  // P6-10：装箱表格文件模板与导入
  'POST /api/v1/inbound/plans/:id/boxes/import',
  'GET /api/v1/inbound/box-templates/:kind',
  // P6-11：供应商装箱单自动匹配 SKU、外部货号映射、装箱单列映射
  'POST /api/v1/inbound/plans/:id/packing-list/parse',
  'POST /api/v1/inbound/plans/:id/packing-list/apply',
  'GET /api/v1/sku-aliases',
  'GET /api/v1/sku-aliases/export',
  'POST /api/v1/sku-aliases/import',
  'POST /api/v1/sku-aliases',
  'PUT /api/v1/sku-aliases/:id',
  'DELETE /api/v1/sku-aliases/:id',
  'GET /api/v1/packing-list-mappings',
  'GET /api/v1/packing-list-mappings/:supplierId',
  'PUT /api/v1/packing-list-mappings/:supplierId',
  'DELETE /api/v1/packing-list-mappings/:supplierId',
  // P6-12：标签模板、自定义箱标签与商品标签（本地生成 PDF，走导出中心）
  'GET /api/v1/label-templates',
  'POST /api/v1/label-templates',
  'PUT /api/v1/label-templates/:id',
  'DELETE /api/v1/label-templates/:id',
  'POST /api/v1/inbound/shipments/:id/labels/custom',
  'POST /api/v1/inbound/plans/:id/item-labels',
  'POST /api/v1/inbound/plans/:id/packing-info',
  'POST /api/v1/inbound/plans/:id/placement-options',
  'POST /api/v1/inbound/plans/:id/transport-options',
  'POST /api/v1/inbound/plans/:id/delivery-windows',
  'POST /api/v1/inbound/plans/:id/labels/print-jobs',
  'PATCH /api/v1/inbound/plans/:id/costs',
  'POST /api/v1/inbound/plans/:id/confirm',
  'POST /api/v1/inbound/plans/:id/cancel',
  'GET /api/v1/inbound/shipments',
  'GET /api/v1/inbound/shipments/discrepancies',
  'GET /api/v1/inbound/shipments/:id',
  'GET /api/v1/inbound/shipments/:id/discrepancies',
  'GET /api/v1/inbound/shipments/:id/timeline',
  'PATCH /api/v1/inbound/shipments/:id/tracking',
  'GET /api/v1/inbound/shipments/:id/attachments',
  'POST /api/v1/inbound/shipments/:id/attachments',
  'POST /api/v1/inbound/shipments/:id/attachments/confirm',
  'GET /api/v1/inbound/shipments/:id/attachments/:attachmentId/download',
  'GET /api/v1/inbound/shipments/:id/audit',
  'GET /api/v1/inbound/receiving/stats',
  'POST /api/v1/inbound/receiving/stats/apply',
  // P2a-10：采购、供应商、国内仓
  'GET /api/v1/purchase-orders',
  'GET /api/v1/purchase-orders/:id',
  'POST /api/v1/purchase-orders',
  'PATCH /api/v1/purchase-orders/:id',
  'POST /api/v1/purchase-orders/:id/submit',
  'POST /api/v1/purchase-orders/:id/approve',
  'POST /api/v1/purchase-orders/:id/status',
  'POST /api/v1/purchase-orders/:id/receipts',
  'POST /api/v1/purchase-orders/:id/inspections',
  'POST /api/v1/purchase-orders/:id/payments',
  'POST /api/v1/purchase-orders/:id/attachments',
  'POST /api/v1/purchase-orders/:id/attachments/confirm',
  'GET /api/v1/purchase-orders/:id/attachments/:attachmentId/download',
  'GET /api/v1/suppliers',
  'GET /api/v1/suppliers/:id',
  'POST /api/v1/suppliers',
  'PATCH /api/v1/suppliers/:id',
  'DELETE /api/v1/suppliers/:id',
  'POST /api/v1/suppliers/:id/attachments',
  'POST /api/v1/suppliers/:id/attachments/confirm',
  'GET /api/v1/suppliers/:id/attachments/:attachmentId/download',
  'GET /api/v1/domestic-warehouse/stock',
  'GET /api/v1/domestic-warehouse/movements',
  'GET /api/v1/stock-counts',
  'POST /api/v1/stock-counts',
  'POST /api/v1/stock-counts/:id/approve',
  // P2a-11：头程物流
  'GET /api/v1/first-mile',
  // P6-26 物流渠道与报价、预估、批量补录
  // P6-27 审批收件箱
  'GET /api/v1/approvals',
  'POST /api/v1/approvals/:id/decision',
  'GET /api/v1/first-mile/carriers',
  'POST /api/v1/first-mile/carriers',
  'PUT /api/v1/first-mile/carriers/:id',
  'DELETE /api/v1/first-mile/carriers/:id',
  'POST /api/v1/first-mile/carriers/:id/channels',
  'PUT /api/v1/first-mile/carriers/:id/channels/:channelId',
  'DELETE /api/v1/first-mile/carriers/:id/channels/:channelId',
  'GET /api/v1/first-mile/carriers/:id/channels/:channelId/rates',
  'POST /api/v1/first-mile/carriers/:id/channels/:channelId/rates',
  'PUT /api/v1/first-mile/carriers/:id/channels/:channelId/rates/:rateId',
  'DELETE /api/v1/first-mile/carriers/:id/channels/:channelId/rates/:rateId',
  'POST /api/v1/first-mile/:id/estimate',
  'POST /api/v1/first-mile/:id/items/fill',
  'GET /api/v1/first-mile/transit-stats',
  'POST /api/v1/first-mile/transit-stats/apply',
  'POST /api/v1/first-mile',
  'GET /api/v1/first-mile/:id',
  'PATCH /api/v1/first-mile/:id',
  'POST /api/v1/first-mile/:id/outbound',
  'POST /api/v1/first-mile/:id/milestones',
  'POST /api/v1/first-mile/:id/milestones/import',
  'DELETE /api/v1/first-mile/:id/milestones/:milestoneId',
  'POST /api/v1/first-mile/:id/costs',
  'DELETE /api/v1/first-mile/:id/costs/:costId',
  'POST /api/v1/first-mile/:id/allocate',
  'DELETE /api/v1/first-mile/:id/allocation',
  'POST /api/v1/first-mile/:id/attachments',
  'POST /api/v1/first-mile/:id/attachments/confirm',
  'GET /api/v1/first-mile/:id/attachments/:attachmentId/download',
  'GET /api/v1/freight-forwarders',
  'POST /api/v1/freight-forwarders',
  'PATCH /api/v1/freight-forwarders/:id',
  // P4-07：商品主数据列表、批量设置负责人与标签（系统内）、按店铺同步商品目录
  'GET /api/v1/products',
  'PATCH /api/v1/products/meta',
  'POST /api/v1/products/sync',
  // P2a-14：ASIN 360
  'GET /api/v1/products/:id',
  'GET /api/v1/products/:id/overview',
  'GET /api/v1/products/:id/inventory',
  'GET /api/v1/products/:id/actions',
  'GET /api/v1/products/:id/changes',
  // P2b-17：ASIN 360 利润与成本、退货页签
  'GET /api/v1/products/:id/economics',
  'GET /api/v1/products/:id/economics/official',
  'GET /api/v1/products/:id/economics/preview',
  'GET /api/v1/products/:id/economics/costs',
  'GET /api/v1/products/:id/returns',
  // P3-19：ASIN 360 广告页签（只读）
  'GET /api/v1/products/:id/ads',
  // P4-08：ASIN 360 流量转化、刊登与问题、评价、定价与购物车、竞品、内容与 A+ 页签（只读）
  'GET /api/v1/products/:id/traffic',
  'GET /api/v1/products/:id/listing',
  'GET /api/v1/products/:id/reviews',
  'GET /api/v1/products/:id/content',
  'GET /api/v1/products/:id/pricing',
  'GET /api/v1/products/:id/competitors',
  'GET /api/v1/products/:id/compare',
  'GET /api/v1/products/:id/competitor-compare',
  'GET /api/v1/products/:id/alerts',
  // P4-09：刊登表现（只读）
  'GET /api/v1/listings/performance',
  // P4-10：刊登质量（七个页签、操作记录），校验预览、修改刊登、批量任务与刊登限制查询（写入类只受理，亚马逊调用在后台）
  'GET /api/v1/listings/quality',
  'GET /api/v1/listings/runs',
  'GET /api/v1/listings/runs/:id',
  'POST /api/v1/listings/validate',
  'POST /api/v1/listings/patch',
  'POST /api/v1/listings/batch',
  'POST /api/v1/listings/restrictions',
  // P4-11：定价与购物车（列表、详情、模拟、校验预览与改价、价格护栏、定价规则与执行记录）
  'GET /api/v1/pricing',
  'GET /api/v1/pricing/guardrails',
  'PUT /api/v1/pricing/guardrails',
  'GET /api/v1/pricing/rules',
  'POST /api/v1/pricing/rules',
  'PATCH /api/v1/pricing/rules/:id',
  'POST /api/v1/pricing/rules/:id/dry-run',
  'GET /api/v1/pricing/rules/:id/runs',
  'POST /api/v1/pricing/rule-runs/:id/dismiss',
  'GET /api/v1/pricing/:sku',
  'POST /api/v1/pricing/:sku/simulation',
  'POST /api/v1/pricing/:sku/validate',
  'PATCH /api/v1/pricing/:sku',
  // P4-12：竞品监控（列表、搜索词推荐、手工关注、详情、取消关注）
  'GET /api/v1/competitors',
  'GET /api/v1/competitors/candidates',
  'POST /api/v1/competitors',
  'GET /api/v1/competitors/:asin',
  'DELETE /api/v1/competitors/:asin',
  // P6-17：跟卖监控与白名单
  'GET /api/v1/finance/profit-items',
  'GET /api/v1/finance/profit-items/unmapped',
  'PUT /api/v1/finance/profit-items',
  // P6-19：费用分摊规则
  'GET /api/v1/finance/allocation-rules',
  'POST /api/v1/finance/allocation-rules/preview',
  'POST /api/v1/finance/allocation-rules',
  'PUT /api/v1/finance/allocation-rules',
  'GET /api/v1/finance/estimated-fees',
  'POST /api/v1/finance/estimated-fees/import',
  'POST /api/v1/finance/estimated-fees',
  'PUT /api/v1/finance/estimated-fees',
  'DELETE /api/v1/finance/estimated-fees',
  'GET /api/v1/finance/profit-formula',
  'PUT /api/v1/finance/profit-formula',
  'GET /api/v1/settings/business-rules',
  'PUT /api/v1/settings/business-rules/:key',
  'GET /api/v1/metric-versions',
  'POST /api/v1/metric-versions/:id/decision',
  'POST /api/v1/metric-versions/:id/diff-report',
  'GET /api/v1/finance/cashflow/funnel',
  'GET /api/v1/tools/hijack',
  'GET /api/v1/tools/hijack/whitelist',
  'POST /api/v1/tools/hijack/whitelist',
  'DELETE /api/v1/tools/hijack/whitelist/:id',
  'POST /api/v1/tools/pricing-calculator/estimate',
  'GET /api/v1/tools/pricing-calculator/records',
  'POST /api/v1/tools/pricing-calculator/records',
  'GET /api/v1/analytics/brand/share-trend',
  // P4-13：评价与反馈（四个页签、可请求订单、评分文件导入、批量请求评价）
  'GET /api/v1/reviews',
  'GET /api/v1/reviews/solicitations/eligible',
  'POST /api/v1/reviews/ratings-import',
  'POST /api/v1/reviews/solicitations',
  // P4-14：A+ 内容（列表、图片库、签名直传票据与确认、创建、详情、保存、关联 ASIN、提交审核）；uploads 两条冻结路由表里没有
  'GET /api/v1/aplus',
  'GET /api/v1/aplus/uploads',
  'POST /api/v1/aplus/uploads',
  'POST /api/v1/aplus/uploads/confirm',
  'POST /api/v1/aplus',
  'GET /api/v1/aplus/:id',
  'PATCH /api/v1/aplus/:id',
  'POST /api/v1/aplus/:id/asins',
  'POST /api/v1/aplus/:id/submit',
  // P5-02：账户健康（总览、政策合规问题列表与详情、处理问题）
  'GET /api/v1/account-health',
  'GET /api/v1/account-health/issues',
  'GET /api/v1/account-health/issues/:id',
  'PATCH /api/v1/account-health/issues/:id',
  // P2b-01：订单页（列表已有；详情各页签）。买家信息明文不再有订单专属路由，统一走 P6-14 的 POST /pii/reveal
  'GET /api/v1/orders/:id',
  'GET /api/v1/orders/:id/charges',
  'GET /api/v1/orders/:id/packages',
  'GET /api/v1/orders/:id/returns',
  'GET /api/v1/orders/:id/transactions',
  'GET /api/v1/orders/:id/timeline',
  'GET /api/v1/orders/:id/risks',
  // P6-14：个人信息统一出口（全站唯一返回个人信息明文的接口）
  'POST /api/v1/pii/reveal',
  // P2b-02：退货页（列表、分析、退款后未收到退货的待核实清单、详情）
  'GET /api/v1/returns',
  'GET /api/v1/returns/analysis',
  'GET /api/v1/returns/analysis/cohort',
  'GET /api/v1/returns/analysis/cross-month',
  'GET /api/v1/returns/analysis/cycle',
  'GET /api/v1/returns/analysis/disposition-matrix',
  'GET /api/v1/returns/analysis/summary',
  'GET /api/v1/returns/awaiting',
  'GET /api/v1/returns/reason-map',
  'PUT /api/v1/returns/reason-map',
  'GET /api/v1/returns/:id',
  // P2b-03：赔付中心（案件列表、机会、统计、生成案件、忽略与恢复机会、案件详情、更新、证据包、证据附件）
  'GET /api/v1/reimbursements',
  'GET /api/v1/reimbursements/opportunities',
  'GET /api/v1/reimbursements/stats',
  'POST /api/v1/reimbursements',
  'POST /api/v1/reimbursements/opportunities/:id/ignore',
  'POST /api/v1/reimbursements/opportunities/:id/restore',
  'GET /api/v1/reimbursements/:id',
  'PATCH /api/v1/reimbursements/:id',
  'POST /api/v1/reimbursements/:id/evidence-pack',
  'POST /api/v1/reimbursements/:id/attachments',
  'POST /api/v1/reimbursements/:id/attachments/confirm',
  'GET /api/v1/reimbursements/:id/attachments/:attachmentId/download',
  // P2b-04：支持案件（只读列表与详情）
  'GET /api/v1/support-cases',
  'GET /api/v1/support-cases/:id',
  'GET /api/v1/promotions',
  'GET /api/v1/promotions/stacking',
  'GET /api/v1/promotions/:id',
  // P4-06：订阅省（概览、ASIN 明细、报价参与列表，全部只读）
  'GET /api/v1/subscribe-save',
  'GET /api/v1/subscribe-save/asins',
  'GET /api/v1/subscribe-save/offers',
  // P2b-05：费用事件（列表、页签统计、证据与变更历史、标记差异与对账备注）
  'GET /api/v1/finance/events',
  'GET /api/v1/finance/events/summary',
  'GET /api/v1/finance/events/:id',
  'PATCH /api/v1/finance/events/:id/reconciliation',
  'GET /api/v1/finance/fee-audit',
  'POST /api/v1/finance/fee-audit/:id/reimbursement',
  // P2b-07：结算交易（全部只读）
  'GET /api/v1/settlements',
  'GET /api/v1/settlements/:id/summary',
  'GET /api/v1/settlements/:id/transactions',
  'GET /api/v1/settlements/:id/reconciliation',
  'GET /api/v1/settlements/:id/exceptions',
  'GET /api/v1/settlements/:id/disbursements',
  // P2b-08：回款与现金流
  'GET /api/v1/finance/cashflow',
  'POST /api/v1/finance/disbursements/confirm',
  // P2b-12：销售税（只读）
  'GET /api/v1/finance/sales-tax',
  // P2b-13：期间关账（创建、检查、审批、锁定、重新开账）
  'GET /api/v1/finance/periods',
  'POST /api/v1/finance/periods',
  'GET /api/v1/finance/periods/:id',
  'POST /api/v1/finance/periods/:id/check',
  'POST /api/v1/finance/periods/:id/approve',
  'POST /api/v1/finance/periods/:id/close',
  'POST /api/v1/finance/periods/:id/reopen',
  // P2b-14：商品成本（列表、详情、版本对比、录入、导入、确认生效、改与丢弃草稿）
  'GET /api/v1/costs',
  'POST /api/v1/costs',
  'POST /api/v1/costs/import',
  'POST /api/v1/costs/activate',
  'PATCH /api/v1/costs/versions/:id',
  'DELETE /api/v1/costs/versions/:id',
  'GET /api/v1/costs/:sku/compare',
  'GET /api/v1/costs/:sku',
  // P2b-10：利润分析（全部只读）；替代已下线的 GET /analytics/profit
  'GET /api/v1/profit/overview',
  'GET /api/v1/profit/stores',
  'GET /api/v1/profit/asins',
  'GET /api/v1/profit/ads',
  'GET /api/v1/profit/cost-coverage',
  'GET /api/v1/profit/bridge',
  // P2b-11：官方经济数据对账（核对与预览只读；模拟向数据中心提交查询，轮询用 simulations/:id）
  'GET /api/v1/finance/economics/compare',
  'GET /api/v1/finance/economics/preview',
  'POST /api/v1/finance/economics/simulate',
  'GET /api/v1/finance/economics/simulations/:id',
  // P3-03：广告账户与店铺绑定（清单只读；人工绑定与解除绑定同一条写路由，写审计）
  'GET /api/v1/connections/ads-accounts',
  'POST /api/v1/connections/ads-accounts/:id/bind',
  // P5-04：连接中心动作（健康检查排后台任务；重新授权沿用原连接；断开要再次验证身份与原因；都写审计）
  'POST /api/v1/connections/:id/health-check',
  'POST /api/v1/connections/:id/reauthorize',
  'POST /api/v1/connections/:id/disconnect',
  // P4-02：业务报告（销售与流量，全部只读）
  'GET /api/v1/analytics/sales-traffic/summary',
  'GET /api/v1/analytics/sales-traffic/by-date',
  'GET /api/v1/analytics/sales-traffic/by-asin',
  'GET /api/v1/analytics/sales-traffic/trends',
  // P4-03：ASIN 与父体分析（全部只读）
  'GET /api/v1/analytics/asins',
  'GET /api/v1/analytics/parents/:parentAsin',
  'GET /api/v1/analytics/parents/:parentAsin/matrix',
  'GET /api/v1/analytics/parents/:parentAsin/trend',
  'GET /api/v1/analytics/parents/:parentAsin/traffic',
  'GET /api/v1/analytics/parents/:parentAsin/inventory',
  'GET /api/v1/analytics/parents/:parentAsin/ads',
  'GET /api/v1/analytics/parents/:parentAsin/reviews',
  'GET /api/v1/analytics/parents/:parentAsin/changes',
  // P6-22：商品表现宽表（只读计算，用 POST 承载请求体）
  'POST /api/v1/analytics/product-performance/query',
  'POST /api/v1/analytics/product-performance/summary',
  'POST /api/v1/analytics/product-performance/trend',
  'POST /api/v1/analytics/product-performance/async-columns',
  'POST /api/v1/orders/net-income', // P6-30：订单列表净收益异步列（只读批量查询）
  // P6-25：销量统计、跨仓总览、进销存报表（全部只读）
  'GET /api/v1/analytics/sales-stat',
  'GET /api/v1/inventory/all-warehouses',
  'GET /api/v1/inventory/movement',
  // P4-04：品牌分析五页（全部只读，权限 analytics.brand.read）
  'GET /api/v1/analytics/brand/search-query',
  'GET /api/v1/analytics/brand/catalog',
  'GET /api/v1/analytics/brand/search-terms',
  'GET /api/v1/analytics/brand/market-basket',
  'GET /api/v1/analytics/brand/repeat-purchase',
  // P5-01：风险预警中心（列表、详情、确认/忽略/分派/关闭；规则列表、新建、改阈值与范围）
  'GET /api/v1/alerts',
  // P6-15：规则模板、按人批量已读、批量标为已处理（都在 :id 之前注册，避免被当成预警编号）
  'GET /api/v1/alerts/templates',
  'POST /api/v1/alerts/read',
  'POST /api/v1/alerts/handled',
  'GET /api/v1/alerts/rules',
  'POST /api/v1/alerts/rules',
  'POST /api/v1/alerts/rules/preview',
  'PATCH /api/v1/alerts/rules/:id',
  'GET /api/v1/alerts/:id',
  'POST /api/v1/alerts/:id/ack',
  'POST /api/v1/alerts/:id/ignore',
  'POST /api/v1/alerts/:id/assign',
  'POST /api/v1/alerts/:id/close',
  // P5-03：报表中心（旧的 /reports/jobs 随本包下线，由 /reports 替代；列表合并亚马逊报告、广告报告、数据中心查询，创建、取消、重试、下载只对亚马逊报告开放）
  'GET /api/v1/reports',
  'POST /api/v1/reports',
  'GET /api/v1/reports/:id',
  'POST /api/v1/reports/:id/cancel',
  'POST /api/v1/reports/:id/retry',
  'GET /api/v1/reports/:id/download',
  // P5-06：同步中心（GET /sync/jobs 沿用旧路径，响应改为带筛选与游标的列表；新增任务详情、队列监控、限速状态三个只读接口）
  'GET /api/v1/sync/jobs/:id',
  'GET /api/v1/sync/queues',
  'GET /api/v1/sync/rate-limits',
  // P5-07：法律主体（GET、POST /entities 沿用旧路径，响应改为带分页与统计；新增详情与修改）
  'GET /api/v1/entities/:id',
  'PATCH /api/v1/entities/:id',
  // P5-08：成员与角色（GET /members 沿用旧路径，响应改为带分页、范围、最近登录；/members/options 是选人用的轻量列表，旧响应形态迁到这里）
  'GET /api/v1/members/options',
  'GET /api/v1/members/:id',
  'POST /api/v1/members/invite',
  'POST /api/v1/members/:id/disable',
  'POST /api/v1/members/:id/enable',
  'POST /api/v1/members/:id/role',
  'POST /api/v1/members/:id/scopes',
  'GET /api/v1/roles',
  'POST /api/v1/roles',
  'PATCH /api/v1/roles/:id',
  // 审计中心（P5-09）
  'GET /api/v1/audit/options',
  'GET /api/v1/audit/pii-views',
  'GET /api/v1/audit/:id',
  // 企业设置（P5-10）：基本信息、数据保留、刷新策略、风险规则摘要、内部访问模式
  'GET /api/v1/settings',
  'PATCH /api/v1/settings',
  // 个人账号（P5-11）：个人资料（显示名）、通知偏好与个人免打扰
  'PATCH /api/v1/auth/me',
  'GET /api/v1/me/preferences',
  'PUT /api/v1/me/preferences',
  // 表格视图（P6-03）：服务端保存列显示、顺序、列宽、固定、排序、筛选；个人 / 团队 / 系统三级，默认视图三级回落
  'GET /api/v1/grid-views',
  'POST /api/v1/grid-views',
  'PUT /api/v1/grid-views/:id',
  'DELETE /api/v1/grid-views/:id',
  'POST /api/v1/grid-views/:id/default',
  // 自定义报表（P6-32）
  'GET /api/v1/report-sources',
  'POST /api/v1/report-sources/:code/query',
  'GET /api/v1/custom-metrics',
  'POST /api/v1/custom-metrics/validate',
  'POST /api/v1/custom-metrics',
  'PUT /api/v1/custom-metrics/:id',
  'DELETE /api/v1/custom-metrics/:id',
  'GET /api/v1/custom-reports',
  'POST /api/v1/custom-reports',
  'PUT /api/v1/custom-reports/:id',
  'DELETE /api/v1/custom-reports/:id',
  'POST /api/v1/custom-reports/:id/run',
  // 自定义仪表盘（P6-33）
  'GET /api/v1/dashboards/tree',
  'POST /api/v1/dashboards/folders',
  'PUT /api/v1/dashboards/folders/:folderId',
  'DELETE /api/v1/dashboards/folders/:folderId',
  'GET /api/v1/dashboards',
  'POST /api/v1/dashboards',
  'GET /api/v1/dashboards/:id',
  'PUT /api/v1/dashboards/:id',
  'DELETE /api/v1/dashboards/:id',
  'GET /api/v1/dashboards/:id/widgets',
  'POST /api/v1/dashboards/:id/widgets',
  'GET /api/v1/dashboards/:id/widgets/:widgetId',
  'PUT /api/v1/dashboards/:id/widgets/:widgetId',
  'DELETE /api/v1/dashboards/:id/widgets/:widgetId',
]

function collectRoutes(app: { getHttpAdapter(): { getInstance(): any } }): string[] {
  const stack: any[] = app.getHttpAdapter().getInstance()._router.stack
  const routes: string[] = []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${layer.route.path}`)
  }
  return routes
}

describe('接口路径兼容（P1-10 领域拆分回归）', () => {
  let harness: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    harness = await createTestApp({})
  })
  afterAll(async () => {
    await harness.close()
  })

  it('拆分前的每个接口都仍然存在', () => {
    const actual = new Set(collectRoutes(harness.app))
    const missing = LEGACY_ROUTES.filter(route => !actual.has(route))
    expect(missing).toEqual([])
  })

  it('没有出现未登记的新接口', () => {
    const expected = new Set([...LEGACY_ROUTES, ...ADDED_ROUTES])
    const extra = collectRoutes(harness.app).filter(route => !expected.has(route))
    expect(extra).toEqual([])
  })

  it('旧基线还剩 46 条（P2b-10、P3-10、P5-03 各下线一批；P5-12 再去掉 9 条 /fba 过渡接口）', () => {
    expect(LEGACY_ROUTES).toHaveLength(46)
    expect(new Set(LEGACY_ROUTES).size).toBe(46)
  })

  it('P5-12 删除的过渡期接口不再注册，直接 404', async () => {
    for (const path of ['/fba/summary', '/fba/products', '/fba/inventory', '/fba/inbound-plans', '/fba/fees', '/fba/settlements', '/fba/returns']) {
      expect((await harness.call('GET', path)).status).toBe(404)
    }
    expect((await harness.call('POST', '/fba/inbound-plans', { body: {} })).status).toBe(404)
    expect((await harness.call('POST', '/fba/sync/jobs', { body: {} })).status).toBe(404)
  })
})
