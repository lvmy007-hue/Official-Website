import { BA_REPORT_TYPES } from '@nova/api-contracts'
import type { RowsImporter } from '../inventory/registry'
import { syncCatalogPerformanceReport } from './catalog'
import { syncMarketBasketReport } from './market-basket'
import type { BrandReportOptions } from './parse'
import { syncRepeatPurchaseReport } from './repeat-purchase'
import { syncSearchQueryReport } from './search-query'
import { syncSearchTermsReport } from './search-terms'

// 品牌分析五份报告（R-35 至 R-39）的导入器注册：报告类型 → 逐个数组元素导入器。不属于本域的类型返回 null，由分发层继续匹配。

export const BRAND_REPORT_TYPES: readonly string[] = BA_REPORT_TYPES

export function brandImporterFor(reportType: string, scope: { tenantId: string; sellerAccountId: string }, options: BrandReportOptions): RowsImporter | null {
  const { tenantId, sellerAccountId } = scope
  switch (reportType) {
    case 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT':
      return (ctx, rows) => syncSearchQueryReport(ctx, rows, tenantId, sellerAccountId, options)
    case 'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT':
      return (ctx, rows) => syncCatalogPerformanceReport(ctx, rows, tenantId, sellerAccountId, options)
    case 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT':
      return (ctx, rows) => syncSearchTermsReport(ctx, rows, tenantId, sellerAccountId, options)
    case 'GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT':
      return (ctx, rows) => syncMarketBasketReport(ctx, rows, tenantId, sellerAccountId, options)
    case 'GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT':
      return (ctx, rows) => syncRepeatPurchaseReport(ctx, rows, tenantId, sellerAccountId, options)
    default:
      return null
  }
}
