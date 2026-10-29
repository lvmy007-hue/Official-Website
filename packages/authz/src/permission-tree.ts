import { PERMISSION_CATALOG, type PermissionEntry } from './catalog'
import type { FieldKey } from './index'

// 角色编辑器的权限树（P5-08，09 章 9.10 与 CR-096 补充）：权限点按“模块 → 页面 → 动作”三级分组，每个权限点写一句影响范围。
// 模块沿用权限目录的分组；页面与影响范围写在这里。单独成文件：只有成员与角色相关页面用得到，首屏不引用。
// 目录里新增权限点时必须在这里补一行（permission-tree.test.ts 会核对），否则角色编辑器里没有它的位置。

export interface PermissionMeta {
  page: string
  impact: string
}

export const PERMISSION_META: Readonly<Record<string, PermissionMeta>> = {
  'overview.read': { page: '经营控制台与今日实时', impact: '能打开经营控制台和今日实时，看到销售、订单、广告等汇总数字' },
  'workitem.read': { page: '待办', impact: '能看到全部成员的待办，而不只是自己的' },
  'workitem.assign': { page: '待办', impact: '能把待办指派或转派给其他成员' },
  'workitem.handle': { page: '待办', impact: '能确认、忽略、延期和关闭待办' },
  'targets.read': { page: '目标与预算', impact: '能查看销售、利润等目标的完成进度' },
  'targets.write': { page: '目标与预算', impact: '能新建和修改目标，会改变首页上的完成率' },
  'collab.write': { page: '评论与关注', impact: '能在各详情页评论、@成员和关注对象' },
  'grid.view.share': { page: '表格视图', impact: '能把自己保存的表格视图共享给团队，并设置团队默认视图；个人视图不需要该权限' },
  'export.create': { page: '导出中心', impact: '能发起导出任务；导出的列仍受字段权限限制' },
  'analytics.read': { page: '业务报告', impact: '能看业务报告、ASIN 与父体分析、促销与优惠券、订阅省' },
  'analytics.brand.read': { page: '品牌分析', impact: '能看品牌分析五页（店铺需具备品牌分析资格）' },
  'products.read': { page: '商品主数据', impact: '能打开商品列表和 ASIN 360 全景页' },
  'catalog.meta.write': { page: '商品主数据', impact: '能给商品设置负责人、标签和关注，只改系统内数据，不写亚马逊' },
  'listing.read': { page: '刊登', impact: '能看刊登表现、刊登质量与合规问题' },
  'listing.write': { page: '刊登', impact: '能修复刊登、发起批量刊登任务（仍受写入开关控制）' },
  'pricing.read': { page: '定价与购物车', impact: '能看价格、购物车占有率和定价规则' },
  'pricing.price.write': { page: '定价与购物车', impact: '能修改商品价格并同步到亚马逊（受写入开关控制）' },
  'pricing.rule.write': { page: '定价与购物车', impact: '能设置价格护栏和手动、自动定价规则' },
  'competitors.read': { page: '竞品监控', impact: '能查看关注竞品的价格与变化' },
  'competitors.write': { page: '竞品监控', impact: '能添加和移除关注的竞品' },
  'tools.read': { page: '跟卖监控', impact: '能查看我方商品上出现的其他报价方（来自官方竞争摘要，有延迟）与跟卖白名单' },
  'tools.manage': { page: '跟卖监控', impact: '能新增、删除跟卖白名单（白名单里的卖家不再算跟卖，也不触发预警）' },
  'reviews.read': { page: '评价与反馈', impact: '能看评分、评价主题和改进建议' },
  'reviews.solicit': { page: '评价与反馈', impact: '能向买家请求评价，每单只能一次（受写入开关控制）' },
  'aplus.read': { page: 'A+ 内容', impact: '能查看 A+ 内容与审核状态' },
  'aplus.write': { page: 'A+ 内容', impact: '能创建、编辑并提交 A+ 内容（受写入开关控制）' },
  'costs.read': { page: '商品成本', impact: '能打开商品成本页；成本数字还需要成本字段权限' },
  'costs.write': { page: '商品成本', impact: '能录入和导入成本版本，会改变利润计算' },
  'inventory.read': { page: '库存健康', impact: '能看库存健康、库存详情、台账、移除与弃置、仓储容量与费用' },
  'inventory.removal.receive': { page: '移除与弃置', impact: '能登记移除退回件的收货核对' },
  'replenishment.read': { page: '补货建议', impact: '能看补货建议与计算批次' },
  'replenishment.plan.create': { page: '补货建议', impact: '能由补货建议生成采购单、入仓计划、上游仓储订单的草稿，并触发重算' },
  'replenishment.policy.write': { page: '补货建议', impact: '能编辑企业、品类、SKU 三级补货策略，会改变建议数量' },
  'awd.read': { page: '亚马逊仓储分销', impact: '能查看上游仓储库存与入库订单' },
  'awd.order.write': { page: '亚马逊仓储分销', impact: '能创建、更新、取消、确认入库订单并更新运输信息（受写入开关控制）' },
  'purchase.read': { page: '采购订单', impact: '能看采购订单列表与详情（金额还需成本字段权限）' },
  'purchase.order.write': { page: '采购订单', impact: '能创建、编辑采购单，提交审批，上传附件' },
  'purchase.order.approve': { page: '采购订单', impact: '能审批采购单；创建人不能审批自己的单' },
  'purchase.receive': { page: '采购订单', impact: '能登记收货和质检' },
  'purchase.pay': { page: '采购订单', impact: '能登记采购付款' },
  'supplier.read': { page: '供应商', impact: '能查看供应商资料与绩效' },
  'supplier.write': { page: '供应商', impact: '能新增和编辑供应商' },
  'warehouse.read': { page: '国内仓', impact: '能看国内仓库存与出入库流水' },
  'warehouse.stockcount.write': { page: '国内仓', impact: '能创建盘点单并录入盘点结果' },
  'warehouse.stockcount.approve': { page: '国内仓', impact: '能审批盘点差异，审批后才会调整库存' },
  'firstmile.read': { page: '头程物流', impact: '能看头程运单、节点与时效统计（费用还需成本字段权限）' },
  'firstmile.write': { page: '头程物流', impact: '能录入运单、节点、费用，并执行费用分摊' },
  'inbound.read': { page: '入仓计划', impact: '能看入仓计划、货件接收与差异' },
  'inbound.plan.write': { page: '入仓计划', impact: '能创建计划、确认装箱与分仓、确认运输、取消计划（受写入开关控制）' },
  'shipfrom.manage': { page: '发货地址', impact: '能新增、修改、停用、删除发货地址并设置店铺默认地址；补货批次转入仓计划草稿时按这些地址分组' },
  'labeltemplate.manage': { page: '标签模板', impact: '能新增、修改、删除标签模板与箱号规则，设置默认模板；生成自定义箱标签时按这些模板追加文字' },
  'skualias.manage': { page: '外部货号映射', impact: '能新增、修改、删除外部货号映射并导入，保存供应商装箱单的列映射；装箱单匹配时“记住这个对应关系”也需要它' },
  'orders.read': { page: '订单', impact: '能看订单列表与详情；买家个人信息另需买家字段权限' },
  'returns.read': { page: '退货', impact: '能看退货记录与退货原因' },
  'reimbursements.read': { page: '赔付中心', impact: '能看赔付机会、案件与已到账赔付' },
  'reimbursements.write': { page: '赔付中心', impact: '能生成案件、导出证据包、回填案件编号和更新状态' },
  'support.read': { page: '支持案件', impact: '能查看同步下来的亚马逊支持案件（只读）' },
  'finance.read': { page: '费用与结算', impact: '能看费用事件、费用核查、结算交易、回款与官方经济数据对账' },
  'finance.reconcile': { page: '对账', impact: '能标记差异并填写对账备注' },
  'finance.tax.read': { page: '销售税', impact: '能看销售税页（亚马逊受限角色需已授权）' },
  'profit.read': { page: '利润分析', impact: '能打开利润分析页；利润数字还需要利润字段权限' },
  'finance.policy.write': { page: '财务口径', impact: '能提交和审批收入确认、存货计价、广告与费用分摊口径，会改变所有利润数字' },
  'finance.estimatedfee.write': {
    page: '预估与自定义费用',
    impact: '能录入、修改、删除、导入预估与自定义费用，这些费用会以“估算”计入利润（下次重算利润日表后生效，已关账期间不受影响；实际费用出账后对应期间的预估自动冲销）',
  },
  'finance.profititem.manage': { page: '利润项目字典', impact: '能整树保存利润项目并调整交易类型的归属，会改变利润分析按项目拆分的结果（下次重算利润日表后生效，已关账期间不受影响）' },
  'settings.business.write': { page: '业务口径', impact: '能修改净销售额公式、可用库存组成、周起始日与多站点“今日”的取法，形成新口径版本并提交审批，会改变全站相关数字' },
  'finance.period.close': { page: '期间关账', impact: '能发起、审批并执行期间关账，关账后该期间数据被锁定' },
  'finance.period.reopen': { page: '期间关账', impact: '能重新开账（需原因并再次验证身份），已锁定的期间会重新可改' },
  'settings.fx.write': { page: '汇率', impact: '能手工覆盖汇率、选择汇率主源，会改变折算后的金额' },
  'ads.read': { page: '广告查看', impact: '能看广告概览、活动、广告组、投放、词级与变更记录' },
  'ads.report': { page: '广告报告', impact: '能创建广告报告任务，并用广告指标做自由分析' },
  'ads.campaign.write': { page: '广告活动', impact: '能暂停、启用活动，改名称与日期（受写入开关控制）' },
  'ads.budget.write': { page: '广告活动', impact: '能修改广告预算（受写入开关控制）' },
  'ads.bid.write': { page: '广告活动', impact: '能修改竞价与竞价策略（受写入开关控制）' },
  'ads.negative.write': { page: '词级与否定投放', impact: '能添加否定投放（受写入开关控制）' },
  'ads.keyword.write': { page: '词级与否定投放', impact: '能添加关键词（受写入开关控制）' },
  'ads.placement.write': { page: '广告活动', impact: '能调整广告位竞价（受写入开关控制）' },
  'ads.portfolio.write': { page: '广告组合', impact: '能设置广告组合的预算上限与预算规则' },
  'ads.rule.write': { page: '自动规则与分时', impact: '能创建、编辑自动规则与分时策略；自动执行受写入开关控制' },
  'ads.account.bind': { page: '广告账户绑定', impact: '能把广告账户与店铺人工绑定，会改变广告数据归属的店铺' },
  'alerts.read': { page: '风险预警中心', impact: '能看预警列表与详情' },
  'alerts.handle': { page: '风险预警中心', impact: '能确认、忽略（需原因）、分派和关闭预警（需结论）' },
  'alerts.manage': { page: '预警规则', impact: '能配置预警规则、阈值、通知对象和静默时段' },
  'account.health.read': { page: '账户健康', impact: '能看账户健康指标与政策问题' },
  'reports.read': { page: '报表中心', impact: '能看报表任务并下载原始文件（链接短时有效）' },
  'reports.create': { page: '报表中心', impact: '能创建、取消、重试报告任务，会占用亚马逊接口额度' },
  'reports.custom.write': { page: '我的报表', impact: '能创建、修改自定义指标和我的报表，并能发起定时生成' },
  'reports.custom.share': { page: '我的报表', impact: '能把报表共享给团队；别人打开时按他自己的数据范围和字段权限取数' },
  'data.import': { page: '文件导入', impact: '能导入评分、仓储限额等没有官方来源的数据，并记录导入人' },
  'dashboard.write': { page: '自定义仪表盘', impact: '能创建、修改自己的仪表盘、文件夹和组件，并能保存布局' },
  'dashboard.share': { page: '自定义仪表盘', impact: '能把仪表盘共享给团队；别人打开时按他自己的数据范围和数据源权限取数' },
  'connection.read': { page: '连接中心', impact: '能看连接中心与消息推送订阅' },
  'connection.manage': { page: '连接中心', impact: '能授权、重新授权、健康检查和断开连接；断开后相关数据停止同步' },
  'notifications.manage': { page: '消息推送订阅', impact: '能订阅、取消订阅、改过滤条件、重放失败事件' },
  'sync.read': { page: '同步中心', impact: '能看同步任务、队列与限速状态' },
  'sync.manage': { page: '同步中心', impact: '能重试失败任务、发起同步，会占用亚马逊接口额度' },
  'entity.read': { page: '法律主体', impact: '能看法律主体及名下店铺' },
  'entity.write': { page: '法律主体', impact: '能新增、修改、停用法律主体' },
  'member.read': { page: '成员', impact: '能看成员列表与详情；待办、评论等处选择成员也需要它' },
  'member.invite': { page: '成员', impact: '能邀请新成员，并为其选定角色与数据范围' },
  'member.manage': { page: '成员', impact: '能停用成员、修改成员角色、授权数据范围（需再次验证身份）' },
  'role.manage': { page: '角色编辑器', impact: '能创建和编辑自定义角色，改变所有使用该角色的成员的权限' },
  'audit.read': { page: '审计中心', impact: '能查看企业内全部操作的审计记录' },
  'settings.read': { page: '企业设置', impact: '能看企业基本信息、数据保留与刷新策略' },
  'settings.write': { page: '企业设置', impact: '能修改基本信息、数据保留与刷新策略' },
  'settings.integration.write': { page: '接口与写入开关', impact: '能开启、关闭写入开关和一键全部只读，决定系统能不能改亚马逊上的数据' },
}

export interface PermissionAction extends PermissionEntry {
  impact: string
}
export interface PermissionPage {
  page: string
  actions: PermissionAction[]
}
export interface PermissionModule {
  module: string
  pages: PermissionPage[]
}

/** 三级权限树：模块（目录分组）→ 页面 → 动作，顺序沿用权限目录。每次调用现算，不在模块顶层求值（首屏摇树）。 */
export function permissionTree(): PermissionModule[] {
  const modules: PermissionModule[] = []
  for (const entry of PERMISSION_CATALOG) {
    const meta = PERMISSION_META[entry.key]
    const moduleNode = modules.find(item => item.module === entry.group) ?? modules[modules.push({ module: entry.group, pages: [] }) - 1]!
    const pageName = meta?.page ?? entry.label
    const pageNode = moduleNode.pages.find(item => item.page === pageName) ?? moduleNode.pages[moduleNode.pages.push({ page: pageName, actions: [] }) - 1]!
    pageNode.actions.push({ ...entry, impact: meta?.impact ?? entry.label })
  }
  return modules
}

/** 一个模块或页面下的全部权限点（整组勾选用）。 */
export const keysOfModule = (node: PermissionModule): string[] => node.pages.flatMap(page => page.actions.map(action => action.key))
export const keysOfPage = (node: PermissionPage): string[] => node.actions.map(action => action.key)

/** 字段级敏感权限的说明。“仅负责人可见”只对商品维度的成本与利润有意义；买家信息没有负责人的概念。 */
export const FIELD_META: Readonly<Record<FieldKey, { label: string; impact: string; ownerOnlyAllowed: boolean }>> = {
  cost: { label: '成本', impact: '能看到采购单价、头程与到岸成本、商品成本，以及利润分析里的成本列', ownerOnlyAllowed: true },
  profit: { label: '利润', impact: '能看到利润分析里的毛利、净利润、利润率，以及各页面上的利润列', ownerOnlyAllowed: true },
  buyer: { label: '买家信息', impact: '能查看订单里买家的姓名、邮箱、收货地址等个人信息（每次查看都写入审计）', ownerOnlyAllowed: false },
}
