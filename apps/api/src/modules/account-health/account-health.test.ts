import { ACCOUNT_HEALTH_ROLE_GUIDE, type AccountHealthSync } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { issueRow, pageOf, decodeOffset, worstSync, type IssueRecord } from './account-health-common'
import { buildStoreView, type SnapshotRecord, type StoreViewInput } from './account-health-view'

// 账户健康视图装配（P5-02）：纯函数。数据读取、写入、数据范围与跨企业隔离见 testing/account-health.db.test.ts（真实数据库）。

const day = (text: string) => new Date(`${text}T00:00:00Z`)
const sync = (over: Partial<AccountHealthSync> = {}): AccountHealthSync => ({
  status: 'NORMAL',
  statusLabel: '正常',
  lastSuccessAt: '2026-10-24T01:00:00.000Z',
  errorCode: null,
  errorMessage: null,
  rolePending: false,
  ...over,
})
const row = (over: Partial<SnapshotRecord> & { metricKey: string; snapshotDate: Date }): SnapshotRecord => ({
  metricGroup: 'OTHER',
  accountStatus: 'NORMAL',
  status: 'UNKNOWN',
  value: null,
  target: null,
  targetCondition: null,
  unit: null,
  windowDays: null,
  detailJson: {},
  source: 'REPORT',
  ...over,
})
const input = (over: Partial<StoreViewInput> = {}): StoreViewInput => ({
  store: { id: 's1', name: '一店' },
  connected: true,
  sync: sync(),
  history: [],
  latest: [],
  latestDate: null,
  openByKind: [],
  ...over,
})

describe('buildStoreView：没有数据时的三种说法', () => {
  it('没有授权、缺少角色、同步失败、已接入但还没同步：状态与文案各不相同，都不写 0 或“正常”', () => {
    expect(buildStoreView(input({ connected: false }))).toMatchObject({ state: 'NOT_CONNECTED', accountStatus: { status: null, label: null }, rating: null })
    const role = buildStoreView(input({ sync: sync({ rolePending: true, status: 'FAILED' }) }))
    expect(role).toMatchObject({ state: 'ROLE_PENDING', note: ACCOUNT_HEALTH_ROLE_GUIDE })
    expect(buildStoreView(input({ sync: sync({ status: 'FAILED', errorMessage: '授权过期' }) }))).toMatchObject({ state: 'NO_DATA', note: '授权过期' })
    const waiting = buildStoreView(input())
    expect(waiting.state).toBe('NO_DATA')
    expect(waiting.note).toContain('还没有同步到')
    expect(waiting.orderDefect.breakdown.every(item => item.metric === null && item.note === '报告未分项给出')).toBe(true)
  })

  it('有数据（哪怕只有政策问题）就是 OK，不再显示没数据的说明', () => {
    expect(buildStoreView(input({ openByKind: [{ kind: 'LISTING_POLICY', count: 2 }] }))).toMatchObject({ state: 'OK', note: null, policy: { openCount: 2 } })
  })
})

describe('buildStoreView：有数据', () => {
  const history = [
    row({ metricKey: 'ACCOUNT_STATUS', metricGroup: 'STATUS', accountStatus: 'NORMAL', snapshotDate: day('2026-10-22') }),
    row({ metricKey: 'ACCOUNT_STATUS', metricGroup: 'STATUS', accountStatus: 'AT_RISK', snapshotDate: day('2026-10-23'), source: 'PUSH' }),
    row({ metricKey: 'ACCOUNT_STATUS', metricGroup: 'STATUS', accountStatus: 'AT_RISK', snapshotDate: day('2026-10-24') }),
    row({ metricKey: 'ACCOUNT_HEALTH_RATING', metricGroup: 'RATING', value: 250, snapshotDate: day('2026-10-23'), detailJson: { ratingStatus: 'FAIR' } }),
    row({ metricKey: 'ACCOUNT_HEALTH_RATING', metricGroup: 'RATING', value: 312, snapshotDate: day('2026-10-24'), detailJson: { ratingStatus: 'GOOD' } }),
    row({ metricKey: 'orderDefectRate.afn', metricGroup: 'ORDER_DEFECT', value: 0.02, unit: 'RATIO', snapshotDate: day('2026-10-24') }),
    row({ metricKey: 'orderDefectRate.afn', metricGroup: 'ORDER_DEFECT', value: 0.01, unit: 'RATIO', snapshotDate: day('2026-10-23') }),
  ]
  const latest = [
    row({
      metricKey: 'orderDefectRate.afn',
      metricGroup: 'ORDER_DEFECT',
      value: 0.02,
      target: 0.01,
      targetCondition: 'LT',
      status: 'NOT_MET',
      unit: 'RATIO',
      windowDays: 60,
      snapshotDate: day('2026-10-24'),
    }),
    row({ metricKey: 'negativeFeedbackRate', metricGroup: 'ORDER_DEFECT', value: 0.004, unit: 'RATIO', snapshotDate: day('2026-10-24') }),
    row({ metricKey: 'listingPolicyViolations', metricGroup: 'POLICY', value: 3, unit: 'COUNT', snapshotDate: day('2026-10-24') }),
    row({ metricKey: 'lateShipmentRate', metricGroup: 'OTHER', value: 0.05, unit: 'RATIO', snapshotDate: day('2026-10-24') }),
    row({ metricKey: 'ACCOUNT_STATUS', metricGroup: 'STATUS', snapshotDate: day('2026-10-24') }),
  ]
  const view = buildStoreView(
    input({
      history,
      latest,
      latestDate: '2026-10-24',
      openByKind: [
        { kind: 'IP_COMPLAINT', count: 1 },
        { kind: 'BRAND_NEW', count: 2 },
        { kind: 'OTHER', count: 1 },
      ],
    }),
  )

  it('账户状态：最后一次变化的前后状态与日期、来源；状态历史只含变化点', () => {
    expect(view.state).toBe('OK')
    expect(view.accountStatus).toMatchObject({ status: 'AT_RISK', label: '有风险', asOf: '2026-10-24', source: 'REPORT', previousStatus: 'NORMAL', changedAt: '2026-10-23' })
    expect(view.statusHistory.map(item => [item.date, item.status])).toEqual([
      ['2026-10-22', 'NORMAL'],
      ['2026-10-23', 'AT_RISK'],
    ])
    expect(view.snapshotDate).toBe('2026-10-24')
  })

  it('评级取最近一份并带趋势（日期升序）', () => {
    expect(view.rating).toEqual({ score: 312, status: 'GOOD', statusLabel: '良好' })
    expect(view.ratingTrend.map(point => point.date)).toEqual(['2026-10-23', '2026-10-24'])
  })

  it('订单缺陷率：总率进趋势，构成项归位，没分项给的写“报告未分项给出”，总率本身在指标列表里（带目标与达标判定）', () => {
    expect(view.orderDefect.breakdown.map(item => [item.key, item.metric?.key ?? null])).toEqual([
      ['NEGATIVE_FEEDBACK', 'negativeFeedbackRate'],
      ['CLAIMS', null],
      ['CHARGEBACK', null],
    ])
    expect(view.orderDefect.metrics.map(metric => metric.key)).toEqual(['orderDefectRate.afn'])
    expect(view.orderDefect.metrics[0]).toMatchObject({ status: 'NOT_MET', statusLabel: '未达标', targetText: '低于 1%', value: 0.02, unit: 'RATIO', windowDays: 60 })
    expect(view.orderDefect.trend).toHaveLength(1)
    expect(view.orderDefect.trend[0]?.points).toEqual([
      { date: '2026-10-23', value: 0.01 },
      { date: '2026-10-24', value: 0.02 },
    ])
  })

  it('政策：指标按键排序，未登记的问题类型并入“其他”；其他指标保留报告原名；状态与评级行不进指标列表', () => {
    expect(view.policy.metrics.map(metric => metric.key)).toEqual(['listingPolicyViolations'])
    expect(view.policy.openCount).toBe(4)
    expect(view.policy.openByKind.map(item => [item.kind, item.count])).toEqual([
      ['IP_COMPLAINT', 1],
      ['OTHER', 3],
    ])
    expect(view.other.map(metric => metric.key)).toEqual(['lateShipmentRate'])
  })
})

describe('公共工具', () => {
  const record = (over: Partial<IssueRecord> = {}): IssueRecord => ({
    id: 'i1',
    issueId: 'V-1',
    sellerAccountId: 's1',
    kind: 'WHATEVER',
    title: '标题',
    status: 'OPEN',
    firstSeenAt: new Date('2026-10-20T00:00:00Z'),
    lastSeenAt: new Date('2026-10-24T00:00:00Z'),
    resolvedAt: null,
    affectedAsinsJson: ['B000000001', 3, null],
    impactText: null,
    handlingStatus: 'IN_PROGRESS',
    handlingNote: null,
    ownerUserId: 'u1',
    amazonCaseId: null,
    version: 3,
    ...over,
  })

  it('政策问题行：未登记的类型归“其他”，ASIN 只留字符串；负责人已离开（查不到名字）时不显示负责人', () => {
    const view = issueRow(record(), '一店', '小王')
    expect(view).toMatchObject({ kind: 'OTHER', kindLabel: '其他', asins: ['B000000001'], handlingStatusLabel: '处理中', owner: { id: 'u1', name: '小王' }, version: 3 })
    expect(issueRow(record(), '一店', null).owner).toBeNull()
    expect(issueRow(record({ ownerUserId: null }), '一店', '小王').owner).toBeNull()
    expect(issueRow(record({ status: 'RESOLVED', resolvedAt: new Date('2026-10-25T00:00:00Z') }), '一店', null)).toMatchObject({ status: 'RESOLVED', resolvedAt: '2026-10-25T00:00:00.000Z' })
  })

  it('偏移游标：签名并绑定查询条件，换了条件不能用；最后一页没有下一页', () => {
    const items = Array.from({ length: 5 }, (_, index) => index)
    const first = pageOf(items, 0, 2, 'a')
    expect(first.page).toEqual([0, 1])
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 5 })
    const next = first.pageInfo.nextCursor as string
    expect(decodeOffset(next, 'a')).toBe(2)
    expect(() => decodeOffset(next, 'b')).toThrow(/游标/)
    expect(decodeOffset(undefined, 'a')).toBe(0)
    expect(pageOf(items, 4, 2, 'a').pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('多店铺同步状态取最差的；没有店铺记录是“尚无记录”', () => {
    expect(worstSync([sync(), sync({ status: 'FAILED' }), sync({ status: 'DELAYED' })]).status).toBe('FAILED')
    expect(worstSync([]).status).toBe('NO_RECORD')
  })
})
