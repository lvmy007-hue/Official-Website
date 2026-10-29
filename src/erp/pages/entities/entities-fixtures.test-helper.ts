import type { LegalEntityDetail, LegalEntityListResponse, LegalEntityRow } from '@nova/api-contracts'

export const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })

export const entityRow = (over: Partial<LegalEntityRow> = {}): LegalEntityRow => ({
  id: 'e1',
  name: '深圳跨境科技',
  registeredCountry: '中国',
  registrationNo: '91440300MA5XXXXXXX',
  status: 'ACTIVE',
  version: 3,
  storeCount: 2,
  adsAccountCount: 0,
  createdAt: '2026-10-01T02:00:00.000Z',
  ...over,
})

export const entityList = (over: Partial<LegalEntityListResponse> = {}): LegalEntityListResponse => ({
  items: [entityRow(), entityRow({ id: 'e2', name: '美国空壳公司', registeredCountry: '美国', registrationNo: null, status: 'INACTIVE', storeCount: 0 })],
  total: 2,
  page: 1,
  pageSize: 50,
  summary: { total: 2, active: 1, inactive: 1 },
  canWrite: true,
  writeBlockedReason: null,
  ...over,
})

export const entityDetail = (over: Partial<LegalEntityDetail> = {}): LegalEntityDetail => ({
  entity: { ...entityRow(), updatedAt: '2026-10-02T03:00:00.000Z' },
  stores: [
    { id: 's1', displayName: '主力店', sellerId: 'A1SELLER', logicalRegion: 'NA', connectionState: 'AUTHORIZED' },
    { id: 's2', displayName: '备用店', sellerId: 'A2SELLER', logicalRegion: 'EU', connectionState: null },
  ],
  storesTruncated: false,
  adsAccounts: [{ id: 'p1', displayName: '主力店广告', profileId: '1234567', countryCode: 'US', status: 'ACTIVE', bindingStatus: 'AUTO_MATCHED', storeName: '主力店' }],
  adsAccountsTruncated: false,
  members: {
    state: 'OK',
    items: [
      { membershipId: 'm1', name: '小王', email: 'wang@example.com', roleName: '运营', status: 'ACTIVE', access: 'ENTITY', storeNames: [] },
      { membershipId: 'm2', name: '小张', email: 'zhang@example.com', roleName: '运营', status: 'ACTIVE', access: 'STORES', storeNames: ['主力店'] },
    ],
    truncated: false,
  },
  changes: [
    {
      id: 'a1',
      occurredAt: '2026-10-02T03:00:00.000Z',
      actor: '管理员',
      action: 'LEGAL_ENTITY_UPDATED',
      actionLabel: '修改资料',
      reason: null,
      changes: [{ field: 'name', label: '主体名称', before: '深圳跨境', after: '深圳跨境科技' }],
    },
  ],
  canWrite: true,
  writeBlockedReason: null,
  canDeactivate: false,
  deactivateBlockedReason: '名下还有 2 个店铺，请先处理这些店铺后再停用主体',
  ...over,
})
