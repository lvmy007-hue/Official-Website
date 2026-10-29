import type { ReportCatalogEntry, ReportDomain, ReportMode, ReportPeriod, ReportSource } from './report-center'

// 报表中心目录（P5-03）：每一种能创建、检索或登记的报告与数据集一行。类型与标签在 report-center.ts。

const AF = 'Amazon Fulfillment'
const PRICING = 'Pricing'
const IOT = 'Inventory and Order Tracking'
const FIN = 'Finance and Accounting'
const BRAND = 'Brand Analytics'
const PLISTING = 'Product Listing'
const D2C = 'Direct to Consumer Shipping（受限角色）'
const TAXR = 'Tax Remittance（受限角色）'
const NEED_BRAND = '；需要品牌备案'

type Spec = [key: string, importer: string, label: string, period: ReportPeriod, roles: string[], path: string | null, mode?: ReportMode, extra?: string]
const sp = (domain: ReportDomain, [key, importer, label, period, roles, path, mode = 'CREATE', extra = '']: Spec): ReportCatalogEntry => ({
  key,
  source: 'SP_API',
  domain,
  label,
  mode,
  period,
  importer,
  requirement: `所需角色：${roles.join('、')}${extra}`,
  analysisPath: path,
  createPath: null,
})

const LOGISTICS: Spec[] = [
  ['GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 'R-03', '亚马逊物流发货报告', 'RANGE', [AF, IOT, PRICING], '/app/orders'],
  ['GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA', 'R-05', '替换订单报告', 'RANGE', [AF], '/app/orders'],
  ['GET_FBA_INVENTORY_PLANNING_DATA', 'R-08', '库存规划报告', 'SNAPSHOT', [AF], '/app/inventory'],
  ['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'R-09', '库存报告（未抑制）', 'SNAPSHOT', [AF, PRICING], '/app/inventory'],
  ['GET_FBA_MYI_ALL_INVENTORY_DATA', 'R-10', '库存报告（全部）', 'SNAPSHOT', [AF, PRICING], '/app/inventory'],
  ['GET_AFN_INVENTORY_DATA', 'R-11', '亚马逊物流库存报告', 'SNAPSHOT', [AF], '/app/inventory'],
  ['GET_LEDGER_DETAIL_VIEW_DATA', 'R-12', '库存台账明细', 'RANGE', [AF], '/app/inventory/ledger'],
  ['GET_LEDGER_SUMMARY_VIEW_DATA', 'R-13', '库存台账汇总', 'RANGE', [AF], '/app/inventory/ledger'],
  ['GET_RESERVED_INVENTORY_DATA', 'R-14', '预留库存报告', 'SNAPSHOT', [AF, PRICING], '/app/inventory'],
  ['GET_STRANDED_INVENTORY_UI_DATA', 'R-15', '滞留库存报告', 'SNAPSHOT', [AF, PRICING], '/app/inventory'],
  ['GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT', 'R-16', '官方补货建议', 'SNAPSHOT', [AF, PRICING], '/app/replenishment'],
  ['GET_FBA_RECOMMENDED_REMOVAL_DATA', 'R-17', '推荐移除报告', 'SNAPSHOT', [AF, PRICING], '/app/inventory/removals'],
  ['GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA', 'R-18', '移除订单明细', 'RANGE', [AF, PRICING], '/app/inventory/removals'],
  ['GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA', 'R-19', '移除货件明细', 'RANGE', [AF, PRICING], '/app/inventory/removals'],
  ['GET_FBA_STORAGE_FEE_CHARGES_DATA', 'R-20', '月度仓储费', 'RANGE', [AF, PRICING], '/app/inventory/capacity'],
  ['GET_FBA_OVERAGE_FEE_CHARGES_DATA', 'R-21', '超限费', 'SNAPSHOT', [AF], '/app/inventory/capacity'],
  ['GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA', 'R-22', '长期仓储费', 'SNAPSHOT', [AF, PRICING], '/app/inventory/capacity'],
  ['GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA', 'R-25', '入仓不合规报告', 'RANGE', [AF, PRICING], '/app/supply-chain'],
  ['GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', 'R-26', '客户退货报告', 'RANGE', [AF, PRICING], '/app/returns'],
]

const BUSINESS: Spec[] = [
  ['GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', 'R-01', '订单报告（按下单日期）', 'RANGE', [AF, D2C, IOT, PRICING], '/app/orders'],
  ['GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL', 'R-02', '订单报告（按更新时间）', 'RANGE', [AF, D2C, IOT, PRICING, PLISTING], '/app/orders'],
  ['GET_MERCHANT_LISTINGS_ALL_DATA', 'R-29', '全部商品报告', 'SNAPSHOT', [D2C, IOT, PRICING, PLISTING], '/app/products'],
  ['GET_MERCHANTS_LISTINGS_FYP_REPORT', 'R-32', '被搜索抑制报告', 'SNAPSHOT', [PLISTING], '/app/listings/quality'],
  ['GET_SALES_AND_TRAFFIC_REPORT', 'R-34', '销售与流量报告（补充）', 'RANGE', [BRAND], '/app/analytics/business-reports', 'CREATE', NEED_BRAND],
  ['GET_PROMOTION_PERFORMANCE_REPORT', 'R-40', '促销绩效报告', 'RANGE', [BRAND, 'Selling Partner Insights'], '/app/promotions'],
  ['GET_COUPON_PERFORMANCE_REPORT', 'R-41', '优惠券绩效报告', 'RANGE', [BRAND], '/app/promotions'],
  ['GET_V2_SELLER_PERFORMANCE_REPORT', 'R-42', '卖家表现报告（账户健康）', 'SNAPSHOT', ['Selling Partner Insights'], '/app/account-health'],
]

const BRAND_SPECS: Spec[] = [
  ['GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', 'R-35', '品牌分析·搜索查询表现', 'BA_PERIOD', [BRAND], '/app/analytics/brand/search-query', 'CREATE', NEED_BRAND],
  ['GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT', 'R-36', '品牌分析·目录表现', 'BA_PERIOD', [BRAND], '/app/analytics/brand/catalog-performance', 'CREATE', NEED_BRAND],
  ['GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', 'R-37', '品牌分析·热门搜索词', 'BA_PERIOD', [BRAND], '/app/analytics/brand/search-terms', 'CREATE', NEED_BRAND],
  ['GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT', 'R-38', '品牌分析·购物篮分析', 'BA_PERIOD', [BRAND], '/app/analytics/brand/market-basket', 'CREATE', NEED_BRAND],
  ['GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT', 'R-39', '品牌分析·重复购买', 'BA_PERIOD', [BRAND], '/app/analytics/brand/repeat-purchase', 'CREATE', NEED_BRAND],
]

const FINANCE_SPECS: Spec[] = [
  ['GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA', 'R-23', '预估配送费报告', 'SNAPSHOT', [AF, PRICING], '/app/finance/fee-audit'],
  ['GET_REFERRAL_FEE_PREVIEW_REPORT', 'R-24', '佣金预览报告', 'SNAPSHOT', [FIN], '/app/finance/fee-audit'],
  ['GET_FBA_REIMBURSEMENTS_DATA', 'R-27', '官方赔付明细报告', 'RANGE', [AF, PRICING], '/app/reimbursements'],
  ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'R-28', '结算报告', 'SNAPSHOT', [FIN], '/app/settlements', 'RETRIEVE', '；结算期结束后由亚马逊生成，系统每日检索，不能主动申请'],
  ['GET_FLAT_FILE_SALES_TAX_DATA', 'R-33', '销售税报告', 'SNAPSHOT', [TAXR], '/app/finance/sales-tax', 'RETRIEVE', '；需先在卖家后台税务文档库生成，系统每日检索，不能主动申请'],
]

const ADS_TEMPLATES: Array<[key: string, label: string]> = [
  ['CAMPAIGN_DAILY', '广告·活动日报'],
  ['AD_GROUP_DAILY', '广告·广告组日报'],
  ['TARGET_DAILY', '广告·投放对象日报'],
  ['SEARCH_TERM_DAILY', '广告·搜索词日报'],
  ['ADVERTISED_PRODUCT_DAILY', '广告·广告商品日报'],
  ['PLACEMENT_DAILY', '广告·广告位日报'],
  ['CAMPAIGN_HOURLY', '广告·活动小时报'],
  ['CONVERTED_PRODUCT_DAILY', '广告·转化商品日报'],
]

const INSIGHTS = 'Selling Partner Insights'
const KIOSK_DATASETS: Array<[key: string, importer: string, label: string, path: string | null, role: string, extra: string]> = [
  ['dk.economics', 'D-04', '官方单品经济（按天、按 SKU）', '/app/finance/economics', INSIGHTS, ''],
  ['dk.economics-preview', 'D-05', '官方费用预览（未来 120 天）', '/app/finance/economics', INSIGHTS, ''],
  ['dk.economics-simulation', 'D-06', '上游仓储与经济情景模拟', '/app/replenishment', INSIGHTS, '；按需单次查询，不留存'],
  ['dk.sales-traffic-by-date', 'D-01', '销售与流量（按日期）', '/app/analytics/business-reports', BRAND, NEED_BRAND],
  ['dk.sales-traffic-by-asin', 'D-02', '销售与流量（按 ASIN）', '/app/analytics/business-reports', BRAND, NEED_BRAND],
  ['dk.sales-traffic-trends', 'D-03', '销售与流量（ASIN 趋势）', '/app/analytics/business-reports', BRAND, NEED_BRAND],
]

export const REPORT_CATALOG: readonly ReportCatalogEntry[] = [
  ...LOGISTICS.map(spec => sp('LOGISTICS', spec)),
  ...BUSINESS.map(spec => sp('BUSINESS', spec)),
  ...BRAND_SPECS.map(spec => sp('BRAND', spec)),
  ...FINANCE_SPECS.map(spec => sp('FINANCE', spec)),
  ...ADS_TEMPLATES.map(([key, label]): ReportCatalogEntry => ({
    key,
    source: 'ADS',
    domain: 'ADS',
    label,
    mode: 'LINKED',
    period: 'RANGE',
    importer: 'A-02',
    requirement: '需要先完成亚马逊广告授权，并且广告档案已发现统一接口的广告账户编号',
    analysisPath: '/app/advertising/metrics',
    createPath: '/app/advertising/reports',
  })),
  ...KIOSK_DATASETS.map(([key, importer, label, path, role, extra]): ReportCatalogEntry => ({
    key,
    source: 'DATA_KIOSK',
    domain: 'DATA_CENTER',
    label,
    mode: 'SYSTEM',
    period: 'RANGE',
    importer,
    requirement: `所需角色：${role}${extra}`,
    analysisPath: path,
    createPath: null,
  })),
]

export const reportCatalogOf = (source: ReportSource, key: string | null | undefined): ReportCatalogEntry | undefined => REPORT_CATALOG.find(item => item.source === source && item.key === key)
/** SP-API 报告类型 → 目录项（未登记返回 undefined）。 */
export const spReportOf = (reportType: string | null | undefined) => reportCatalogOf('SP_API', reportType)
/** 报表中心里能创建的 SP-API 报告类型。 */
export const CREATABLE_REPORT_TYPES: readonly string[] = REPORT_CATALOG.filter(item => item.source === 'SP_API' && item.mode === 'CREATE').map(item => item.key)
/** 某业务域里的 SP-API 报告类型（列表按域筛选用）。 */
export const reportTypesOfDomain = (domain: ReportDomain): string[] => REPORT_CATALOG.filter(item => item.source === 'SP_API' && item.domain === domain).map(item => item.key)
