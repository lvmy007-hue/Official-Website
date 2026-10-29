import { adFaqs, pricingFaqs, pricingScenarios, productAreas, serviceNature } from './public-product-content'
import { adsApiUseEn, company, spApiRoles } from './site-company'
import { cases, commercial, cores, featureChapters, marks, offers, offices, press, reasons } from './site-commercial'
import * as english from './site-en'
import { enMeta, type EnglishPage } from './site-en'

export const SITE_ORIGIN = 'https://dzanx.com'

export type ChinesePage = 'home' | 'product' | 'product-stores' | 'product-orders' | 'product-returns' | 'product-finance' | 'product-advertising' | 'product-permissions' | 'product-inventory' | 'product-listings' | 'product-inbound' | 'solutions' | 'solutions-advertising' | 'pricing' | 'about' | 'news' | 'resources' | 'contact' | 'privacy' | 'terms' | 'security' | 'not-found'
export type PublicPage = ChinesePage | EnglishPage

export function isEnglishPage(page: PublicPage): page is EnglishPage {
  return page.startsWith('en-')
}

export const englishAlternates: Partial<Record<ChinesePage, EnglishPage>> = {
  home: 'en-home', product: 'en-product',
  'product-stores': 'en-product-stores', 'product-orders': 'en-product-orders', 'product-returns': 'en-product-returns',
  'product-finance': 'en-product-finance', 'product-advertising': 'en-product-advertising', 'product-permissions': 'en-product-permissions',
  'product-inventory': 'en-product-inventory', 'product-listings': 'en-product-listings', 'product-inbound': 'en-product-inbound',
  solutions: 'en-solutions', 'solutions-advertising': 'en-solutions-advertising',
  pricing: 'en-pricing', about: 'en-about', news: 'en-news', resources: 'en-resources',
  contact: 'en-contact', privacy: 'en-privacy', terms: 'en-terms', security: 'en-security',
}

export function alternatesFor(page: PublicPage): { zh?: string; en?: string } {
  if (page === 'not-found') return {}
  if (isEnglishPage(page)) {
    const chinese = (Object.keys(englishAlternates) as ChinesePage[]).find(key => englishAlternates[key] === page)
    return { en: pageMeta[page].canonical, zh: chinese ? pageMeta[chinese].canonical : undefined }
  }
  const english = englishAlternates[page]
  return { zh: pageMeta[page].canonical, en: english ? pageMeta[english].canonical : undefined }
}

const englishMeta = Object.fromEntries(Object.entries(enMeta).map(([key, value]) => [key, { title: value.title, description: value.description, canonical: `${SITE_ORIGIN}${value.path}` }])) as Record<EnglishPage, { title: string; description: string; canonical: string }>

export const pageMeta: Record<PublicPage, { title: string; description: string; canonical: string }> = {
  ...englishMeta,
  home: {
    title: 'NOVA ERP｜多家公司与多店铺经营数据工作台',
    description: `NOVA ERP 由${company.legalName}提供，用于多家公司、多店铺的订单、退货、财务和广告报表，各公司数据清晰归属。`,
    canonical: `${SITE_ORIGIN}/`,
  },
  product: {
    title: '产品能力｜NOVA ERP',
    description: 'NOVA ERP 覆盖多店铺、订单、退货、财务、库存、广告报表和成员权限，集中在一个工作台管理。',
    canonical: `${SITE_ORIGIN}/product`,
  },
  'product-stores': {
    title: '多店铺管理｜NOVA ERP',
    description: '在一个工作台按法律主体分层管理多公司的店铺与站点，各公司数据清晰归属、互不混淆。',
    canonical: `${SITE_ORIGIN}/product/stores`,
  },
  'product-orders': {
    title: '订单数据｜NOVA ERP',
    description: '订单按店铺归集，保留购买时间、状态与币种，便于核对。公开页只使用示意数据。',
    canonical: `${SITE_ORIGIN}/product/orders`,
  },
  'product-returns': {
    title: '跨月退货｜NOVA ERP',
    description: '区分当月退款和跨月退款。退款记录不等于实物退货，月份矩阵为演示数据。',
    canonical: `${SITE_ORIGIN}/product/returns`,
  },
  'product-finance': {
    title: '财务结算｜NOVA ERP',
    description: '订单、退款和费用按币种分列，不同币种不相加，月结更准确。',
    canonical: `${SITE_ORIGIN}/product/finance`,
  },
  'product-advertising': {
    title: '广告分析｜NOVA ERP',
    description: '广告账户单独连接，花费、点击与广告销售额只读查看，用于分析与对账。',
    canonical: `${SITE_ORIGIN}/product/advertising`,
  },
  'product-permissions': {
    title: '成员权限｜NOVA ERP',
    description: '成员按角色分权查看订单、财务与广告，职责清晰、责任可追溯。',
    canonical: `${SITE_ORIGIN}/product/permissions`,
  },
  'product-inventory': {
    title: 'FBA 库存｜NOVA ERP',
    description: '按卖家账号与站点查看可售、预留、在途和不可售库存，可售天数与补货线一屏可见。',
    canonical: `${SITE_ORIGIN}/product/inventory`,
  },
  'product-listings': {
    title: '商品刊登｜NOVA ERP',
    description: 'ASIN、SKU、FNSKU 与刊登状态用于店铺与商品对照，让订单与库存统计更准确。',
    canonical: `${SITE_ORIGIN}/product/listings`,
  },
  'product-inbound': {
    title: 'FBA 入库｜NOVA ERP',
    description: '按卖家账号创建和查看 FBA 入库计划、货件与接收数量，补货进度随时可查。',
    canonical: `${SITE_ORIGIN}/product/inbound`,
  },
  solutions: {
    title: '解决方案｜NOVA ERP',
    description: '单公司、多公司和只看广告三种方案，以及每种方案包含的模块。',
    canonical: `${SITE_ORIGIN}/solutions`,
  },
  'solutions-advertising': {
    title: '广告数据方案｜NOVA ERP',
    description: '多广告账户集中分析，指标清晰、报表只读。NOVA ERP 提供广告报表分析，不提供人工代运营。',
    canonical: `${SITE_ORIGIN}/solutions/advertising`,
  },
  pricing: {
    title: '方案报价｜NOVA ERP',
    description: '单公司起步、多公司和超出范围三档方案，以及模块对照。开通以书面方案为准，网页不收款。',
    canonical: `${SITE_ORIGIN}/pricing`,
  },
  about: {
    title: '关于我们｜NOVA ERP',
    description: `${company.legalName}运营 NOVA ERP，为跨境团队提供多店铺订单、财务和广告报表。`,
    canonical: `${SITE_ORIGIN}/about`,
  },
  news: {
    title: '产品动态｜NOVA ERP',
    description: 'NOVA ERP 的功能更新与重要节点记录。',
    canonical: `${SITE_ORIGIN}/news`,
  },
  resources: {
    title: '资源｜NOVA ERP',
    description: 'NOVA ERP 的产品指南与常见问题，帮助你快速了解并开始使用。',
    canonical: `${SITE_ORIGIN}/resources`,
  },
  contact: {
    title: '预约产品演示｜NOVA ERP',
    description: '提交企业名称、邮箱和需求说明，我们会在工作日尽快以邮件回复，协助你预约演示与获取方案。',
    canonical: `${SITE_ORIGIN}/contact`,
  },
  privacy: {
    title: '隐私政策｜NOVA ERP',
    description: `说明${company.legalName}如何收集、使用、存储、保护和删除卖家数据、广告数据与咨询信息。`,
    canonical: `${SITE_ORIGIN}/privacy`,
  },
  terms: {
    title: '服务条款｜NOVA ERP',
    description: `${company.legalName}提供 NOVA ERP 的服务范围、授权、费用和联系方式。`,
    canonical: `${SITE_ORIGIN}/terms`,
  },
  security: {
    title: '安全说明｜NOVA ERP',
    description: '传输加密、凭据加密、成员权限、数据隔离与删除策略，保障经营数据安全可控。',
    canonical: `${SITE_ORIGIN}/security`,
  },
  'not-found': {
    title: '页面不存在｜NOVA ERP',
    description: '该地址没有对应的公开页面。',
    canonical: `${SITE_ORIGIN}/`,
  },
}

export function websitePageFromPath(path: string): PublicPage | null {
  if (path === '/' || path === '/site') return 'home'
  const match = (Object.keys(pageMeta) as PublicPage[]).find(page => page !== 'home' && page !== 'not-found' && pageMeta[page].canonical === `${SITE_ORIGIN}${path}`)
  return match ?? null
}

export function publicDocumentPaths() {
  const paths = new Set<string>(['/', '/site', '/login'])
  for (const page of Object.keys(pageMeta) as PublicPage[]) {
    if (page === 'home' || page === 'not-found') continue
    paths.add(new URL(pageMeta[page].canonical).pathname)
  }
  return paths
}

export const navProduct = productAreas.map(area => ({ href: area.href, label: area.title, text: area.claim }))

export const navSolutions = [
  { href: '/solutions#single', label: '单公司', text: '1 个法律主体，1 到 5 个店铺。' },
  { href: '/solutions#multi', label: '多公司', text: '多家公司分开对账，再放在一起查。' },
  { href: '/solutions/advertising', label: '广告报表', text: '广告账户单独连接，只读。' },
]

export const homeHero = {
  eyebrow: company.legalName,
  title: commercial.headline,
  lede: commercial.lede,
  primary: { href: '/contact', label: '预约演示' },
  secondary: { href: '/pricing', label: '查看服务范围' },
  notes: ['多法人授权边界', '分级成员权限', '可追溯数据更新时间'],
  noteDetail: '法律主体、卖家账号和数据按公司清晰归属；成员按角色分权查看。数据会记录更新时间，确保可追溯。',
}

export const painPoints = [
  { no: '01', title: '主体分散：账号与法律公司归属不清', text: '多个公司各自持有卖家账号时，店铺和站点容易对不上法律主体。授权一旦混在同一登录里，就很难说明谁可以看哪一家公司的数据。' },
  { no: '02', title: '经营复杂：订单、退款与财务口径难统一', text: '当月退款可能对应以前月份的订单。若把退款、平台费用和结算放在不同表格里，收入和净额就无法按同一口径核对。' },
  { no: '03', title: '广告割裂：多个广告账户难形成统一分析', text: '广告账户要单独授权，不能默认等于卖家账号。账户未授权时，不应把花费、销售额或 ACOS 显示成已经同步的结果。' },
]

export const capabilities = [
  { no: '01', href: '/product/stores', title: '法律主体与店铺', text: '登记公司、卖家账号、站点和授权状态，只对已授权主体开放数据。' },
  { no: '02', href: '/product/orders', title: '订单数据', text: '按店铺查看订单，并保留来源更新时间。未授权时不展示同步完成。' },
  { no: '03', href: '/product/returns', title: '跨月退货', text: '把退款记到原订单月份。退款记录不等于实物已经退回仓库。' },
  { no: '04', href: '/product/stores', title: '库存视图', text: '库存快照挂在已授权的卖家账号下。公开页只说明口径，不展示真实库存。' },
  { no: '05', href: '/product/finance', title: '财务结算', text: '订单收入、退款、费用和净额按同一币种排列，不同币种不相加。' },
  { no: '06', href: '/product/advertising', title: '广告分析', text: '广告账户单独授权后，查看花费、点击、ACOS 和 ROAS。默认只读。' },
]

export const storeDemoRows = [
  ['演示公司甲', '演示店铺 A', 'Amazon.com', '未授权', '—'],
  ['演示公司乙', '演示店铺 B', 'Amazon.co.jp', '等待平台审批', '—'],
  ['演示公司丙', '演示店铺 C', 'Amazon.de', '授权异常', '—'],
]

export const returnMatrix = {
  orderMonths: ['2026-07', '2026-08', '2026-09'],
  refundMonths: ['2026-08', '2026-09', '2026-10'],
  counts: [
    [3, 1, 0],
    [0, 4, 2],
    [0, 0, 1],
  ],
}

export const financeDemoRows = [
  ['2026-09', '演示店铺 A', 'USD', '1,000.00', '80.00', '120.00', '800.00'],
  ['2026-09', '演示店铺 C', 'EUR', '500.00', '20.00', '40.00', '440.00'],
]

export const adMetrics = [
  ['花费', '200.00'],
  ['点击', '140'],
  ['ACOS', '23.5%'],
  ['ROAS', '4.26'],
]

export const adStatus = '广告账户需单独授权'

export const steps = [
  { no: '01', title: '创建企业组织', text: '管理员在企业账户内建立企业空间，成员通过邀请进入，而不是共用一个登录。' },
  { no: '02', title: '添加店铺连接', text: '先登记法律主体，再关联卖家账号和站点。未登记的公司不会出现在数据范围里。' },
  { no: '03', title: '授权数据访问', text: '卖家授权和广告授权分开完成。未授权的公司不会出现在可查看的数据里。' },
  { no: '04', title: '查看统计报表', text: '报表只反映已经写入的授权数据。真实数据需要登录既有企业账号，需要登录既有企业账号。' },
]

export const securityItems = [
  { title: '成员与角色管理', text: '服务端按成员所属企业账户和角色权限判断能否访问。权限区分订单、财务、广告、成员和连接管理。' },
  { title: '各公司数据隔离', text: '法律主体、卖家账号和订单查询都带企业账户标识。一个账号不能因为登录成功就读取其他企业的数据。' },
  { title: '授权撤销', text: '卖家可在卖家平台收回授权。收回后停止继续读取该主体数据，买家个人信息按保留期限删除。' },
  { title: '数据保留删除', text: `订单中的买家个人信息在相关订单发货完成后 ${company.piiRetentionDays} 日内删除，不做离线备份。` },
  { title: '审计记录', text: '接口侧有审计事件模型，用于记录操作者、对象和结果。公开页面不展示任何真实审计内容。' },
]

export const scenarios = [
  { title: '三家公司放在一起查', text: '每家公司单独授权。未审批的连接停在等待，不显示成已同步。', href: '/solutions' },
  { title: '退货对回下单的月份', text: '本月入账的退款保留退货日期和原订单号。', href: '/product/returns' },
  { title: '财务只在同一币种里算净额', text: '费用事件有入账时间。页面没有自动汇率。', href: '/product/finance' },
  { title: '广告报表单独授权', text: '花费、点击、广告销售额按广告授权读取。不改出价，不做代运营。', href: '/solutions/advertising' },
  { title: '成员看不到全部公司', text: '运营、财务、广告使用不同权限。没有成员关系时接口拒绝。', href: '/product/permissions' },
]

export const homeFaq = [
  { q: '是否必须拥有亚马逊店铺才能了解产品？', a: '不必须。可以先阅读公开说明并提交演示预约。要查看某一家店铺的经营数据，需要该店铺所属法律主体完成相应授权。' },
  { q: '多个公司能否分别授权？', a: '可以按法律主体分别登记和授权。未授权的公司不会被当作开发方自己的店铺，也不会显示同步成功。' },
  { q: '广告数据需要单独授权吗？', a: '需要。广告授权与卖家授权分开完成。未授权的广告账户不会出现在报表中。' },
  { q: '能否只查看经营数据而不开放修改权限？', a: '服务端有独立的只读权限。只读账号不应通过接口修改连接。公开页面不能代替你们管理员对具体角色的配置结果。' },
  { q: '没有授权时能否查看演示？', a: '可以。首页的店铺表、退款矩阵、收支表和产品示意都标有“演示数据”或“示意数据”，不代表任何真实店铺。' },
  { q: '如何撤销授权？', a: '卖家可以在卖家平台收回对应用的授权，广告账户在广告平台收回。收回后停止读取该主体的新数据，买家个人信息按保留期限删除。' },
  { q: '如何确认接入范围？', a: '按法律主体、店铺规模、席位、数据模块和同步范围确认。未授权的公司不会进入可查看范围。' },
  { q: '如何联系支持团队？', a: `可发送邮件到 ${company.email}，也可以使用网站表单。` },
]

export const legalBanner = `版本日期 ${company.privacyVersion}。运营主体：${company.legalName}。统一社会信用代码：${company.creditCode}。联系：${company.email}。`

export const privacySections = [
  { h: '数据控制与联系', p: `${company.legalName}运营 NOVA ERP，处理本网站、卖家数据和广告数据。统一社会信用代码：${company.creditCode}。地址：${company.address}。隐私问题请发送至 ${company.email}。` },
  { h: '收集的数据', p: '咨询表单收集姓名、公司名称、企业邮箱、咨询类型、留言，以及选填的电话和店铺数量。卖家授权后读取订单、库存、退货、费用和商品信息。广告账户另行授权后读取广告账户和报表。请不要在表单中填写 Amazon 密码或令牌。' },
  { h: '使用目的', p: '咨询信息用于回复演示和开通问题。卖家数据用于已授权公司的订单、库存、退货和财务查看。广告数据用于已授权账户的报表分析。这些数据不出售给第三方。' },
  { h: '授权依据', p: '卖家数据以该法律主体发起的卖家授权为依据。广告数据以广告账户持有人的另一次授权为依据。未授权的公司或广告账户不会进入可查看范围。' },
  { h: '存储地区', p: `业务数据存储在${company.storageRegion}。访问使用 HTTPS。刷新令牌在服务端以 AES-256-GCM 加密保存，页面不回传令牌原文。` },
  { h: '处理者类别', p: `我们使用部署在${company.storageRegion}的云数据库保存业务与咨询记录，使用任务队列执行数据同步，并使用邮件服务发送通知。这些服务商仅按我们的指令处理数据，不得用于其他目的。` },
  { h: '数据共享', p: '不出售卖家数据、广告数据或咨询信息。除云数据库和任务队列这些按指令处理数据的服务商外，不向其他公司提供这些数据。法律法规或有权机关要求提供时，只提供被要求的范围。卖家可发邮件到 ' + company.email + ' 要求访问、更正或删除本人相关的咨询信息；买家个人信息按保留期限删除。' },
  { h: '访问控制与保护', p: '成员必须属于对应企业账户并具备相应权限，才能读取订单、财务或广告。不同法律主体的数据按企业账户隔离。' },
  { h: '保留与删除', p: `订单中的买家姓名、地址、电话和邮箱，在相关订单发货完成后 ${company.piiRetentionDays} 日内删除，不做离线备份。授权撤销后停止继续读取，并按同一期限删除已保存的买家个人信息。咨询记录在完成回复后保留 24 个月。` },
  { h: '数据主体权利', p: `访问、更正和删除请求请发送至 ${company.email}。我们在 15 个工作日内回复。` },
  { h: '安全事件通知', p: `我们按安全说明中的措施保护数据。如发生涉及个人信息的安全事件，会在确认后按法律法规要求的时限，通过邮件等方式通知受影响的卖家，并在需要时向主管部门报告。安全问题可发送至 ${company.email}。` },
  { h: '政策更新与跨境', p: '政策更新时修改版本日期。向中国境外传输卖家数据时，只在授权和法律要求的范围内进行，并使用加密通道。' },
]

export const termsSections = [
  { h: '运营主体与服务范围', p: `${company.legalName}提供 NOVA ERP，包括多店铺订单、库存、退货、财务查看，以及广告账户授权后的报表分析。不提供人工广告代运营。` },
  { h: '账号与授权', p: '工作台账号由企业管理员配置。连接 Amazon 数据前，需要相应法律主体自行完成授权。用户应保证自己有权代表该公司授权。' },
  { h: '用户责任', p: '不要把其他公司的卖家账号、密码或令牌交给本网站。咨询内容应限于业务范围和联系方式。' },
  { h: '费用与退款', p: '价格页列出各档方案包含的模块。开通和付款以书面方案为准，不在网页收款。发票和退款按书面方案执行。' },
  { h: '第三方平台', p: '订单、结算和广告数据是否可读，取决于 Amazon 接口资格、授权范围和接口本身的限制。平台调整接口时，相应报表可能不可用。' },
  { h: '数据保护与安全', p: '我们按隐私政策和安全说明处理与保护数据，包括加密传输、凭据与敏感字段加密、权限隔离与限期删除。具体安全措施以安全说明页为准；如需报告安全问题，可通过安全说明页列出的邮箱联系。' },
  { h: '知识产权', p: '网站文案和界面用于说明 NOVA ERP。Amazon 及相关名称属于其权利人，本站不以这些标识表示获得认可。' },
  { h: '暂停与终止', p: '在滥用接口、无法确认授权主体或合同终止时，企业管理员可以停止成员访问。具体终止条件以合同为准。' },
  { h: '争议解决与联系', p: `本条款适用中华人民共和国法律。争议由${company.disputeVenue}管辖。联系邮箱 ${company.email}。` },
]

export const securitySections = [
  { h: '数据范围与用途', p: '卖家完成授权后，NOVA ERP 只读读取已授权店铺的订单、库存、退货、费用结算与商品信息；广告账户另行授权后只读读取广告活动与报表。数据仅用于授权公司自己的经营查看与对账，不出售、不用于约定以外的用途，也不代客户修改店铺或广告设置。' },
  { h: '传输与边界', p: 'dzanx.com 与工作台接口全程通过 HTTPS 提供访问。公网接口设有请求频率限制与访问控制，用于抵御异常请求与暴力尝试。' },
  { h: '凭据加密', p: 'Amazon 刷新令牌使用 AES-256-GCM 加密后保存。加密密钥未配置时，服务端拒绝保存，不改存明文。页面不展示令牌。' },
  { h: '存储与隔离', p: `业务数据存储在${company.storageRegion}，买家个人信息等敏感字段加密保存。法律主体、连接、订单和报表查询都按企业账户隔离，没有成员关系时系统拒绝访问。` },
  { h: '访问控制', p: '成员必须属于目标企业账户。订单、退款、财务、广告、导出、成员和连接管理使用分开的权限。' },
  { h: '登录与会话保护', p: '登录刷新凭证只保存摘要。访问凭证约 15 分钟更新一次，连续 15 分钟没有操作会话失效、需要重新登录；连续 10 次登录失败，账号锁定 30 分钟。管理员可以随时停止成员访问。' },
  { h: '日志与审计', p: '登录、授权和数据读取会记录操作者、动作、对象和结果，用于安全核查与事件追溯。' },
  { h: '漏洞与变更管理', p: '对依赖和接口定期进行安全检查，发现问题按风险级别修复；上线变更经过评审后再发布。' },
  { h: '安全事件响应', p: `发现疑似数据安全事件时，可发送邮件至 ${company.email} 联系安全责任人。我们会在确认后按法律法规要求的时限处置，并在需要时通知受影响方与主管部门。` },
  { h: '备份与删除', p: `买家个人信息在业务数据库中于发货完成后 ${company.piiRetentionDays} 日内删除，工作台不再查询；授权撤销后停止继续读取并按同一期限删除。故障恢复备份只用于恢复系统，不作为日常查询来源。` },
  { h: '安全问题联系', p: `请将安全问题发送至 ${company.email}，不要附带令牌或客户订单信息。` },
]

export function collectStrings(value: unknown, output: string[] = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output))
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collectStrings(item, output))
  return output
}

export function publicEnglishText() {
  return collectStrings({ english, company, roles: spApiRoles.map(role => [role.code, role.useEn]), adsApiUseEn }).join('\n')
}

export function publicCopyText() {
  return collectStrings({
    pageMeta, homeHero, painPoints, capabilities, storeDemoRows, financeDemoRows, adMetrics, adStatus, steps, securityItems, scenarios, homeFaq, legalBanner, privacySections, termsSections, securitySections, productAreas, adFaqs, pricingFaqs, pricingScenarios, serviceNature, company, spApiRoles, commercial, offers, cases, offices, press, cores, featureChapters, reasons, marks,
  }).join('\n')
}
