import { describe, expect, it, vi } from 'vitest'
import { authExpiringEvaluator, buildAuthHits, buildSyncFailedHits, sourceLabelOf, syncFailedEvaluator, type FreshnessFailure, type LiveConnection } from './system-evaluators'
import type { AlertRuleView } from '../platform/alert-evaluate'

// 系统与账户类预警（P2a-15）：同步失败与授权失效。

const NOW = new Date('2026-10-22T08:00:00Z')
const at = (iso: string) => new Date(iso)
const failure = (over: Partial<FreshnessFailure> = {}): FreshnessFailure => ({
  sellerAccountId: 's1',
  storeName: '一店',
  sourceKey: 'orders.api',
  status: 'FAILED',
  lastErrorCode: 'REPORT_FATAL',
  lastAttemptAt: at('2026-10-22T06:00:00Z'),
  lastSuccessAt: at('2026-10-21T08:00:00Z'),
  ...over,
})
const live = (...entries: Array<[string, Date | null]>) => new Map<string, LiveConnection>(entries.map(([sellerAccountId, authorizedAt]) => [sellerAccountId, { sellerAccountId, authorizedAt }]))
const stores = new Map([
  ['s1', '一店'],
  ['s2', '二店'],
])
const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): AlertRuleView => ({
  id: 'r',
  code: 'X',
  domain: 'SYSTEM',
  name: 'n',
  severity: 'WARNING',
  cooldownMinutes: 60,
  currentVersion: 1,
  condition: { type: 't', params },
  scope,
})

describe('同步失败', () => {
  it('每个失败的来源一个命中：写明店铺、来源、失败原因与距上次成功多久', () => {
    const hits = buildSyncFailedHits([failure()], live(['s1', at('2026-01-01T00:00:00Z')]), NOW)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'DATA_SOURCE', entityId: 's1:orders.api', sellerAccountId: 's1', title: '一店「订单」同步失败' })
    expect(hits[0].suggestedAction).toContain('亚马逊报告生成失败')
    expect(hits[0].evidence).toMatchObject({ sourceKey: 'orders.api', sourceLabel: '订单', errorCode: 'REPORT_FATAL', hoursSinceSuccess: 24, lastAttemptAt: '2026-10-22T06:00:00.000Z' })
  })

  it('授权失效另有预警，不在这里重复报；店铺已解除授权的不报；失败之后重新授权过的不报', () => {
    const rows = [failure({ lastErrorCode: 'AUTH_EXPIRED', status: 'UNAUTHORIZED' }), failure({ sellerAccountId: 's2', storeName: '二店' }), failure({ sellerAccountId: 's3', storeName: '三店' })]
    const connections = live(['s1', null], ['s2', at('2026-10-22T07:00:00Z')]) // s2 在失败之后（06:00）重新授权；s3 没有在用授权
    expect(buildSyncFailedHits(rows, connections, NOW)).toEqual([])
    // 重新授权发生在失败之前：仍然有效
    expect(buildSyncFailedHits([failure({ sellerAccountId: 's2' })], live(['s2', at('2026-10-20T00:00:00Z')]), NOW)).toHaveLength(1)
  })

  it('支持案件的受限角色没批（SUP_ROLE_PENDING）是预期中的未授权，页面上有申请说明，不当作同步故障预警', () => {
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'SUP_ROLE_PENDING', status: 'UNAUTHORIZED', sourceKey: 'support.api' })], live(['s1', null]), NOW)).toEqual([])
  })

  it('客户反馈缺品牌备案或品牌分析角色（FBK_NO_BRAND_ACCESS）是预期中的未授权，页面写了原因，不当作同步故障预警', () => {
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'FBK_NO_BRAND_ACCESS', status: 'UNAUTHORIZED', sourceKey: 'feedback.api' })], live(['s1', null]), NOW)).toEqual([])
  })

  it('A+ 内容缺品牌备案或 A+ 内容角色（APL_ROLE_MISSING）是预期中的未授权，不当作同步故障预警；其他失败码照常预警', () => {
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'APL_ROLE_MISSING', status: 'UNAUTHORIZED', sourceKey: 'aplus.api' })], live(['s1', null]), NOW)).toEqual([])
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'APL_RESPONSE_UNRECOGNIZED', status: 'FAILED', sourceKey: 'aplus.api' })], live(['s1', null]), NOW)).toHaveLength(1)
  })

  it('费用预估缺定价或商品刊登角色（FEES_ROLE_PENDING）是预期中的未授权，不当作同步故障预警', () => {
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'FEES_ROLE_PENDING', status: 'UNAUTHORIZED', sourceKey: 'fees.estimate-v0' })], live(['s1', null]), NOW)).toEqual([])
  })

  it('销售税的受限角色没批（TAX_ROLE_PENDING）同样是预期中的未授权，不预警；报告没生成（TAX_NOT_GENERATED）是等待依赖，本来就不进失败预警的查询', () => {
    const pending = failure({ lastErrorCode: 'TAX_ROLE_PENDING', status: 'UNAUTHORIZED', sourceKey: 'rpt.sales-tax' })
    expect(buildSyncFailedHits([pending], live(['s1', null]), NOW)).toEqual([])
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'TAX_PARSE', status: 'FAILED', sourceKey: 'rpt.sales-tax' })], live(['s1', null]), NOW)).toHaveLength(1)
  })

  it('销售与流量没有品牌备案（DK_NO_BRAND）也是预期中的未授权，不预警', () => {
    const noBrand = failure({ lastErrorCode: 'DK_NO_BRAND', status: 'UNAUTHORIZED', sourceKey: 'dk.sales-traffic.date' })
    expect(buildSyncFailedHits([noBrand], live(['s1', null]), NOW)).toEqual([])
  })

  it('企业级来源（没有店铺）不要求授权；没有登记的来源用来源键当名字；最久没处理的排前面', () => {
    const hits = buildSyncFailedHits(
      [
        failure({ sellerAccountId: null, storeName: null, sourceKey: 'fx.daily', lastAttemptAt: at('2026-10-22T07:00:00Z'), lastSuccessAt: null }),
        failure({ lastAttemptAt: at('2026-10-21T00:00:00Z') }),
      ],
      live(['s1', null]),
      NOW,
    )
    expect(hits.map(hit => hit.entityId)).toEqual(['s1:orders.api', 'ALL:fx.daily'])
    expect(hits[1].title).toBe('企业级「fx.daily」同步失败')
    expect(hits[1].evidence).toMatchObject({ hoursSinceSuccess: null })
    expect(sourceLabelOf('rpt.inventory-planning')).toBe('库存规划报告')
    expect(sourceLabelOf('awd.api')).toBe('上游仓储（AWD）')
  })

  it('没有登记的失败码也给出通用说明', () => {
    expect(buildSyncFailedHits([failure({ lastErrorCode: 'WHATEVER' })], live(['s1', null]), NOW)[0].suggestedAction).toContain('同步失败，请稍后重试')
  })
})

describe('授权失效与即将失效', () => {
  const expired = failure({ lastErrorCode: 'AUTH_EXPIRED', status: 'UNAUTHORIZED' })
  const none = { tokenMaxAgeDays: null, warnBeforeDays: 30 }

  it('被亚马逊以授权失效拒绝的店铺，每个店铺一个命中（多个来源合并），列出受影响的数据', () => {
    const hits = buildAuthHits([expired, { ...expired, sourceKey: 'inventory.api' }], live(['s1', at('2026-01-01T00:00:00Z')]), stores, none, NOW)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'STORE', entityId: 's1', title: '一店 的亚马逊授权已失效' })
    expect(hits[0].evidence).toMatchObject({ state: 'EXPIRED', affectedSources: ['订单', '库存'] })
  })

  it('重新授权之后不再报；店铺没有在用授权也不报；默认不按授权年龄推算“即将失效”', () => {
    expect(buildAuthHits([expired], live(['s1', at('2026-10-22T07:00:00Z')]), stores, none, NOW)).toEqual([])
    expect(buildAuthHits([expired], live(), stores, none, NOW)).toEqual([])
    expect(buildAuthHits([], live(['s1', at('2025-01-01T00:00:00Z')]), stores, none, NOW)).toEqual([])
  })

  it('设置了授权最长年龄：进入提前提醒窗口的店铺报“约 N 天后失效”，已经超过的写明超期；已失效的店铺不重复', () => {
    const params = { tokenMaxAgeDays: 365, warnBeforeDays: 30 }
    // s1 授权于 2025-10-31：到期 2026-10-31，还有 9 天；s2 授权于 2025-09-01：已超 365 天
    const connections = live(['s1', at('2025-10-31T08:00:00Z')], ['s2', at('2025-09-01T00:00:00Z')], ['s3', at('2026-09-01T00:00:00Z')])
    const hits = buildAuthHits([], connections, new Map<string, string>([...stores, ['s3', '三店']]), params, NOW)
    expect(hits.map(hit => [hit.entityId, hit.title])).toEqual([
      ['s2', '二店 的亚马逊授权已超过设定的最长年龄'],
      ['s1', '一店 的亚马逊授权约 9 天后失效'],
    ])
    expect(hits[1].evidence).toMatchObject({ state: 'EXPIRING', daysLeft: 9, expiresAt: '2026-10-31T08:00:00.000Z' })
    // s1 同时已被拒绝授权：只报“已失效”这一条
    const merged = buildAuthHits([expired], live(['s1', at('2025-10-31T08:00:00Z')]), stores, params, NOW)
    expect(merged.map(hit => hit.title)).toEqual(['一店 的亚马逊授权已失效'])
  })
})

describe('评估器读取', () => {
  type Args = { where: Record<string, unknown> }
  const row = (over: Record<string, unknown> = {}) => ({
    sellerAccountId: 's1',
    sourceKey: 'orders.api',
    status: 'FAILED',
    lastErrorCode: 'REPORT_FATAL',
    lastAttemptAt: at('2026-10-22T06:00:00Z'),
    lastSuccessAt: null,
    sellerAccount: { displayName: '一店' },
    ...over,
  })
  const makeDb = (rows: unknown[]) => ({
    dataFreshness: { findMany: vi.fn(async (_args: Args) => rows) },
    platformConnection: {
      findMany: vi.fn(async (_args: Args) => [
        { sellerAccountId: 's1', refreshTokenUpdatedAt: at('2026-01-01T00:00:00Z') },
        { sellerAccountId: 's1', refreshTokenUpdatedAt: at('2026-05-01T00:00:00Z') },
        { sellerAccountId: null, refreshTokenUpdatedAt: null },
      ]),
    },
    sellerAccount: { findMany: vi.fn(async (_args: Args) => [{ id: 's1', displayName: '一店' }]) },
  })

  it('同步失败：查询带企业与失败状态；店铺范围写进查询条件', async () => {
    const db = makeDb([row()])
    const hits = await syncFailedEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({}, { sellerAccountIds: ['s1'] }), now: NOW })
    expect(hits).toHaveLength(1)
    const where = db.dataFreshness.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', sellerAccountId: { in: ['s1'] } })
    expect(where.OR).toEqual([
      { status: 'FAILED' },
      { status: 'UNAUTHORIZED', lastErrorCode: { notIn: ['AUTH_EXPIRED', 'SUP_ROLE_PENDING', 'TAX_ROLE_PENDING', 'DK_NO_BRAND', 'FBK_NO_BRAND_ACCESS', 'APL_ROLE_MISSING', 'FEES_ROLE_PENDING'] } },
    ])
    expect(db.platformConnection.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', provider: 'AMAZON_SP_API', state: 'AUTHORIZED' })
  })

  it('授权：阈值被改坏（年龄过小、非数字）按未启用或边界处理；同店铺多条连接取最近一次授权', async () => {
    const db = makeDb([row({ status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED', lastAttemptAt: at('2026-04-01T00:00:00Z') })])
    // 最近授权 5 月 1 日晚于失败（4 月 1 日）：已重新授权，不报
    expect(await authExpiringEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ tokenMaxAgeDays: 'x' }), now: NOW })).toEqual([])
    const db2 = makeDb([row({ status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED', lastAttemptAt: at('2026-10-01T00:00:00Z') })])
    const hits = await authExpiringEvaluator.evaluate({ db: db2 as never, tenantId: 't1', rule: rule({ tokenMaxAgeDays: 1 }), now: NOW })
    // 年龄下限 30 天：授权于 5 月 1 日的店铺已超 30 天；失败发生在 5 月之后，仍有效，所以是“已失效”一条
    expect(hits.map(hit => hit.title)).toEqual(['一店 的亚马逊授权已失效'])
  })
})
