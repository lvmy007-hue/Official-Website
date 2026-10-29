// 数据域到后台任务类型的映射。后台任务进程按这些类型分派处理。
export type SyncDomain =
  'ORDERS' | 'INVENTORY' | 'FINANCE' | 'FINANCES' | 'INBOUND' | 'RETURNS' | 'ADS' | 'REPLENISHMENT' | 'AWD' | 'CATALOG' | 'SUPPORT' | 'SETTLEMENT' | 'TAX' | 'PROMOTIONS' | 'LISTINGS' | string

export function providerOf(domain: SyncDomain) {
  return domain === 'ADS' ? ('AMAZON_ADS_API' as const) : ('AMAZON_SP_API' as const)
}

export function apiDomainLabel(provider: ReturnType<typeof providerOf>) {
  return provider === 'AMAZON_ADS_API' ? 'Amazon Ads API' : 'Amazon SP-API'
}

// 返回后台任务类型；该数据域需要走报告任务或尚未实现时返回 null。
export function workerTypeOf(domain: SyncDomain): string | null {
  switch (domain) {
    case 'ORDERS':
      return 'FBA_ORDERS'
    case 'INVENTORY':
      return 'FBA_INVENTORY'
    case 'FINANCE':
    case 'FINANCES':
      return 'FBA_FINANCE'
    case 'INBOUND':
      return 'FBA_INBOUND_SYNC'
    case 'ADS':
      return 'FBA_ADS'
    case 'REPLENISHMENT':
      return 'FBA_REPLENISHMENT'
    case 'AWD':
      return 'AWD_SYNC'
    case 'CATALOG':
      return 'CATALOG_SYNC'
    case 'SUPPORT':
      return 'SUPPORT_SYNC'
    case 'SETTLEMENT':
      return 'SETTLEMENT_SYNC'
    case 'TAX':
      return 'TAX_SYNC'
    case 'PROMOTIONS':
      return 'PROMOTIONS_SYNC'
    case 'LISTINGS':
      return 'LISTING_SYNC'
    default:
      return null
  }
}
