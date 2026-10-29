import { ADS_CHANGE_EXTERNAL_NOTE, ADS_CHANGE_WRITE_PENDING } from '@nova/api-contracts'
import type { AdsChangeCompareResponse, AdsChangeListResponse, AdsChangeRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告变更记录页测试用的假服务端数据（只在测试里使用）。

export const changeRow = (patch: Partial<AdsChangeRow> = {}): AdsChangeRow => ({
  id: 'ch-1',
  source: 'EXTERNAL',
  entityType: 'CAMPAIGN',
  entityId: 'cam-1',
  entityLabel: '春季推广',
  field: 'budget',
  fieldLabel: '日预算',
  before: '$20.00',
  after: '$25.00',
  occurredAt: '2026-10-22T09:30:00.000Z',
  sinceAt: '2026-10-22T08:00:00.000Z',
  actorName: null,
  accountName: '美国账户',
  storeName: 'Northstar US',
  writeRunId: null,
  path: '/app/advertising/campaigns/cam-1',
  ...patch,
})

/** 四条：外部改预算、手动改竞价、自动规则暂停、外部新出现（没有对象名称、没有详情页的清空值）。 */
export const sampleRows = (): AdsChangeRow[] => [
  changeRow(),
  changeRow({
    id: 'ch-2',
    source: 'MANUAL',
    entityType: 'TARGET',
    entityId: 'tg-1',
    entityLabel: 'yoga mat',
    field: 'bid',
    fieldLabel: '竞价',
    before: '$0.90',
    after: '$1.10',
    occurredAt: '2026-10-22T07:00:00.000Z',
    sinceAt: null,
    actorName: '王小明',
    path: '/app/advertising/targets/tg-1',
  }),
  changeRow({
    id: 'ch-3',
    source: 'AUTO_RULE',
    field: 'state',
    fieldLabel: '状态',
    before: '已启用',
    after: '已暂停',
    occurredAt: '2026-10-22T06:00:00.000Z',
    sinceAt: null,
    entityLabel: '夏季推广',
    entityId: 'cam-2',
  }),
  changeRow({
    id: 'ch-4',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    entityLabel: null,
    field: 'matchType',
    fieldLabel: '匹配方式',
    before: 'EXACT',
    after: null,
    occurredAt: '2026-10-21T10:00:00.000Z',
    sinceAt: '2026-10-21T09:00:00.000Z',
    path: null,
  }),
]

export const listResponse = (patch: Partial<AdsChangeListResponse> = {}): AdsChangeListResponse => {
  const items = patch.items ?? sampleRows()
  return {
    state: 'OK',
    note: null,
    period: { from: '2026-09-23', to: '2026-10-22', days: 30 },
    defaulted: true,
    items,
    counts: { MANUAL: 1, AUTO_RULE: 1, DAYPARTING: 0, EXTERNAL: 2 },
    tracking: { state: 'OK', lastSnapshotAt: '2026-10-22T10:00:00.000Z', note: '外部变更按快照对比识别，最近一次快照的时间如上' },
    write: ADS_CHANGE_WRITE_PENDING,
    externalNote: ADS_CHANGE_EXTERNAL_NOTE,
    profiles: [{ id: 'ap-a', name: '美国账户', storeName: 'Northstar US' }],
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    ...patch,
  }
}

export const compareResponse = (patch: Partial<AdsChangeCompareResponse> = {}): AdsChangeCompareResponse => ({
  change: changeRow(),
  basis: 'SNAPSHOT',
  basisNote: '对照取自该对象在变更时刻或之前的最近一份实体快照；没有被改动的字段显示快照里的值',
  fields: [
    { key: 'name', label: '名称', before: '春季推广', after: '春季推广', changed: false },
    { key: 'state', label: '状态', before: '已启用', after: '已启用', changed: false },
    { key: 'budget', label: '日预算', before: '$20.00', after: '$25.00', changed: true },
  ],
  related: [changeRow({ id: 'ch-9', field: 'state', fieldLabel: '状态', before: '已启用', after: '已暂停', occurredAt: '2026-10-21T08:00:00.000Z' })],
  ...patch,
})

export const notConnected = () =>
  listResponse({
    state: 'NOT_CONNECTED',
    note: '还没有拍过实体快照，外部变更暂时无法识别',
    items: [],
    counts: { MANUAL: 0, AUTO_RULE: 0, DAYPARTING: 0, EXTERNAL: 0 },
    tracking: { state: 'NOT_CONNECTED', lastSnapshotAt: null, note: '还没有拍过实体快照，外部变更暂时无法识别' },
  })

export const changeHandlers = (response: (url: URL) => AdsChangeListResponse, compare: (url: URL) => AdsChangeCompareResponse = () => compareResponse()): Record<string, Handler> => ({
  '/ads/changes': url => ok(response(url)),
  '/ads/writes': () => ok({ kinds: [], runs: [] }),
  '/ads/changes/ch-1/compare': url => ok(compare(url)),
  '/ads/changes/ch-4/compare': url => ok(compare(url)),
})
