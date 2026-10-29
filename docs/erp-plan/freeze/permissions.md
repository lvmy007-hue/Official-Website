# P0-05 权限点清单、字段级权限、预设角色与旧权限映射

> 依据：11 章 11.1、09 章 9.10、12 章 12.8。
> 本文件是 P0-03（接口）、P0-01（路由）的权限引用源头：接口与路由里出现的每个权限点，都必须在本文件有定义。

## 一、规则

1. **格式**：统一为"模块.动作"，全小写，点号分隔。读取用 `.read`，写入用 `.write` 或具体动作名，审批用 `.approve`。
2. **权限点只表示"能不能做"**，不表示"能看到哪些店铺"。数据范围由成员的授权范围（全部主体、指定主体、指定店铺）决定，后端每次查询都与请求参数取交集，交集为空则拒绝。
3. **字段级敏感权限**（成本、利润、买家信息）独立于模块权限：没有授权时，字段在页面、导出、接口响应中一律不出现（不是显示为空，是字段不返回）。
4. **站点白名单**：只允许美国站（`ATVPDKIKX0DER`），配置在后端；任何权限都不能越过。
5. **基础权限**：所有登录成员自动具备，不在角色矩阵中配置，仅作用于本人数据：`my.workitems`（我的待办）、`my.exports`（我的导出）、`my.notifications`（消息中心）、`profile.manage`（个人账号）、`view.manage`（个人保存视图）、`metrics.read`（指标口径）。
6. **写入开关与权限是两道独立检查**：亚马逊写接口既要有对应权限，也要对应的写入开关处于开启状态（见第六节）。
7. **再次验证身份**（`StepUpVerification`）的操作见第七节，与权限无关，权限通过后仍需验证。
8. **平台运营后台**使用独立鉴权与独立权限体系（`platform.*`，见第八节），与租户角色互不相通，租户的所有者也不具备。

## 二、权限点全量清单

列说明：类型含义——查看、写入、审批、管理、导出。角色列：✓ 表示预设角色默认拥有，– 表示没有。所有者拥有全部权限点。

### 2.1 首页与协作

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `overview.read` | 经营控制台、今日实时 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workitem.read` | 查看全部待办（含他人的）；本人待办为基础权限 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workitem.assign` | 指派、转派待办 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `workitem.handle` | 确认、忽略（需原因）、延期、关闭待办 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `targets.read` | 查看目标与预算 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `targets.write` | 编辑目标 | 写入 | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `collab.write` | 评论、@成员、关注对象 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `grid.view.share` | 共享表格视图给团队，并设置团队默认视图（个人视图为基础权限） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `export.create` | 发起导出任务（旧权限保留） | 导出 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |

### 2.2 运营分析

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `analytics.read` | 业务报告、ASIN 与父体分析、促销与优惠券、订阅省 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `analytics.brand.read` | 品牌分析五页（要求店铺具备品牌分析资格） | 查看 | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |

### 2.3 商品

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `products.read` | 商品主数据、ASIN 360 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `catalog.meta.write` | 设置负责人、标签、关注（系统内数据，不写亚马逊） | 写入 | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| `listing.read` | 刊登表现、刊登质量与合规 | 查看 | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `listing.write` | 修复刊登、批量刊登任务（受写入开关） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `pricing.read` | 定价与购物车 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `pricing.price.write` | 修改价格（受写入开关） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `pricing.rule.write` | 价格护栏、定价规则（手动与自动模式） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `competitors.read` | 竞品监控 | 查看 | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `competitors.write` | 添加、移除关注竞品 | 写入 | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `tools.read` | 跟卖监控、新品定价试算（试算记录只看自己的；P6-17 并入，P6-29 沿用） | 查看 | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `tools.manage` | 管理跟卖白名单 | 管理 | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `reviews.read` | 评价与反馈 | 查看 | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| `reviews.solicit` | 请求评价（受写入开关） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `aplus.read` | 查看 A+ 内容 | 查看 | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `aplus.write` | 创建、编辑、提交 A+ 内容（受写入开关） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |
| `costs.read` | 商品成本页（同时需要字段权限 `field.cost`） | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | – |
| `costs.write` | 录入、导入成本版本 | 写入 | ✓ | ✓ | – | – | ✓ | ✓ | – |

### 2.4 库存

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inventory.read` | 库存健康、库存详情、库存台账、移除与弃置、仓储容量与费用 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `inventory.removal.receive` | 登记移除退回件的收货核对 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `replenishment.read` | 补货建议与批次 | 查看 | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| `replenishment.plan.create` | 生成采购单、入仓计划、上游仓储入库订单的草稿，触发重算与模拟 | 写入 | ✓ | ✓ | ✓ | – | – | ✓ | – |
| `replenishment.policy.write` | 编辑补货策略（企业、品类、SKU 三级） | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `awd.read` | 查看亚马逊仓储分销 | 查看 | ✓ | ✓ | ✓ | – | – | ✓ | ✓ |
| `awd.order.write` | 创建、更新、取消、确认入库订单，更新运输信息（受写入开关） | 写入 | ✓ | ✓ | – | – | – | ✓ | – |

### 2.5 供应链

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `purchase.read` | 采购订单 | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |
| `purchase.order.write` | 创建、编辑采购单，提交审批，上传附件 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `purchase.order.approve` | 审批采购单（与创建分离，创建人不能审批自己的单） | 审批 | ✓ | ✓ | – | – | ✓ | – | – |
| `purchase.receive` | 登记收货、质检 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `purchase.pay` | 登记付款 | 写入 | ✓ | ✓ | – | – | ✓ | – | – |
| `supplier.read` | 查看供应商 | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |
| `supplier.write` | 新增、编辑供应商 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `warehouse.read` | 国内仓库存与流水 | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |
| `warehouse.stockcount.write` | 创建盘点单、录入盘点结果 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `warehouse.stockcount.approve` | 审批盘点差异（审批后才调整库存） | 审批 | ✓ | ✓ | – | – | ✓ | – | – |
| `firstmile.read` | 头程物流 | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |
| `firstmile.write` | 录入运单、节点、费用，执行费用分摊 | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `inbound.read` | 入仓计划、货件接收与差异 | 查看 | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| `inbound.plan.write` | 创建计划、确认装箱、提交箱内物品、确认分仓、确认运输、取消（受写入开关） | 写入 | ✓ | ✓ | – | – | – | ✓ | – |
| `shipfrom.manage` | 新增、修改、停用、删除发货地址，设置店铺默认地址 | 管理 | ✓ | ✓ | – | – | – | ✓ | – |
| `skualias.manage` | 维护外部货号映射与装箱单列映射 | 管理 | ✓ | ✓ | – | – | – | ✓ | – |
| `labeltemplate.manage` | 新增、修改、删除标签模板与箱号规则 | 管理 | ✓ | ✓ | – | – | – | ✓ | – |

### 2.6 订单与售后

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orders.read` | 订单列表与详情（旧权限保留；买家信息另需 `field.buyer`） | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `returns.read` | 退货 | 查看 | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| `reimbursements.read` | 赔付中心 | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |
| `reimbursements.write` | 生成案件、导出证据包、回填案件编号、更新状态 | 写入 | ✓ | ✓ | – | – | ✓ | ✓ | – |
| `support.read` | 支持案件（只读同步） | 查看 | ✓ | ✓ | – | – | ✓ | ✓ | ✓ |

### 2.7 财务

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `finance.read` | 费用事件、费用核查、结算交易、回款与现金流、官方经济数据对账（旧权限保留） | 查看 | ✓ | ✓ | – | – | ✓ | – | ✓ |
| `finance.reconcile` | 标记差异、填写对账备注 | 写入 | ✓ | ✓ | – | – | ✓ | – | – |
| `finance.tax.read` | 销售税页（需亚马逊受限角色已授权） | 查看 | ✓ | ✓ | – | – | ✓ | – | – |
| `profit.read` | 利润分析页（同时需要 `field.profit`） | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| `finance.policy.write` | 修改财务口径（收入确认、存货计价、广告分摊、费用分摊）；修改须经审批 | 管理 | ✓ | ✓ | – | – | ✓ | – | – |
| `finance.profititem.manage` | 维护利润项目字典与交易类型映射（整树保存，带版本；P6-18 并入） | 管理 | ✓ | ✓ | – | – | ✓ | – | – |
| `finance.estimatedfee.write` | 录入、修改、导入预估与自定义费用（参与利润并标“估算”；P6-20 并入） | 写入 | ✓ | ✓ | – | – | ✓ | – | – |
| `finance.period.close` | 发起、审批并执行期间关账 | 审批 | ✓ | ✓ | – | – | ✓ | – | – |
| `finance.period.reopen` | 重新开账（需原因，再次验证身份） | 审批 | ✓ | ✓ | – | – | – | – | – |
| `settings.fx.write` | 手工覆盖汇率、选择汇率主源 | 管理 | ✓ | ✓ | – | – | ✓ | – | – |

### 2.8 广告

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ads.read` | 广告全部查看页面（旧权限保留） | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `ads.report` | 创建广告报告任务、使用广告指标自由分析（旧权限保留） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.campaign.write` | 暂停、启用、改名称与日期（受写入开关"活动状态"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.budget.write` | 修改预算（受写入开关"预算"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.bid.write` | 修改竞价与竞价策略（受写入开关"竞价"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.negative.write` | 添加否定投放（受写入开关"否定投放"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.keyword.write` | 添加关键词（受写入开关"添加关键词"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.placement.write` | 调整广告位（受写入开关"广告位调整"） | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.portfolio.write` | 广告组合预算上限与预算规则 | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.rule.write` | 自动规则、分时策略的创建与编辑；自动执行受写入开关 | 写入 | ✓ | ✓ | – | ✓ | – | – | – |
| `ads.account.bind` | 广告账户与店铺人工绑定 | 管理 | ✓ | ✓ | – | – | – | – | – |

### 2.9 风险、数据与报表

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `alerts.read` | 风险预警中心 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts.handle` | 确认、忽略（需原因）、分派、关闭（需结论） | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `alerts.manage` | 配置预警规则、阈值、通知对象、静默时段 | 管理 | ✓ | ✓ | – | – | – | – | – |
| `account.health.read` | 账户健康 | 查看 | ✓ | ✓ | ✓ | – | – | – | ✓ |
| `reports.read` | 报表中心任务查看、下载原始文件（链接签名短时有效） | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports.create` | 创建、取消、重试报告任务 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `reports.custom.write` | 创建、修改自定义指标与我的报表，发起定时生成 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `reports.custom.share` | 把自定义报表共享给团队（共享后按查看人的数据范围与字段权限取数） | 写入 | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `data.import` | 文件导入：评分与评分数、仓储限额等没有官方来源的数据；导入后逐项标注来源、采集日期、导入人 | 写入 | ✓ | ✓ | ✓ | – | ✓ | ✓ | – |
| `dashboard.write` | 创建、修改自定义仪表盘与组件 | 写入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `dashboard.share` | 把仪表盘共享给团队（没有数据权限的组件显示“无权查看”） | 写入 | ✓ | ✓ | ✓ | – | – | – | – |

### 2.10 连接与治理

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `connection.read` | 连接中心、消息推送订阅查看 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `connection.manage` | 授权、重新授权、健康检查、断开（旧权限保留） | 管理 | ✓ | ✓ | – | – | – | – | – |
| `notifications.manage` | 订阅、取消订阅、改过滤条件、重放失败事件 | 管理 | ✓ | ✓ | – | – | – | – | – |
| `sync.read` | 同步中心查看 | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sync.manage` | 重试同步、发起同步（旧权限保留） | 管理 | ✓ | ✓ | ✓ | ✓ | – | ✓ | – |
| `entity.read` | 法律主体查看（旧权限保留） | 查看 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `entity.write` | 新增、修改法律主体（旧权限保留） | 管理 | ✓ | ✓ | – | – | – | – | – |
| `member.read` | 成员列表与详情（旧权限保留） | 查看 | ✓ | ✓ | – | – | – | – | – |
| `member.invite` | 邀请成员（旧权限保留） | 管理 | ✓ | ✓ | – | – | – | – | – |
| `member.manage` | 停用成员、修改角色、授权数据范围 | 管理 | ✓ | ✓ | – | – | – | – | – |
| `role.manage` | 创建、编辑角色（旧权限保留） | 管理 | ✓ | ✓ | – | – | – | – | – |
| `audit.read` | 审计中心（旧权限保留） | 查看 | ✓ | ✓ | – | – | – | – | – |
| `settings.read` | 企业设置查看 | 查看 | ✓ | ✓ | – | – | ✓ | – | – |
| `settings.write` | 修改基本信息、数据保留、刷新策略 | 管理 | ✓ | ✓ | – | – | – | – | – |
| `settings.integration.write` | 接口与写入开关的开启、关闭、一键全部只读 | 管理 | ✓ | ✓ | – | – | – | – | – |
| `settings.business.write` | 修改业务口径（净销售额公式、可用库存组成、周起始日、多站点“今日”的取法；P6-31 并入） | 管理 | ✓ | ✓ | – | – | – | – | – |

### 2.11 旧权限（保留的 16 个，已含在上表）

`entity.read`、`entity.write`、`seller.read`、`seller.write`、`connection.manage`、`orders.read`、`refunds.read`、`finance.read`、`ads.read`、`ads.report`、`sync.manage`、`export.create`、`member.read`、`member.invite`、`role.manage`、`audit.read`。
其中 `seller.read`、`seller.write`、`refunds.read` 三个在新体系中拆分，不再作为独立点使用，见第五节映射。

## 三、字段级敏感权限

| 字段权限 | 保护的字段 | 默认拥有 |
| --- | --- | --- |
| `field.cost` | 采购单价、到岸成本、头程与关税分摊、成本版本、库存货值与资金占用、采购单金额 | 所有者、管理员、财务、供应链 |
| `field.profit` | 净利润、利润率、毛利、利润桥、广告分摊后利润、单位经济瀑布中的利润项、补货建议中的利润预估 | 所有者、管理员、运营、广告、财务 |
| `field.buyer` | 买家姓名、地址、联系方式、买家备注（订单详情"买家信息"页签；每次查看填写理由并写审计） | 所有者、管理员 |

规则：
- 页面：没有权限时，该字段所在的列、卡片、页签整体不渲染，不显示"无权限"占位的假数值；
- 接口：序列化层按字段权限过滤，响应中不含该键；
- 导出：导出文件按发起人的字段权限生成，导出任务执行时重新校验；
- 买家信息永不进入日志、导出与智能问答，到期自动删除，访问写审计；
- 缺少 `field.cost` 的用户在"商品成本"页只看到"无权限"整页提示；
- 缺少 `field.profit` 时，经营控制台的净利润、利润率卡不出现，其余卡片正常。

## 四、预设角色说明（7 个）

| 角色 | 定位 | 要点 |
| --- | --- | --- |
| 所有者 | 企业创建者 | 全部权限与全部字段权限；唯一能改所有者归属；高风险操作仍需再次验证身份 |
| 管理员 | 企业管理 | 与所有者相同，但不能转让所有权、不能删除企业 |
| 运营 | 商品、定价、刊登、评价、分析 | 可改价、改刊登、请求评价（均受写入开关）；不可见采购成本；可见利润 |
| 广告 | 广告投放 | 广告全部写权限（均受写入开关）；可见利润用于广告分摊后利润；不可见采购成本 |
| 财务 | 对账、利润、关账、赔付 | 对账、关账、利润、成本；可审批采购单与盘点差异；不可重新开账；不改广告与刊登 |
| 供应链 | 补货、采购、头程、入仓、国内仓 | 采购、收货、入仓、头程、国内仓、成本录入；不可审批自己的采购单；不可付款 |
| 只读 | 查看者 | 只有查看权限，无导出、无字段级敏感权限、无任何写权限 |

分离职责约束（后端强制）：
1. 采购单创建人与审批人不能是同一人（`purchase.order.approve`）；
2. 盘点差异的录入人与审批人不能是同一人（`warehouse.stockcount.approve`）；
3. 财务口径修改的发起人与审批人不能是同一人；
4. 自定义角色同样适用以上约束。

自定义角色：在角色编辑器按"模块 × 动作"矩阵勾选；字段级权限单独勾选；预设角色可复制后修改，预设本身不可改。

## 五、旧 16 个权限的映射

迁移时，持有旧权限的角色自动获得下表右侧的新权限，保证已有角色继续可用；之后可由管理员收紧。

| 旧权限 | 映射为 |
| --- | --- |
| `entity.read` | `entity.read` |
| `entity.write` | `entity.write` |
| `seller.read` | `products.read`、`inventory.read`、`inbound.read`、`purchase.read`、`supplier.read`、`warehouse.read`、`reports.read`、`connection.read`、`sync.read` |
| `seller.write` | `inbound.plan.write`、`purchase.order.write`、`reports.create` |
| `connection.manage` | `connection.manage`、`notifications.manage` |
| `orders.read` | `orders.read`、`returns.read` |
| `refunds.read` | `returns.read`、`reimbursements.read` |
| `finance.read` | `finance.read`、`profit.read`、`field.profit` |
| `ads.read` | `ads.read` |
| `ads.report` | `ads.report` |
| `sync.manage` | `sync.manage`、`sync.read` |
| `export.create` | `export.create` |
| `member.read` | `member.read` |
| `member.invite` | `member.invite` |
| `role.manage` | `role.manage`、`member.manage` |
| `audit.read` | `audit.read` |

说明：旧权限不授予任何字段权限 `field.cost`、`field.buyer`（旧体系没有该概念，默认不放开）；仅 `finance.read` 因历史上可见利润类数据，映射为 `field.profit`。映射表保存在后端配置中，迁移完成后旧点位仍可被识别 12 个月，之后移除。

## 六、写入开关清单与权限对应

开关在"企业设置 → 接口与写入开关"页面操作，每项独立。开关键用于后端校验与审计。

### 6.1 卖家接口写入（11 项）

| 开关键 | 页面显示名 | 所需权限 | 涉及后端接口 |
| --- | --- | --- | --- |
| `sw.inbound.plan.create` | 创建入仓计划 | `inbound.plan.write` | `POST /inbound/plans` |
| `sw.inbound.packing.confirm` | 确认装箱方案 | `inbound.plan.write` | `POST /inbound/plans/:id/packing-options`（确认） |
| `sw.inbound.packinginfo.submit` | 提交箱内物品信息 | `inbound.plan.write` | `POST /inbound/plans/:id/packing-info` |
| `sw.inbound.placement.confirm` | 确认分仓方案 | `inbound.plan.write` | `POST /inbound/plans/:id/placement-options`（确认） |
| `sw.inbound.transport.confirm` | 确认承运方式与送达时间窗 | `inbound.plan.write` | `POST /inbound/plans/:id/transport-options`、`.../delivery-windows` |
| `sw.listing.update` | 修改刊登 | `listing.write` | `PATCH /listings/:sku` |
| `sw.pricing.update` | 修改价格 | `pricing.price.write` | `PATCH /pricing/:sku` |
| `sw.solicitation.send` | 请求评价 | `reviews.solicit` | `POST /reviews/solicitations` |
| `sw.aplus.submit` | A+ 内容提交 | `aplus.write` | `POST /aplus`、`PATCH /aplus/:id`、`POST /aplus/:id/submit` |
| `sw.awd.order.write` | 上游仓储入库订单 | `awd.order.write` | `POST\|PATCH /awd/orders`、`POST /awd/orders/:id/{confirm,cancel}` |
| `sw.feeds.batch` | 批量刊登任务 | `listing.write` | 批量价格与刊登修改任务 |

### 6.2 广告接口写入（8 项）

| 开关键 | 页面显示名 | 所需权限 | 涉及后端接口 |
| --- | --- | --- | --- |
| `sw.ads.status` | 活动状态 | `ads.campaign.write` | `PATCH /ads/campaigns`、`PATCH /ads/ad-groups/:id`、`PATCH /ads/targets/:id`（状态） |
| `sw.ads.budget` | 预算 | `ads.budget.write` | `PATCH /ads/campaigns`（预算）、`POST /ads/portfolios`（预算上限与规则） |
| `sw.ads.bid` | 竞价 | `ads.bid.write` | `PATCH /ads/campaigns`（竞价策略）、`PATCH /ads/ad-groups/:id`、`PATCH /ads/targets/:id` |
| `sw.ads.negative` | 否定投放 | `ads.negative.write` | `POST /ads/negatives` |
| `sw.ads.keyword` | 添加关键词 | `ads.keyword.write` | `POST /ads/keywords` |
| `sw.ads.placement` | 广告位调整 | `ads.placement.write` | `PATCH /ads/campaigns`（广告位调整） |
| `sw.ads.rule.run` | 自动规则执行 | `ads.rule.write` | 规则调度执行 |
| `sw.ads.dayparting.run` | 分时策略执行 | `ads.rule.write` | 分时调度执行 |

### 6.3 自动化（1 项）

| 开关键 | 页面显示名 | 所需权限 | 说明 |
| --- | --- | --- | --- |
| `sw.pricing.rule.auto` | 定价规则自动执行 | `pricing.rule.write` | 关闭时，所有定价规则只能为"手动模式"（只出建议） |

### 6.4 开关的通用规则

- 开启必须具备 `settings.integration.write`（仅所有者、管理员），并自动检查前置条件：应用凭据已配置、授权范围含所需写权限、连接健康；填写开启原因并二次确认；写审计并通知所有管理员；
- 部署环境变量只保留"紧急强制关闭"一项，优先级最高；
- 写调用连续失败或授权失效时自动关闭并告警；
- 亚马逊未授予写权限时，前置检查无法通过。

## 七、需要再次验证身份的操作

| 操作 | 说明 |
| --- | --- |
| 开启任一写入开关、"一键全部只读"之外的开关变更 | 防止被盗会话开启写入 |
| 重新开账 | `finance.period.reopen` |
| 断开连接 | `connection.manage` |
| 修改成员角色、授权数据范围、停用成员 | `member.manage` |
| 修改角色权限 | `role.manage` |
| 查看买家信息 | `field.buyer`，同时要求填写理由 |
| 导出含敏感字段的文件 | 在发起时验证 |
| 手工覆盖汇率 | `settings.fx.write` |
| 修改财务口径（审批环节） | `finance.policy.write` |

再次验证的有效期为 10 分钟，到期重新验证。

## 八、平台运营后台权限（与租户体系分离）

| 权限点 | 含义 |
| --- | --- |
| `platform.tenant.read` | 查看租户列表、用量 |
| `platform.tenant.manage` | 邀请开通、暂停、恢复、停用、注销租户 |
| `platform.support.access` | 发起限时支持访问（需租户所有者授权，到期自动失效，写双方审计） |
| `platform.quota.manage` | 设置租户配额 |

平台账号单独存放（`PlatformAdmin`），强制多因素验证，不与租户成员混用。

## 九、统计

- 租户权限点：首页与协作 9、运营分析 2、商品 17、库存 7、供应链 17、订单与售后 5、财务 10、广告 11、风险与报表 11、连接与治理 16，合计 **105 个**；
- 字段权限：3 个；基础权限：6 个；
- 写入开关：20 项（卖家 11、广告 8、自动化 1）；
- 平台权限：4 个；
- 预设角色：7 个。
- 阶段 6 登记待并入的权限点：0 个（第十节已空；`dashboard.write`、`dashboard.share` 已由 P6-33 并入第二节 2.9）。

## 十、阶段 6 新增权限点（CR-107，P6-00 登记；已全部并入第二节）

本节登记 14 章阶段 6 各工作包要新增的权限点。P6-33 交付后本节表格已空，权限目录由第二节生成（现为 105 个）。交付之前，接口不得引用尚未并入第二节的点位（`permission-registry.test.ts` 会拦住）。

| 权限点 | 含义 | 类型 | 所有者 | 管理员 | 运营 | 广告 | 财务 | 供应链 | 只读 | 工作包 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### 10.1 阶段 6 新页面的进入权限

| 页面 | 进入权限 | 说明 |
| --- | --- | --- |
| 审批收件箱 `/app/approvals` | 基础 | 只看到与自己有关的单据；审批动作按单据类型沿用原模块的审批权限 |
| 自定义仪表盘 `/app/dashboards`、`/app/dashboards/:id` | 基础 | 打开页面不要求数据权限；每个组件按查看人的权限取数，没有权限显示“无权查看”，不报错 |
| 我的报表、自定义指标 | `reports.read` | 创建与修改另需 `reports.custom.write` |
| 商品表现、销量统计 | `analytics.read` | 利润列另需 `field.profit`，成本、货值列另需 `field.cost`，没有权限整组不返回 |
| 跨仓总览、进销存报表 | `inventory.read` | 货值另需 `field.cost` |
| 发货地址、标签模板 | `inbound.read` | 修改另需 `shipfrom.manage`、`labeltemplate.manage` |
| 物流渠道与报价 | `firstmile.read` | 修改沿用 `firstmile.write` |
| 利润项目字典、利润公式、费用分摊规则、预估与自定义费用 | `finance.read` | 修改分别需 `finance.profititem.manage`、`finance.policy.write`（利润公式与费用分摊，修改走审批）、`finance.estimatedfee.write` |
| 规则模板 | `alerts.read` | 用模板新建规则另需 `alerts.manage` |
| 跟卖监控、新品定价试算 | `tools.read` | 白名单另需 `tools.manage` |
| 业务口径 | `settings.read` | 修改另需 `settings.business.write` |

### 10.2 阶段 6 沿用现有权限点的写操作

| 操作 | 沿用的权限点 | 工作包 |
| --- | --- | --- |
| 补货批次一键转入仓计划草稿 | `replenishment.plan.create`（已含“生成入仓计划草稿”）；草稿后续的提交仍要 `inbound.plan.write` 与写入开关 | P6-08 |
| 人工预测规则（按时间段） | `replenishment.policy.write` | P6-09 |
| 装箱编辑、装箱单应用到装箱、箱标签与商品标签生成 | `inbound.plan.write`（生成标签为本地导出任务，不调用亚马逊写接口，不受写入开关控制） | P6-10、P6-11、P6-12 |
| 退货原因映射维护 | `settings.write` | P6-13 |
| 个人信息查看明文（`POST /pii/reveal`） | 字段权限 `field.buyer`，必填理由，写审计 | P6-14 |
| 预警标记已读、已处理 | `alerts.read`（已读，按用户记录）、`alerts.handle`（处理） | P6-15 |
| 预警规则的条件、通知频率、升级 | `alerts.manage` | P6-16 |
| 定价规则“情形 × 动作”矩阵 | `pricing.rule.write` | P6-17 |
| 费用分摊规则、利润公式 | `finance.policy.write`（发起人与审批人不能是同一人，沿用第四节第 3 条） | P6-19、P6-31 |
| 物流渠道、报价、预估头程费用 | `firstmile.write`（预估为只读计算，`firstmile.read` 即可；金额字段另需 `field.cost`；已落地 CR-136） | P6-26 |
| 词研究一键加词、加否定 | `ads.keyword.write`、`ads.negative.write`，受写入开关“添加关键词”“否定投放”控制 | P6-24 |
| 事件接口 `GET /events` | 每类事件按各自模块的读权限过滤（广告变更需 `ads.read`，预警需 `alerts.read` 等） | P6-06（**已实现，CR-114**：价格 `pricing.read`、广告变更 `ads.read`、预警 `alerts.read`、Listing 变更 `listing.read`、系统操作 `audit.read`，运营日志与其他随对象读权限；没有新增权限点，本行保留作登记） |
| 个人偏好（收藏、密度、通知偏好） | 基础权限 `profile.manage` | P6-01 |

### 10.3 阶段 6 对其他规则的说明

- **字段权限**：不新增。商品表现、销量统计、跨仓与进销存、自定义报表与仪表盘都按第三节执行，没有权限的列在响应里不返回，共享内容按查看人取数。
- **写入开关**：不新增，仍是 20 项。只有调用亚马逊写接口的动作需要开关；本地草稿、本地导出、本地配置不需要。
- **再次验证身份**：不新增。利润公式与业务口径的审批环节沿用第七节“修改财务口径（审批环节）”；`POST /pii/reveal` 沿用第七节“查看买家信息”（理由必填）。
- **分离职责**：利润公式、费用分摊规则的发起人与审批人不能是同一人；审批收件箱里的审批同样适用，审批人与发起人相同时后端拒绝。
