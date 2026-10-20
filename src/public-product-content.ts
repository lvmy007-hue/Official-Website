import { company } from './site-company'

export const productTabs = [
  { page: 'product-stores', href: '/product/stores', label: '多店铺' },
  { page: 'product-orders', href: '/product/orders', label: '订单' },
  { page: 'product-returns', href: '/product/returns', label: '退货' },
  { page: 'product-finance', href: '/product/finance', label: '财务' },
  { page: 'product-advertising', href: '/product/advertising', label: '广告' },
  { page: 'product-permissions', href: '/product/permissions', label: '权限' },
  { page: 'product-inventory', href: '/product/inventory', label: '库存' },
  { page: 'product-listings', href: '/product/listings', label: '刊登' },
  { page: 'product-inbound', href: '/product/inbound', label: '入库' },
] as const

export const productAreas = [
  {
    href: '/product/stores',
    title: '法律主体与店铺',
    claim: '每家公司单独授权，店铺才进入可查询范围。',
    problem: '多个公司的卖家账号若只靠同一套登录区分，就说不清数据属于哪一个法律主体。',
    features: ['法律主体下登记卖家账号', '卖家账号再对应站点', '连接记录授权状态和最近成功同步时间', '查询带租户条件'],
    source: '数据来自该法律主体自己发起的卖家授权。应用审批未完成时，连接停在等待审批。',
    status: '已建模。是否出现真实店铺，取决于授权是否完成。',
  },
  {
    href: '/product/orders',
    title: '订单',
    claim: '订单按卖家账号保存购买时间、状态、币种和来源更新时间。',
    problem: '只看一个汇总数字时，无法判断订单属于哪家公司、哪个站点、哪一天。',
    features: ['订单号与卖家账号绑定', '保留购买时间', '金额带币种', '保留来源更新时间'],
    source: '订单读取依赖卖家授权和同步任务。公开页面不展示任何真实订单。',
    status: '订单记录已建模。不能据此认为所有订单接口都已经可以读取。',
  },
  {
    href: '/product/returns',
    title: '跨月退货',
    claim: '退款要能对回原来的订单月份，不能只看退款发生在本月。',
    problem: '财务月结时，本月收到的退款经常来自更早的订单。',
    features: ['退货记录保留退货日期', '可关联原订单号', '退款金额单独记录', '库存处置和退款不是同一件事'],
    source: '退货记录依赖卖家授权。原订单月份要用订单购买日对照，系统里没有单独的“原订单月”字段。',
    status: '退货记录已建模。首页和本页的月份矩阵是演示口径。',
  },
  {
    href: '/product/finance',
    title: '财务结算',
    claim: '收入、退款、费用按同一币种排列，不同币种不相加。',
    problem: '把美元订单和欧元费用合成一个总数，会得到无法核对的净额。',
    features: ['费用事件保留入账时间', '费用可带结算编号', '退款金额与订单金额分开', '币种随记录保存'],
    source: '财务读取依赖卖家授权。页面没有自动汇率换算。',
    status: '费用事件已建模。净额只在同一币种内计算。',
  },
  {
    href: '/product/advertising',
    title: '广告分析',
    claim: '广告账户必须单独授权，不能默认等于卖家账号。',
    problem: '多家公司各自有广告账户时，未授权的花费和销售额不能显示成已经同步。',
    features: ['广告授权与卖家授权分开', '指标按账户币种理解', '报表任务失败时保留失败状态', '没有授权就不展示成绩'],
    source: '广告数据来自该广告账户的单独授权，与卖家授权分开。',
    status: '授权后可查看报表。默认只读。',
  },
  {
    href: '/product/permissions',
    title: '成员权限',
    claim: '登录成功不等于可以查看所有公司的数据。',
    problem: '运营、财务和广告人员需要的数据范围不同，共用一个管理员账号就无法区分责任。',
    features: ['成员必须属于目标租户', '角色使用分开的权限码', '读取和连接管理不是同一个权限', '缺少成员关系时接口拒绝访问'],
    source: '权限由企业管理员在工作台配置。公开页面不展示真实成员。',
    status: '接口已按权限码校验。',
  },
  {
    href: '/product/inventory',
    title: 'FBA 库存',
    claim: '可售、预留、在途和不可售数量挂在已授权的卖家账号和站点上。',
    problem: '库存若脱离法律主体，就无法说明这批货属于哪家公司。',
    features: ['按卖家账号和 Seller SKU 保存', '区分可售、预留、在途和不可售', '低库存会标出状态', '未授权公司不出现库存数字'],
    source: '库存来自该卖家账号的 FBA Inventory 同步。公开页不展示真实库存。',
    status: '库存记录已建模。同步完成后才能在工作台查看。',
  },
  {
    href: '/product/listings',
    title: '商品刊登',
    claim: 'ASIN、Seller SKU、FNSKU 和刊登状态用于店铺与商品对照。',
    problem: '同一件商品在不同店铺的 SKU 对不上时，订单和库存无法归到同一条商品。',
    features: ['读取商品刊登报表', '保留 ASIN 与 Seller SKU', '可记录 FNSKU 和履约方式', '不在本系统里代替卖家修改刊登'],
    source: '商品目录来自已授权店铺的刊登报表。',
    status: '刊登报表解析后写入商品主数据。本系统不代替卖家提交新刊登。',
  },
  {
    href: '/product/inbound',
    title: 'FBA 入库',
    claim: '入库计划、货件和接收数量按已授权卖家账号保存。',
    problem: '补货如果只留在表格里，就看不出哪票货已经到达履约中心、收了多少。',
    features: ['创建入库计划前必须已有卖家授权', '发货地址按亚马逊要求的字段填写', '货件编号、目的仓和应收数量分开记录', '未返回真实货件前不编写造的货件号'],
    source: '入库使用该卖家账号的 Fulfillment Inbound 接口。',
    status: '已授权后可以创建计划并同步货件。',
  },
]

export const permissionRows = [
  ['entity.read / entity.write', '查看或维护法律主体'],
  ['seller.read / seller.write', '查看或维护卖家账号'],
  ['connection.manage', '发起和管理授权连接'],
  ['orders.read', '查看订单'],
  ['refunds.read', '查看退款'],
  ['finance.read', '查看财务记录'],
  ['ads.read / ads.report', '查看广告或创建广告报表任务'],
  ['sync.manage', '创建同步任务'],
  ['export.create', '创建导出'],
  ['member.read / member.invite / role.manage', '查看成员、邀请成员、管理角色'],
  ['audit.read', '查看审计事件'],
]

export const adHierarchy = ['广告主', 'Advertising Profile', 'Portfolio', 'Campaign', 'Ad Group', 'Targeting / Keywords']

export const adKpis = [
  ['花费', '广告账户报告中的 spend', '账户币种', '所选日期范围', '以报表截止时间为准'],
  ['展示', 'impressions', '次数', '所选日期范围', '以报表截止时间为准'],
  ['点击', 'clicks', '次数', '所选日期范围', '以报表截止时间为准'],
  ['CTR', '点击 ÷ 展示', '比率', '与点击、展示同一窗口', '随报表更新'],
  ['CPC', '花费 ÷ 点击', '账户币种', '与花费、点击同一窗口', '随报表更新'],
  ['广告销售额', '报告中的广告归因销售额', '账户币种', '按账户报表的归因窗口', '以报表截止时间为准'],
  ['ACOS', '花费 ÷ 广告销售额', '比率', '同一账户、同一窗口', '随报表更新'],
  ['ROAS', '广告销售额 ÷ 花费', '比率', '同一账户、同一窗口', '随报表更新'],
]

export const adCampaignDemo = [
  ['示例活动-品牌词', 'SP', '启用', '120.00', '86', '640.00', '18.8%', '5.33'],
  ['示例活动-自动投放', 'SP', '启用', '80.00', '54', '210.00', '38.1%', '2.63'],
]

export const adAccountDemo = ['示例广告账户', '示例-1001', '北美', 'USD', '示例', '2026-10-19 09:00']

export const adReportFlow = [
  ['创建', '有广告报表权限的成员选择账户、日期和报表类型并提交任务。'],
  ['等待', '任务进入队列。页面显示等待中，完成前不把结果写成已更新。'],
  ['下载', '平台返回报表文件后，系统下载该文件。'],
  ['解析', '解析花费、点击和销售额。失败时保留失败原因，并可重新提交。'],
  ['查看', '解析完成后，按账户币种查看活动、广告组和关键词。不同币种不相加。'],
]

export const adFaqs = [
  { q: '广告授权和卖家授权是一次完成的吗？', a: '不是同一次授权。卖家数据使用卖家授权，广告数据需要广告账户另行同意。' },
  { q: '接口审批通过了吗？', a: '广告数据要等广告账户持有人完成授权后才能读取。网站不把未授权账户显示成已有报表。' },
  { q: '历史广告数据会自动回填吗？', a: '授权完成后，按该账户同意的日期范围拉取报表。页面会标出数据截止时间。' },
  { q: '报表多久刷新一次？', a: '默认同步为每日一次。每次报表都显示截止时间，便于和广告后台核对。' },
  { q: '多个站点可以放在一起吗？', a: '可以按账户和站点对照查看。不同币种的花费和销售额不能直接相加。' },
]

export const pricingFactors = ['法律主体数量', '店铺规模', '用户席位', '使用的模块', '同步频率', '实施或定制服务']

export const pricingBands = [
  { title: '方案里会说明的内容', text: '工作台范围、已授权数据的查看方式、成员权限，以及订单、退货、财务模块是否包含在内。' },
  { title: '需要单独确认的范围', text: '现场实施、额外定制和同步频率由企业接入范围决定。人工广告代运营不在本服务内。' },
  { title: '交付边界', text: '不代替企业完成 Amazon 应用审批，也不保证卖家或广告接口一定可读。广告查看在平台授权完成前不可用。' },
]

export const pricingSteps = [
  ['01', '提交咨询', '在联系页说明主体数量、店铺规模和需要的报表。'],
  ['02', '核对范围', '确认哪些公司会授权，以及要使用订单、退货、财务还是广告。'],
  ['03', '书面方案', '费用、期限和支持方式以双方确认的书面方案为准。'],
]

export const pricingFaqs = [
  { q: '如何确认服务范围？', a: '请在联系页说明法律主体、店铺数量、需要的 Amazon 数据域和成员角色，团队会按实际接入范围确认模块。' },
  { q: '怎么开始？', a: `在联系页提交预约，或发送邮件到 ${company.email}。没有自助开通。` },
  { q: '接入后可以使用什么？', a: '工作台范围、授权后的查看方式、成员权限，以及订单、退货、财务和广告数据边界会在接入确认中写明。' },
  { q: '哪些边界需要提前确认？', a: '现场实施、额外定制和同步频率需要提前确认。人工广告代运营不在服务内。' },
  { q: '数据放在哪、保存多久？', a: '业务数据存放地区和买家个人信息的删除期限，与隐私政策同一句。' },
  { q: '没有开发人员能不能用？', a: '查询在网页里完成。应用审批仍由企业自己向亚马逊提交。' },
  { q: '广告和店铺是不是一起开通？', a: '不是。广告账户要单独授权，报表只读。' },
]

export const serviceNature = 'NOVA ERP 提供广告报表与分析软件。卖家完成广告账户授权后，可以按账户查看花费和广告销售额。不提供人工代运营，也不代替客户修改竞价。'

export const pricingScenarios = [
  { name: '单公司起步', entities: '1 个法律主体', stores: '1 到 5 个店铺', includes: '订单、退货、库存、刊登、入库、财务和成员权限。不含广告。', quote: '书面方案按年列出这一档费用。网页不收款，也不把样例写成标价。' },
  { name: '多公司', entities: '最多 3 个法律主体', stores: '6 到 20 个店铺', includes: '单公司起步的范围，并包含广告只读报表。每个主体单独授权。', quote: '书面方案按主体数量和是否包含广告分别列明。' },
  { name: '超出上述范围', entities: '3 个以上法律主体', stores: '20 个以上店铺，或需要现场实施', includes: '模块按确认后的范围组合，不默认包含代投放。', quote: '另行出具方案，不套用前两档。' },
]
