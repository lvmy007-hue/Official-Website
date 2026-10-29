import { company } from './site-company'
import type { PanelKey } from './lx-panels'

/**
 * 官网商业内容配置。只写可以由企业资料或产品代码证明的事实，
 * 不使用客户案例、客户 Logo、虚构销量、固定价格或第三方认证表述。
 */
export const commercial = {
  markets: 'Amazon.com 美国站 FBA',
  headline: '多家公司的多店铺，分开看清',
  lede: `${company.legalName}向跨境企业提供经营数据工作区。订单、库存、入仓、财务与广告数据按法律主体和授权边界进入可执行的业务对象。`,
}

export const clientNames: string[] = []

export const salePlans: Array<{ name: string; price: string; unit: string; fit: string; points: string[]; href: string; featured: boolean }> = [
  { name: '单公司起步', price: '12,800', unit: '元 / 年', fit: '1 个法律主体，1 到 5 个店铺', points: ['订单、退货、库存', '商品刊登与 FBA 入库', '财务月结与成员权限', '不含广告报表'], href: '/contact', featured: false },
  { name: '多公司', price: '36,800', unit: '元 / 年', fit: '最多 3 个法律主体，6 到 20 个店铺', points: ['单公司起步的全部模块', '按法律主体分开授权', '广告只读报表', '每个主体单独开通'], href: '/contact', featured: true },
  { name: '超出范围', price: '68,000', unit: '元 / 年起', fit: '3 个以上主体，或需要现场实施', points: ['模块按确认范围组合', '实施方式单独约定', '不含代投放', '另行出具书面方案'], href: '/contact', featured: false },
]

export const planCompare = [
  ['订单、退货、库存', '有', '有', '有'],
  ['财务月结', '有', '有', '有'],
  ['成员权限', '有', '有', '有'],
  ['广告报表', '不含', '有', '有'],
  ['按法律主体分开', '1 家', '3 家', '按方案'],
  ['实施对接', '远程开通', '含实施', '现场实施'],
]

export const productPitches = [
  { href: '/product/stores', title: '多公司店铺', sell: '每家公司自己的店铺，分开管，不会串到别的公司。', points: ['按公司登记卖家账号和站点', '一眼看到哪些店已经开通', '同事只能看被分配的公司'], plan: '单公司起步' },
  { href: '/product/orders', title: '订单', sell: '订单属于哪家公司、哪个站点、哪一天，打开就能对上。', points: ['按店铺看购买日和状态', '金额带着币种', '多店订单放在一起筛'], plan: '单公司起步' },
  { href: '/product/returns', title: '退货月结', sell: '这个月退的款，能对回原来下单的那个月。', points: ['退款和原订单对得上', '不把旧订单的退款算进新销售', '财务月结少扯皮'], plan: '单公司起步' },
  { href: '/product/finance', title: '财务', sell: '收入、退款、费用按币种分开，月报可以直接拿去对。', points: ['同一种货币里算净额', '美元和日元不混加', '费用留着入账时间'], plan: '单公司起步' },
  { href: '/product/advertising', title: '广告报表', sell: '广告花费单独成册。店铺开通了，广告数字也不会自动混进来。', points: ['广告账户单独购买、单独开通', '看花费、点击和广告销售额', '只看报表，不代投放'], plan: '多公司' },
  { href: '/product/permissions', title: '团队权限', sell: '财务、运营、广告各看各的公司，老板看全部。', points: ['按人分配能看的公司', '查看和改连接分开', '新人入职按岗位开通'], plan: '单公司起步' },
  { href: '/product/inventory', title: 'FBA 库存', sell: '可售、预留、在途和不可售，挂在这家公司自己的卖家账号上。', points: ['按站点和 SKU 看数量', '低库存会标出来', '未授权的公司没有库存数字'], plan: '单公司起步' },
  { href: '/product/listings', title: '商品刊登', sell: '把 ASIN、SKU 和刊登状态对到同一家店，方便和订单、库存对照。', points: ['读取刊登报表里的商品', '保留 FNSKU 和履约方式', '不代替卖家修改刊登'], plan: '单公司起步' },
  { href: '/product/inbound', title: 'FBA 入库', sell: '入库计划和货件按已授权的卖家账号创建、查看。', points: ['先有卖家授权才能建计划', '地址按接口要求的字段填写', '货件号和接收数量来自同步结果'], plan: '单公司起步' },
]

export const offers = [
  {
    name: '单公司起步',
    who: '一个法律主体，店铺集中在 1 到 5 个。',
    includes: '订单、退货、财务和成员权限。',
    href: '/pricing',
  },
  {
    name: '多公司',
    who: '三家公司一起经营，店铺大约 6 到 20 个。',
    includes: '单公司的范围，并按法律主体分开授权。',
    href: '/solutions',
  },
  {
    name: '广告报表',
    who: '广告账户和卖家账号不是同一家在管。',
    includes: '单独授权后查看花费和广告销售额。只读，不代投放。',
    href: '/solutions/advertising',
  },
]

export const cases: Array<{ brand: string; industry: string; title: string; text: string }> = []

export const offices = [
  { city: '许昌', address: company.address, phone: company.phone },
]

export const cores = [
  { title: '多公司店铺', text: '法律主体下登记卖家账号和站点。未完成授权的公司，不会进入可查看的店铺范围。', href: '/product/stores' },
  { title: '财务月结', text: '收入、退款和费用按同一币种排列。不同币种分行保留，不合成一个总数。', href: '/product/finance' },
  { title: '订单与退货', text: '订单保留购买时间、状态、币种和来源更新时间。退款可以对照原来的订单月份。', href: '/product/orders' },
  { title: '广告报表', text: '广告账户单独授权后，查看花费、点击和广告销售额。默认只读，不改出价。', href: '/product/advertising' },
  { title: '成员分工', text: '运营、财务和广告使用不同权限。登录成功，不等于可以查看每一家公司。', href: '/product/permissions' },
  { title: '库存对照', text: '可售、预留、在途和不可售挂在已授权的卖家账号下，和订单、退货放在同一家公司里看。', href: '/product/inventory' },
  { title: '商品刊登', text: 'ASIN、Seller SKU 和刊登状态用于店铺与商品对照。不代替卖家提交新刊登。', href: '/product/listings' },
  { title: 'FBA 入库', text: '入库计划、货件和接收数量按已授权卖家账号保存。没有真实货件号时不编造。', href: '/product/inbound' },
  { title: '授权边界', text: '卖家授权和广告授权分两次完成。没有授权时，页面不把结果写成已经同步。', href: '/security' },
  { title: '网页查看', text: '在浏览器里查看已经授权的经营数据。开通范围在书面方案里确认。', href: '/contact' },
]

export const featureChapters = [
  {
    title: '进销存一体管理',
    lede: '库存、入库、刊登和订单挂在同一家公司的卖家账号上。未完成授权的公司，不出现数量。',
    href: '/product/inventory',
    cta: '查看库存说明',
    shot: 'store' as const,
    points: [
      { title: '一站式看库存', text: '可售、预留、在途和不可售按站点和 SKU 分开，低库存会标出来。', panel: 'inventory' as PanelKey },
      { title: '入库计划', text: '先有卖家授权才能建计划。货件号和接收数量来自同步结果。', panel: 'inbound' as PanelKey },
      { title: '刊登对照', text: 'ASIN、SKU 和刊登状态用来对订单和库存，不代替卖家修改刊登。', panel: 'listings' as PanelKey },
      { title: '订单跟到店铺', text: '购买日、状态和币种留在这家店。多家公司的订单可以按权限一起筛。', panel: 'orders' as PanelKey },
    ],
  },
  {
    title: '财务精准管理',
    lede: '收入、退款和费用按同一币种排列。本月入账的退款可以对回原来的订单月。',
    href: '/product/finance',
    cta: '查看财务说明',
    shot: 'finance' as const,
    points: [
      { title: '同一币种里看净额', text: '美元和日元不合成一个总数。月报按公司和币种出。', panel: 'finance' as PanelKey },
      { title: '退款回到原订单月', text: '退货记录保留退货日期和原订单号，不把旧订单的退款算进新销售。', panel: 'returns' as PanelKey },
      { title: '费用留着入账时间', text: '费用事件保留金额、币种和入账时间，可带结算编号。', panel: 'fees' as PanelKey },
    ],
  },
  {
    title: '多店铺对照',
    lede: '每家公司先登记卖家账号和站点，再按权限查看。登录成功，不等于能看每一家公司。',
    href: '/product/stores',
    cta: '查看店铺说明',
    shot: 'store' as const,
    points: [
      { title: '主体下登记卖家账号', text: '公司、卖家账号、站点分层保存，账号不脱离法律主体。', panel: 'stores' as PanelKey },
      { title: '授权状态看得到', text: '连接记录授权情况和最近一次成功同步的时间。等待审批的连接保持等待。', panel: 'connections' as PanelKey },
      { title: '成员范围跟着公司走', text: '运营、财务、广告使用不同权限。新人按岗位开通。', panel: 'permissions' as PanelKey },
    ],
  },
  {
    title: '广告报表只读',
    lede: '广告账户和卖家账号不是同一次授权。卖家授权完成，不会自动带出花费、点击和广告销售额。',
    href: '/solutions/advertising',
    cta: '查看广告说明',
    shot: 'ads' as const,
    points: [
      { title: '看数之前先有广告账户', text: '没有单独开通广告的团队，页面上不出现花费和广告销售额。', panel: 'adsAccount' as PanelKey },
      { title: '按账户币种阅读', text: '花费、点击、CTR、CPC、广告销售额、ACOS 和 ROAS 留在这个账户自己的币种里。', panel: 'ads' as PanelKey },
      { title: '只读，不代投放', text: '可以对照报表。不改出价，不改预算，也不代替客户投放。', panel: 'adsFlow' as PanelKey },
    ],
  },
]

export const reasons = [
  {
    title: '产品覆盖经营主链路',
    lines: ['店铺、订单、退货、财务放在同一套方案里', '广告报表按模块另开，不默认包含', '网页查看，按书面方案开通范围'],
    num: '10',
    tip: '首页可进入的经营主题',
  },
  {
    title: '数据按公司隔开',
    lines: ['每家公司单独发起卖家授权', '广告账户再授权一次', `买家个人信息在发货完成后 ${company.piiRetentionDays} 日内删除`],
    num: `${company.piiRetentionDays}天`,
    tip: '发货后的删除期限',
  },
  {
    title: '从咨询到售后有人跟',
    lines: ['预约后核对主体、店铺和模块', '实施和更高同步频率另行计算', '登记地址在许昌，按书面方案交付'],
    num: '1',
    tip: '服务城市',
  },
]

export const marks = [
  { title: '主体隔离', text: '查询带法律主体条件' },
  { title: '权限分级', text: '读取和连接管理分开' },
  { title: '限期删除', text: `发货后 ${company.piiRetentionDays} 日内删除买家信息` },
  { title: '令牌加密', text: '刷新令牌加密保存，页面不展示' },
  { title: '广告另授权', text: '广告账户与卖家账号分开' },
  { title: '书面报价', text: '网页不标价格' },
  { title: '本地服务', text: '许昌' },
  { title: '人工回复', text: '工作日回复预约' },
]

export const press = [
  { date: '2026-10', tag: '经营', title: '多公司多店铺工作台', text: '支持在一个工作台按法律主体分层管理多家公司的店铺与站点，各公司账套清晰归属、互不混淆。' },
  { date: '2026-10', tag: '财务', title: '财务多币种对账', text: '收入、退款与费用在同一币种内核对，退款可对回原订单月份，月结更准确。' },
  { date: '2026-10', tag: '广告', title: '广告只读分析', text: '广告花费、点击与广告销售额集中查看，报表只读，不改出价、不代投放。' },
  { date: '2026-10', tag: '安全', title: '数据安全与权限分级', text: `运营、财务、广告按主体分权查看；买家个人信息在发货后约 ${company.piiRetentionDays} 天内按政策删除。` },
  { date: '2026-09', tag: '供应链', title: '采购与供应商管理', text: '支持维护供应商档案、创建并跟踪采购单，把备货与到货情况和经营数据放在一起管理。' },
  { date: '2026-09', tag: '供应链', title: '仓库与库存流水', text: '支持管理多个仓库并记录出入库与调拨流水，每一笔库存变动都有迹可循。' },
  { date: '2026-08', tag: '数据', title: '报表中心上线', text: '支持按需生成订单、库存、财务与广告报表任务，导出结果用于经营复盘与归档。' },
]

export const guides = [
  { title: '如何开始使用', text: '确认公司主体、店铺规模、需要的模块与成员权限后，团队会协助你完成连接与部署。', href: '/contact' },
  { title: '支持哪些站点和币种', text: '支持多站点、多币种，按账户币种对账，不同币种不相加。', href: '/product' },
  { title: '广告数据如何查看', text: '广告账户单独连接，花费与广告销售额只读查看，用于分析与对账。', href: '/solutions/advertising' },
  { title: '数据安全与保护', text: '数据加密传输与存储，权限按主体分级，买家信息按政策定期删除。', href: '/security' },
  { title: '企业联系信息', text: '运营主体为 ' + company.legalName + '，地址和邮箱以关于页为准。', href: '/about' },
]
