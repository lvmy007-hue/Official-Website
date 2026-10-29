// 广告账户与店铺绑定（P3-03，09 章 9.6、11 章 11.1；只有常量、类型与纯函数，没有 zod，请求体校验在 ads-binding-query.ts）。
// 规则：广告账户里的卖家编号与店铺的卖家编号一致，且同一企业内只有唯一一个候选店铺时自动绑定；其余情况保持未绑定，由有 ads.account.bind 权限的人手工绑定。
// 广告数据通过“广告账户绑定的店铺”参与数据范围过滤：未绑定的广告账户只有“全部店铺”范围的成员能看到。

/** 人工绑定与解除绑定需要的权限（只有企业所有者与管理员有）。 */
export const ADS_ACCOUNT_BIND = 'ads.account.bind'
/** 读取绑定清单需要的权限（连接中心的只读权限）。 */
export const ADS_BINDING_READ = 'connection.read'

export const ADS_BINDING_STATUSES = ['AUTO_MATCHED', 'MANUAL', 'UNBOUND'] as const
export type AdsBindingStatus = (typeof ADS_BINDING_STATUSES)[number]
export const ADS_BINDING_STATUS_LABEL: Record<AdsBindingStatus, string> = {
  AUTO_MATCHED: '已自动匹配',
  MANUAL: '人工绑定',
  UNBOUND: '未绑定',
}

/** 改绑与解除绑定会改变谁能看到这个广告账户的数据，必须写原因。 */
export const ADS_BINDING_REASON_MIN = 2
export const ADS_BINDING_REASON_MAX = 300
/** 一个企业最多列出的广告账户数（超过时只列前面的并标记 truncated）。 */
export const ADS_BINDING_LIST_LIMIT = 500
/** 候选店铺最多列出的数量（绑定弹窗的下拉）。 */
export const ADS_BINDING_STORE_LIMIT = 200

/** 为什么还没有绑定：页面据此告诉人下一步怎么做，不让人猜。 */
export const ADS_UNBOUND_REASONS = ['NO_SELLER_ID', 'NO_MATCHING_STORE', 'MULTIPLE_STORES', 'RELEASED'] as const
export type AdsUnboundReason = (typeof ADS_UNBOUND_REASONS)[number]
export const ADS_UNBOUND_REASON_TEXT: Record<AdsUnboundReason, string> = {
  NO_SELLER_ID: '广告接口没有返回卖家编号，无法自动匹配；请人工指定店铺。',
  NO_MATCHING_STORE: '企业里没有卖家编号相同的店铺，无法自动匹配；请先连接对应店铺，或人工指定店铺。',
  MULTIPLE_STORES: '企业里有多个卖家编号相同的店铺，系统不猜测；请人工指定店铺。',
  RELEASED: '原来绑定的店铺已被移除；请人工指定新的店铺。',
}

/** 未绑定的原因。已有绑定店铺时返回 null；候选数是“企业内卖家编号与广告账户卖家编号相同的店铺数”。 */
export function unboundReasonOf(input: { sellerAccountId: string | null; bindingStatus: string; accountId: string | null; candidateCount: number }): AdsUnboundReason | null {
  if (input.sellerAccountId) return null
  if (input.bindingStatus === 'MANUAL') return 'RELEASED'
  if (!input.accountId) return 'NO_SELLER_ID'
  if (input.candidateCount === 0) return 'NO_MATCHING_STORE'
  return 'MULTIPLE_STORES'
}

/** 一次绑定操作的性质：NONE 没有变化；PIN 把自动匹配的结果固定为人工绑定（以后自动匹配不再改动它）。 */
export type AdsBindingChange = 'BIND' | 'REBIND' | 'UNBIND' | 'PIN' | 'NONE'
export const ADS_BINDING_CHANGE_LABEL: Record<AdsBindingChange, string> = {
  BIND: '已绑定店铺',
  REBIND: '已改绑店铺',
  UNBIND: '已解除绑定',
  PIN: '已固定为人工绑定',
  NONE: '没有变化',
}

export function bindingChangeOf(current: { sellerAccountId: string | null; bindingStatus: string }, nextSellerAccountId: string | null): AdsBindingChange {
  if (nextSellerAccountId === null) {
    // 没有绑定店铺时，状态应当是未绑定；店铺被移除后会留下“人工绑定但没有店铺”的状态，解除一次就恢复成未绑定
    if (current.sellerAccountId === null) return current.bindingStatus === 'UNBOUND' ? 'NONE' : 'UNBIND'
    return 'UNBIND'
  }
  if (current.sellerAccountId === null) return 'BIND'
  if (current.sellerAccountId !== nextSellerAccountId) return 'REBIND'
  return current.bindingStatus === 'MANUAL' ? 'NONE' : 'PIN'
}

/** 改绑与解除绑定要写原因；第一次绑定与固定自动匹配的结果不要求。 */
export const bindingReasonRequired = (change: AdsBindingChange) => change === 'REBIND' || change === 'UNBIND'

/** 绑定店铺的站点与广告账户的站点不一致时给出的提醒（只提醒，不阻止：站点信息来自两边各自的接口）。 */
export function marketplaceWarning(adsMarketplaceId: string, storeMarketplaceIds: unknown, storeName: string): string | null {
  if (!Array.isArray(storeMarketplaceIds) || storeMarketplaceIds.length === 0) return null
  return storeMarketplaceIds.includes(adsMarketplaceId) ? null : `店铺“${storeName}”的站点里没有这个广告账户的站点（${adsMarketplaceId}），请确认没有绑错。`
}

export type AdsBindingStore = { id: string; displayName: string; sellerId: string; logicalRegion: string }

export type AdsAccountBindingRow = {
  /** 广告档案编号（`AdsProfile.id`），绑定接口路径里的 :id。 */
  id: string
  profileId: string
  displayName: string
  countryCode: string
  marketplaceId: string
  currency: string
  status: string
  /** 广告接口返回的卖家编号，没有时为 null。 */
  accountId: string | null
  /** 统一接口的全球广告账户编号，没发现时为 null（页面写“未发现广告账户”）。 */
  adsAccountId: string | null
  bindingStatus: AdsBindingStatus
  bindingStatusLabel: string
  store: { id: string; displayName: string; sellerId: string } | null
  boundBy: string | null
  unboundReason: AdsUnboundReason | null
  unboundReasonText: string | null
  /** 企业里卖家编号与广告账户卖家编号相同的店铺数。 */
  candidateCount: number
  updatedAt: string
}

export type AdsAccountBindingList = {
  items: AdsAccountBindingRow[]
  summary: { total: number; autoMatched: number; manual: number; unbound: number }
  /** 可供选择的店铺（成员数据范围内）；只有能绑定的人才返回。 */
  stores: AdsBindingStore[]
  canBind: boolean
  /** 不能绑定时的原因（没有权限，或数据范围不是“全部店铺”）。 */
  bindBlockedReason: string | null
  truncated: boolean
}

export type AdsAccountBindResult = {
  id: string
  change: AdsBindingChange
  changeLabel: string
  changed: boolean
  bindingStatus: AdsBindingStatus
  sellerAccountId: string | null
  warnings: string[]
}
