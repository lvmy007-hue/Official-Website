/**
 * 对外展示的企业主体信息，必须与营业执照、Amazon 公有应用申请表、隐私政策和服务条款保持一致。
 * 不在前端配置 Application ID、Client Secret 或 Refresh Token。icpNumber 只填工信部备案系统里查到的号码，为空时页脚不显示。
 * 执照未载明对外电话，页面只展示邮箱和联系表单。
 */
export const company = {
  legalName: '许昌鸿洛商贸有限公司',
  legalNameEn: 'Xuchang Hongluo Trading Co., Ltd.',
  brand: 'NOVA ERP',
  creditCode: '91411002MACT4FT61L',
  legalRepresentative: '吕东升',
  companyType: '有限责任公司（自然人投资或控股的法人独资）',
  registeredCapital: '人民币 50 万元',
  foundedOn: '2023-08-25',
  address: '河南省许昌市魏都区解放路288号西关街道办事处院内202',
  addressEn: 'Room 202, Xiguan Subdistrict Office Compound, No. 288 Jiefang Road, Weidu District, Xuchang, Henan, China',
  legalRepresentativeEn: 'Lu Dongsheng',
  email: 'support@dzanx.com',
  phone: '',
  site: 'https://dzanx.com',
  icpNumber: '豫ICP备2026004947号',
  privacyVersion: '2026-10-19',
  storageRegion: '中国境内',
  piiRetentionDays: 30,
  disputeVenue: '许昌市魏都区人民法院',
}

export const spApiRoles = [
  { code: 'Inventory and Order Tracking', name: '库存与订单跟踪', use: '读取已授权店铺的订单、库存和退货，供经营查看。', useEn: 'Reads orders, inventory and returns of authorized stores for operational reporting.' },
  { code: 'Amazon Fulfillment', name: '亚马逊履约', use: '读取 FBA 库存、入库和退货处置，供库存与退货分析。', useEn: 'Reads FBA inventory, inbound shipments and return dispositions for inventory and returns analysis. Inbound plans are created only when the seller submits one.' },
  { code: 'Finance and Accounting', name: '财务与会计', use: '读取结算、费用和退款事件，在同一币种内核对收支。', useEn: 'Reads settlements, fees and refund events to reconcile revenue and costs within each currency.' },
  { code: 'Product Listing', name: '商品刊登', use: '读取商品、SKU 和站点刊登信息，用于店铺与商品对照。', useEn: 'Reads products, SKUs and marketplace listing status to match listings with orders and inventory. Listings are not edited.' },
]

export const adsApiUse = '在广告账户单独授权后，读取 Profile、广告活动和报表，展示花费、点击、CTR、CPC、广告销售额、ACOS 和 ROAS。默认只读，不代替客户修改竞价。'
export const adsApiUseEn = 'After the advertising account is authorized separately, NOVA ERP reads profiles, campaigns and reports to show spend, clicks, CTR, CPC, ad sales, ACOS and ROAS. Read-only: bids and budgets are not changed, and no campaigns are managed on the customer\'s behalf.'
