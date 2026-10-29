import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

// 广告写入接口（P3-17）：权限先于参数、对象范围、动作守卫（连接与开关）、整批全有或全无、入队与登记流程、预览不写任何东西。
// 真实数据库里的范围与约束见 testing/ads-write.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const stamp = new Date('2026-10-24T08:00:00Z')
const PROFILE = { adsAccountId: 'acct-1', sellerAccountId: 's1' }
const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  adsProfileId: 'p1',
  externalCampaignId: 'EXT-C1',
  name: '活动一',
  state: 'ENABLED',
  budget: { toString: () => '20.000000' },
  bidStrategy: 'SALES_DOWN_ONLY',
  adsProfile: PROFILE,
  ...over,
})
const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  adsProfileId: 'p1',
  adGroupId: 'EXT-G1',
  campaignId: 'EXT-C1',
  name: '广告组一',
  state: 'ENABLED',
  defaultBid: { toString: () => '0.800000' },
  adsProfile: PROFILE,
  ...over,
})
const target = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  adsProfileId: 'p1',
  targetId: 'EXT-T1',
  adGroupId: 'EXT-G1',
  expression: 'yoga mat',
  bid: { toString: () => '1.200000' },
  state: 'ENABLED',
  adsProfile: PROFILE,
  ...over,
})

const ALL = ['ads.read', 'ads.campaign.write', 'ads.budget.write', 'ads.bid.write', 'ads.placement.write', 'ads.negative.write', 'ads.keyword.write']

/** 写入通道全部通畅的替身：对象在范围内、授权连接可用、开关已开；各用例按需覆盖。 */
function stubs(permissions: string[], over: Record<string, any> = {}) {
  let runNo = 0
  return prismaFor(permissions, {
    adsCampaign: { findMany: vi.fn().mockResolvedValue([campaign()]) },
    adsAdGroup: { findMany: vi.fn().mockResolvedValue([group()]) },
    adsTarget: { findMany: vi.fn().mockResolvedValue([target()]) },
    adsKeyword: { findMany: vi.fn().mockResolvedValue([]) },
    adsForecastRun: { findFirst: vi.fn().mockResolvedValue(null) },
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', sellerAccountId: null, healthChecks: [], lastErrorCode: null }) },
    integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) },
    adsWriteRun: {
      create: vi.fn().mockImplementation(async () => ({ id: `run-${++runNo}` })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map(id => ({
          id,
          kind: 'CAMPAIGN_BUDGET',
          source: 'MANUAL',
          entityType: 'CAMPAIGN',
          entityId: 'c1',
          entityLabel: '活动一',
          beforeValue: '20',
          afterValue: '30',
          status: 'PENDING',
          failureCode: null,
          requestedBy: 'user-1',
          createdAt: stamp,
          finishedAt: null,
        })),
      ),
    },
    syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-1', priority: 5 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    ...over,
  })
}

const op = (over: Record<string, unknown> = {}) => ({ kind: 'CAMPAIGN_BUDGET', entityId: 'c1', amount: 30, ...over })

describe('广告写入接口：权限先于参数', () => {
  it('未登录 401；没有 ads.read 的人调任何入口都是 403，且不碰数据库', async () => {
    const prisma = stubs([])
    harness = await createTestApp(prisma)
    const calls: Array<[string, string, unknown]> = [
      ['POST', '/ads/preview', { ops: [op()] }],
      ['GET', '/ads/writes', undefined],
      ['PATCH', '/ads/campaigns', { ops: [op()] }],
      ['PATCH', '/ads/ad-groups/g1', { kind: 'AD_GROUP_BID', amount: 1 }],
      ['PATCH', '/ads/targets/t1', { kind: 'TARGET_BID', amount: 1 }],
      ['POST', '/ads/negatives', { entityId: 'g1', level: 'AD_GROUP', text: 'x', matchType: 'NEGATIVE_EXACT' }],
      ['POST', '/ads/keywords', { entityId: 'g1', text: 'x', matchType: 'EXACT' }],
    ]
    for (const [method, path, body] of calls) {
      expect((await harness.call(method, path, { body, auth: false })).status, path).toBe(401)
      expect((await harness.call(method, path, { body })).status, path).toBe(403)
    }
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    expect(prisma.adsCampaign.findMany).not.toHaveBeenCalled()
  })

  it('每类写入各要自己的权限：只有 ads.read 不能改；只有预算权限不能改竞价；权限判断先于参数校验', async () => {
    const prisma = stubs(['ads.read', 'ads.budget.write'])
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op({ kind: 'CAMPAIGN_STATE', state: 'PAUSED', amount: undefined })] } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op(), op({ kind: 'CAMPAIGN_BID_STRATEGY', amount: undefined, strategy: 'MANUAL' })] } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/campaigns', { body: { ops: [{ kind: 'CAMPAIGN_STATE', entityId: '%%%', junk: true }] } })).status).toBe(403)
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('预览只要 ads.read；它只读，不建写入记录、不入队、不写审计；没有写权限时只是 canSubmit 为 false 并说明', async () => {
    const prisma = stubs(['ads.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ permitted: false, canSubmit: false })
    expect(res.json.data.reason).toContain('权限')
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })
})

describe('广告写入接口：参数校验', () => {
  it('有权限时不合法的内容都是 422：缺必填、超范围、未声明的字段、空批次、超过上限', async () => {
    harness = await createTestApp(stubs(ALL))
    const bad = [
      { ops: [] },
      { ops: [op({ amount: 0 })] },
      { ops: [op({ amount: 2_000_000 })] },
      { ops: [{ kind: 'CAMPAIGN_STATE', entityId: 'c1' }] },
      { ops: [op({ extra: 1 })] },
      { ops: [op({ kind: 'NOPE' })] },
      { ops: [op({ kind: 'CAMPAIGN_PLACEMENT', placement: 'TOP_OF_SEARCH', amount: 1000 })] },
      { ops: Array.from({ length: 51 }, () => op()) },
      { ops: [op({ entityId: '带空格 的' })] },
    ]
    for (const body of bad) {
      const res = await harness.call('PATCH', '/ads/campaigns', { body })
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422)
      expect(res.json.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('入口只接受自己这一层的写入类型：活动入口不能改广告组或投放对象', async () => {
    harness = await createTestApp(stubs(ALL))
    expect((await harness.call('PATCH', '/ads/campaigns', { body: { ops: [{ kind: 'AD_GROUP_BID', entityId: 'g1', amount: 1 }] } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'TARGET_BID', amount: 1 } })).status).toBe(422)
    expect((await harness.call('POST', '/ads/negatives', { body: { entityId: 'g1', level: 'AD_GROUP', text: 'x', matchType: 'EXACT' } })).status).toBe(422) // 否定只能是否定精确或否定词组
  })

  it('路径里的对象编号优先：请求体里再给一个不同的 entityId 不能改别的对象', async () => {
    const prisma = stubs(ALL, { adsAdGroup: { findMany: vi.fn().mockResolvedValue([group()]) } })
    harness = await createTestApp(prisma)
    await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'AD_GROUP_BID', amount: 1, entityId: 'other' } })
    expect(prisma.adsAdGroup.findMany.mock.calls[0][0].where.id).toEqual({ in: ['g1'] })
  })
})

describe('广告写入接口：预览', () => {
  it('每项给出修改前后、变化百分比与提醒；幅度大时提醒；开关全部开着可提交', async () => {
    harness = await createTestApp(stubs(ALL))
    const res = await harness.call('POST', '/ads/preview', { body: { ops: [op({ amount: 40 }), { kind: 'CAMPAIGN_STATE', entityId: 'c1', state: 'PAUSED' }] } })
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.items[0]).toMatchObject({ kind: 'CAMPAIGN_BUDGET', entityLabel: '活动一', before: '20', after: '40', changePercent: 100, blocker: null })
    expect(data.items[0].warnings.join('')).toContain('超过')
    expect(data.items[0].forecast).toMatchObject({ state: 'NO_DATA' })
    expect(data.items[1].warnings.join('')).toContain('暂停')
    expect(data.canSubmit).toBe(true)
    expect(data.switches.map((view: { key: string }) => view.key).sort()).toEqual(['sw.ads.budget', 'sw.ads.status'])
  })

  it('对象不存在或不在范围内：这一项有阻塞原因，整批不能提交；范围外和不存在没有区别', async () => {
    harness = await createTestApp(stubs(ALL, { adsCampaign: { findMany: vi.fn().mockResolvedValue([]) } }))
    const data = (await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })).json.data
    expect(data.items[0].blocker).toContain('不存在')
    expect(data.canSubmit).toBe(false)
    expect(data.reason).toContain('不存在')
  })

  it('与当前值相同：阻塞，提示无需修改；金额按数值比较（20 与 20.0 相同）', async () => {
    harness = await createTestApp(stubs(ALL))
    const data = (await harness.call('POST', '/ads/preview', { body: { ops: [op({ amount: 20 }), { kind: 'CAMPAIGN_STATE', entityId: 'c1', state: 'enabled'.toUpperCase() }] } })).json.data
    expect(data.items[0].blocker).toContain('相同')
    expect(data.items[1].blocker).toContain('相同')
    expect(data.canSubmit).toBe(false)
  })

  it('开关关闭：可以预览，但 canSubmit 为 false 并说明原因', async () => {
    harness = await createTestApp(stubs(ALL, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: false, autoDisabledReason: '连续失败' }) } }))
    const data = (await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })).json.data
    expect(data.canSubmit).toBe(false)
    expect(data.switches[0]).toMatchObject({ enabled: false })
    expect(data.reason).toBeTruthy()
  })

  it('没有授权连接：不能提交，原因写明；广告档案没有账户编号：阻塞', async () => {
    harness = await createTestApp(stubs(ALL, { platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } }))
    const noConnection = (await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })).json.data
    expect(noConnection.canSubmit).toBe(false)
    expect(noConnection.reason).toContain('授权')
    await harness.close()
    harness = await createTestApp(stubs(ALL, { adsCampaign: { findMany: vi.fn().mockResolvedValue([campaign({ adsProfile: { adsAccountId: null, sellerAccountId: 's1' } })]) } }))
    const noAccount = (await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })).json.data
    expect(noAccount.items[0].blocker).toContain('广告账户编号')
  })

  it('改预算时，已有针对这个预算的官方预测记录就说明；没有就写原因，不编造数字', async () => {
    harness = await createTestApp(stubs(ALL, { adsForecastRun: { findFirst: vi.fn().mockResolvedValue({ requestedAt: stamp }) } }))
    const item = (await harness.call('POST', '/ads/preview', { body: { ops: [op()] } })).json.data.items[0]
    expect(item.forecast).toMatchObject({ state: 'OK', low: null, high: null })
  })
})

describe('广告写入接口：提交', () => {
  it('通过后：写入记录与同步任务同一事务，提交后才登记流程并入队；响应是排队状态', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op()] } })
    expect(res.status).toBe(200)
    expect(res.json.data.state).toBe('QUEUED')
    expect(res.json.data.runs[0]).toMatchObject({ status: 'PENDING', kindLabel: '修改活动日预算' })
    const run = prisma.adsWriteRun.create.mock.calls[0][0].data
    expect(run).toMatchObject({
      tenantId: 'tenant-1',
      adsProfileId: 'p1',
      kind: 'CAMPAIGN_BUDGET',
      source: 'MANUAL',
      entityId: 'c1',
      externalId: 'EXT-C1',
      beforeValue: '20',
      afterValue: '30',
      status: 'PENDING',
      requestedBy: 'user-1',
    })
    expect(run.requestJson).toMatchObject({ amount: 30 })
    expect(prisma.syncJob.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', connectionId: 'conn-1', type: 'ADS_WRITE', context: { adsWriteRunId: 'run-1' } })
    expect(prisma.auditEvent.create.mock.calls.some((call: any[]) => call[0].data.action === 'ADS_WRITE_SUBMITTED')).toBe(true)
    expect(harness.workflow.registerWriteRun).toHaveBeenCalledTimes(1)
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ adsWriteRunId: 'run-1', syncJobId: 'job-1' }), 'job-1', expect.objectContaining({ type: 'ADS_WRITE' }))
  })

  it('批量：每一项一条写入记录一个任务；一项对象不存在整批都不受理（全有或全无）', async () => {
    const prisma = stubs(ALL, { adsCampaign: { findMany: vi.fn().mockResolvedValue([campaign(), campaign({ id: 'c2', externalCampaignId: 'EXT-C2', name: '活动二' })]) } })
    harness = await createTestApp(prisma)
    const ok = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op(), op({ entityId: 'c2', amount: 25 })] } })
    expect(ok.status).toBe(200)
    expect(prisma.adsWriteRun.create).toHaveBeenCalledTimes(2)
    expect(harness.queue.add).toHaveBeenCalledTimes(2)
    prisma.adsWriteRun.create.mockClear()
    harness.queue.add.mockClear()
    const bad = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op(), op({ entityId: 'missing' })] } })
    expect(bad.status).toBe(404)
    expect(bad.json.error.message).toContain('第 2 项')
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('开关没开：409 WRITE_SWITCH_OFF，不建写入记录、不入队；来源不是手动时才要来源开关，手动只检查动作自己的开关', async () => {
    const switchFind = vi.fn().mockResolvedValue(null)
    const prisma = stubs(ALL, { integrationSwitch: { findFirst: switchFind } })
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op()] } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
    expect(switchFind.mock.calls.every((call: any[]) => call[0].where.switchKey === 'sw.ads.budget')).toBe(true)
  })

  it('没有授权连接：409，不建写入记录', async () => {
    const prisma = stubs(ALL, { platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op()] } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CONNECTION_UNAVAILABLE')
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('与当前值相同：422，不建写入记录；广告档案没有账户编号：409 ADS_ACCOUNT_MISSING', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op({ amount: 20 })] } })).status).toBe(422)
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    await harness.close()
    const noAccount = stubs(ALL, { adsCampaign: { findMany: vi.fn().mockResolvedValue([campaign({ adsProfile: { adsAccountId: null, sellerAccountId: 's1' } })]) } })
    harness = await createTestApp(noAccount)
    const res = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op()] } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('ADS_ACCOUNT_MISSING')
  })

  it('入队失败：这一项标为失败（可以重新提交），同步任务永久失败，不抛 500', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    harness.queue.add.mockRejectedValue(new Error('redis down'))
    const res = await harness.call('PATCH', '/ads/campaigns', { body: { ops: [op()] } })
    expect(res.status).toBe(200)
    expect(prisma.adsWriteRun.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' })
    expect(prisma.syncJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'FAILED_PERMANENT' })
  })

  it('广告组、投放对象、否定、关键词：各走自己的入口并记各自的开关', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'AD_GROUP_BID', amount: 1.5 } })).status).toBe(200)
    expect((await harness.call('PATCH', '/ads/targets/t1', { body: { kind: 'TARGET_STATE', state: 'PAUSED' } })).status).toBe(200)
    expect((await harness.call('POST', '/ads/negatives', { body: { entityId: 'g1', level: 'AD_GROUP', text: 'free', matchType: 'NEGATIVE_EXACT' } })).status).toBe(200)
    expect((await harness.call('POST', '/ads/keywords', { body: { entityId: 'g1', text: 'yoga block', matchType: 'PHRASE', amount: 0.9 } })).status).toBe(200)
    const kinds = prisma.adsWriteRun.create.mock.calls.map((call: any[]) => call[0].data.kind)
    expect(kinds).toEqual(['AD_GROUP_BID', 'TARGET_STATE', 'NEGATIVE_ADD', 'KEYWORD_ADD'])
    const negative = prisma.adsWriteRun.create.mock.calls[2][0].data
    expect(negative).toMatchObject({ entityType: 'AD_GROUP', externalId: 'EXT-G1', afterValue: 'free（NEGATIVE_EXACT）' })
    expect(negative.requestJson).toMatchObject({ campaignExternalId: 'EXT-C1', level: 'AD_GROUP', matchType: 'NEGATIVE_EXACT' })
  })

  it('投放对象可能是关键词表里的行：记下来自哪张表，回写时才改对表', async () => {
    const prisma = stubs(ALL, {
      adsTarget: { findMany: vi.fn().mockResolvedValue([]) },
      adsKeyword: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 't1', adsProfileId: 'p1', keywordId: 'EXT-K1', adGroupId: 'EXT-G1', text: 'yoga', bid: { toString: () => '1.5' }, state: 'ENABLED', adsProfile: PROFILE }]),
      },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/ads/targets/t1', { body: { kind: 'TARGET_BID', amount: 2 } })).status).toBe(200)
    expect(prisma.adsWriteRun.create.mock.calls[0][0].data).toMatchObject({ externalId: 'EXT-K1', beforeValue: '1.5' })
    expect(prisma.adsWriteRun.create.mock.calls[0][0].data.requestJson).toMatchObject({ table: 'AdsKeyword' })
  })
})

describe('广告写入接口：状态与记录', () => {
  it('每类写入给出有没有权限、开关是否开启；开关关闭给原因；记录带中文失败原因', async () => {
    const prisma = stubs(['ads.read', 'ads.budget.write'], {
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: false, autoDisabledReason: '连续失败 5 次' }) },
      adsWriteRun: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'r1',
            kind: 'CAMPAIGN_BUDGET',
            source: 'MANUAL',
            entityType: 'CAMPAIGN',
            entityId: 'c1',
            entityLabel: '活动一',
            beforeValue: '20',
            afterValue: '30',
            status: 'FAILED',
            failureCode: 'ADS_API_403',
            requestedBy: 'user-1',
            createdAt: stamp,
            finishedAt: stamp,
          },
        ]),
      },
    })
    harness = await createTestApp(prisma)
    const data = (await harness.call('GET', '/ads/writes?entityId=c1')).json.data
    expect(data.kinds).toHaveLength(10)
    expect(data.kinds.find((kind: { kind: string }) => kind.kind === 'CAMPAIGN_BUDGET')).toMatchObject({ permitted: true, switchEnabled: false })
    expect(data.kinds.find((kind: { kind: string }) => kind.kind === 'CAMPAIGN_STATE')).toMatchObject({ permitted: false })
    expect(data.runs[0]).toMatchObject({ status: 'FAILED', failureCode: 'ADS_API_403' })
    expect(data.runs[0].failureText).toContain('拒绝')
    expect(prisma.adsWriteRun.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', entityId: 'c1' })
  })

  it('对象编号格式不对：422', async () => {
    harness = await createTestApp(stubs(['ads.read']))
    expect((await harness.call('GET', '/ads/writes?entityId=a%20b')).status).toBe(422)
  })
})
