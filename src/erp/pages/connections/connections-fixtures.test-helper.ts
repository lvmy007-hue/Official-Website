import {
  evaluateRoleModules,
  evaluateRoles,
  ROLE_COMPARISON_BASIS,
  type AdsAccountBindingList,
  type AdsAccountBindingRow,
  type ConnectionCenterResponse,
  type ConnectionRow,
} from '@nova/api-contracts'

// 连接中心广告账户绑定页测试用的接口返回样例（只在测试里使用）。

export const STORES: AdsAccountBindingList['stores'] = [
  { id: 's1', displayName: '美国主店', sellerId: 'SELLER-A', logicalRegion: 'NA' },
  { id: 's2', displayName: '美国二店', sellerId: 'SELLER-B', logicalRegion: 'NA' },
]

export const row = (over: Partial<AdsAccountBindingRow> = {}): AdsAccountBindingRow => ({
  id: 'ap-1',
  profileId: 'P-1',
  displayName: '美国广告账户',
  countryCode: 'US',
  marketplaceId: 'ATVPDKIKX0DER',
  currency: 'USD',
  status: 'ACTIVE',
  accountId: 'SELLER-A',
  adsAccountId: null,
  bindingStatus: 'UNBOUND',
  bindingStatusLabel: '未绑定',
  store: null,
  boundBy: null,
  unboundReason: 'MULTIPLE_STORES',
  unboundReasonText: '企业里有多个卖家编号相同的店铺，系统不猜测；请人工指定店铺。',
  candidateCount: 2,
  updatedAt: '2026-10-23T08:00:00.000Z',
  ...over,
})

export const autoRow = (over: Partial<AdsAccountBindingRow> = {}): AdsAccountBindingRow =>
  row({
    id: 'ap-2',
    profileId: 'P-2',
    displayName: '自动匹配的账户',
    adsAccountId: 'amzn1.ads-account.g.abc',
    bindingStatus: 'AUTO_MATCHED',
    bindingStatusLabel: '已自动匹配',
    store: { id: 's1', displayName: '美国主店', sellerId: 'SELLER-A' },
    unboundReason: null,
    unboundReasonText: null,
    candidateCount: 1,
    ...over,
  })

export const manualRow = (over: Partial<AdsAccountBindingRow> = {}): AdsAccountBindingRow =>
  row({
    id: 'ap-3',
    profileId: 'P-3',
    displayName: '人工绑定的账户',
    accountId: null,
    bindingStatus: 'MANUAL',
    bindingStatusLabel: '人工绑定',
    store: { id: 's2', displayName: '美国二店', sellerId: 'SELLER-B' },
    boundBy: '管理员小李',
    unboundReason: null,
    unboundReasonText: null,
    candidateCount: 0,
    ...over,
  })

export const bindingList = (over: Partial<AdsAccountBindingList> = {}): AdsAccountBindingList => {
  const items = over.items ?? [row(), autoRow(), manualRow()]
  const count = (status: string) => items.filter(item => item.bindingStatus === status).length
  return {
    items,
    summary: { total: items.length, autoMatched: count('AUTO_MATCHED'), manual: count('MANUAL'), unbound: count('UNBOUND') },
    stores: STORES,
    canBind: true,
    bindBlockedReason: null,
    truncated: false,
    ...over,
  }
}

// ---- 连接中心（P5-04） ----

const HEALTH_AT = '2026-10-25T01:00:00.000Z'

export const sellerRow = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: 'conn-1',
  kind: 'SELLER',
  kindLabel: '卖家接口',
  connectionId: 'conn-1',
  provider: 'AMAZON_SP_API',
  state: 'AUTHORIZED',
  stateLabel: '已授权',
  tone: 'success',
  subject: '星河贸易有限公司',
  authorizedBy: '管理员小李',
  accountLabel: '卖家编号 SELLER-A',
  accountId: 'SELLER-A',
  storeId: 's1',
  storeName: '美国主店',
  scopes: ['美国站（ATVPDKIKX0DER）', '卖家接口'],
  hasToken: true,
  health: {
    status: 'HEALTHY',
    statusLabel: '正常',
    checkedAt: HEALTH_AT,
    checks: [
      { key: 'token', label: '换取访问令牌', ok: true, message: null },
      { key: 'api', label: '调用卖家接口', ok: true, message: null },
      { key: 'marketplace', label: '参与美国站', ok: true, message: null },
    ],
  },
  lastSuccessAt: '2026-10-25T00:30:00.000Z',
  failureCode: null,
  failureText: null,
  tokenUpdatedAt: '2026-09-01T00:00:00.000Z',
  tokenExpiry: { state: 'NOT_ESTIMATED', expiresAt: null, daysLeft: null, basis: '亚马逊没有公布固定的授权有效期，默认不推算' },
  detail: null,
  actions: { healthCheck: { allowed: true, reason: null }, reauthorize: { allowed: true, reason: null }, disconnect: { allowed: true, reason: null } },
  ...over,
})

export const adsConnRow = (over: Partial<ConnectionRow> = {}): ConnectionRow =>
  sellerRow({
    id: 'conn-ads',
    kind: 'ADS',
    kindLabel: '广告接口',
    connectionId: 'conn-ads',
    provider: 'AMAZON_ADS_API',
    subject: null,
    accountLabel: '广告账户（3 个档案）',
    accountId: null,
    storeId: null,
    storeName: null,
    scopes: ['advertising::campaign_management'],
    health: null,
    lastSuccessAt: null,
    ...over,
  })

export const derivedRow = (kind: 'REPORT_ROLE' | 'BRAND_ANALYTICS', over: Partial<ConnectionRow> = {}): ConnectionRow =>
  sellerRow({
    id: `${kind}:s1`,
    kind,
    kindLabel: kind === 'REPORT_ROLE' ? '报告权限' : '品牌分析资格',
    connectionId: null,
    provider: null,
    state: 'AVAILABLE',
    stateLabel: '已具备',
    subject: null,
    authorizedBy: null,
    scopes: [],
    hasToken: false,
    health: null,
    tokenUpdatedAt: null,
    tokenExpiry: null,
    detail: '8 项报告：7 项可取，1 项缺少角色',
    actions: null,
    ...over,
  })

/** 一家店铺在各来源上的新鲜度记录：订单可取、卖家支持缺角色。 */
const evidence = [
  { sellerAccountId: 's1', sourceKey: 'orders.api', status: 'NORMAL', lastSuccessAt: '2026-10-25T00:30:00.000Z', lastErrorCode: null },
  { sellerAccountId: 's1', sourceKey: 'support.api', status: 'UNAUTHORIZED', lastSuccessAt: null, lastErrorCode: 'SUP_ROLE_PENDING' },
]

export const roleData = (stores: string[] = ['s1']) => {
  const modules = evaluateRoleModules(stores, stores.length ? evidence : [])
  return { roles: evaluateRoles(modules), modules, basis: ROLE_COMPARISON_BASIS, storeCount: stores.length }
}

export const centerList = (over: Partial<ConnectionCenterResponse> = {}): ConnectionCenterResponse => {
  const items = over.items ?? [
    sellerRow(),
    adsConnRow(),
    derivedRow('REPORT_ROLE'),
    derivedRow('BRAND_ANALYTICS', { state: 'NOT_APPLICABLE', stateLabel: '不适用（无品牌备案）', tone: 'default', detail: null }),
  ]
  const count = (kind: string) => items.filter(item => item.kind === kind).length
  return {
    items,
    summary: {
      total: items.length,
      byKind: { SELLER: count('SELLER'), ADS: count('ADS'), REPORT_ROLE: count('REPORT_ROLE'), BRAND_ANALYTICS: count('BRAND_ANALYTICS') },
      authorized: items.filter(item => item.connectionId && item.state === 'AUTHORIZED').length,
      attention: items.filter(item => item.tone === 'error' || item.tone === 'warning').length,
    },
    roles: roleData(),
    legalEntities: [{ id: 'le1', name: '星河贸易有限公司' }],
    canManage: true,
    manageBlockedReason: null,
    truncated: false,
    ...over,
  }
}
