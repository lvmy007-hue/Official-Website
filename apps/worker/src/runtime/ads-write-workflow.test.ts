import type { AdsWriteRun, PrismaClient } from '@prisma/client'
import { NonRetryableError, type StepContext, type WriteRunIntent } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 广告写入流程（P3-17）：调用亚马逊前确认动作开关与来源开关；修改类不对账、新增类按词对账；被拒绝与请求不完整都是永久失败；
// 回写只做一次（已成功不重复写变更记录与事件）；永久失败后写入记录标为失败、只有真正调用了亚马逊的失败计入开关。

const amazon = vi.hoisted(() => ({ mutate: vi.fn(), queryPage: vi.fn() }))
vi.mock('../connectors/ads-v1-api', () => ({
  AdsV1Api: vi.fn(function () {
    return amazon
  }),
}))
vi.mock('../connectors/amazon-ads-api', () => ({ AmazonAdsApiClient: vi.fn() }))
vi.mock('@nova/tenancy', () => ({ runWithTenant: (_tenantId: string, fn: () => unknown) => fn() }))
const outcome = vi.hoisted(() => ({ recordSwitchOutcome: vi.fn(async () => ({ autoClosed: [] })) }))
vi.mock('../platform/switch-outcome', () => outcome)

import { markAdsWriteFailed, shortAdsWriteCode } from '../connectors/ads-write-dispatch'
import { createAdsWriteWorkflow, inputOfRun } from './ads-write-workflow'

beforeEach(() => {
  for (const fn of Object.values(amazon)) fn.mockReset()
  outcome.recordSwitchOutcome.mockClear()
})

const baseRun = {
  id: 'run-1',
  tenantId: 't1',
  adsProfileId: 'p1',
  kind: 'CAMPAIGN_BUDGET',
  source: 'MANUAL',
  entityType: 'CAMPAIGN',
  entityId: 'c1',
  externalId: 'EXT-C1',
  entityLabel: '活动一',
  requestJson: { amount: 30, campaignExternalId: 'EXT-C1', table: null },
  beforeValue: '20',
  afterValue: '30',
  status: 'PENDING',
  failureCode: null,
  requestedBy: 'user-1',
} as unknown as AdsWriteRun

function setup(run: Partial<AdsWriteRun> = {}, options: { switches?: string[]; adsAccountId?: string | null; claimed?: number } = {}) {
  const current = { ...baseRun, ...run }
  const tx = {
    adsWriteRun: { updateMany: vi.fn(async () => ({ count: options.claimed ?? 1 })) },
    adsCampaign: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsAdGroup: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsTarget: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsKeyword: { updateMany: vi.fn(async () => ({ count: 1 })) },
    adsChangeLog: { createMany: vi.fn(async () => ({ count: 1 })) },
    entityEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    adsAutomationRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    daypartingRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
  }
  const enabled = options.switches ?? ['sw.ads.budget']
  const prisma = {
    adsWriteRun: { findFirst: vi.fn(async () => current), updateMany: vi.fn(async () => ({ count: 1 })) },
    integrationSwitch: { findMany: vi.fn(async () => enabled.map(switchKey => ({ switchKey }))) },
    platformConnection: { findFirst: vi.fn(async () => ({ id: 'conn-1' })) },
    adsProfile: { findFirst: vi.fn(async () => ({ adsAccountId: options.adsAccountId === undefined ? 'acct-1' : options.adsAccountId, sellerAccountId: 'sa1' })) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient
  const definition = createAdsWriteWorkflow({ prisma, guardFor: vi.fn(), secrets: {} as never })
  const ctx = (responses: unknown[] = []) =>
    ({ tenantId: 't1', intent: { tenantId: 't1', connectionId: 'conn-1', adsWriteRunId: 'run-1' }, request: {}, responseOf: (seq: number) => responses[seq] }) as unknown as StepContext<WriteRunIntent>
  return { definition, ctx, tx, prisma, steps: definition.steps }
}

describe('写入记录 → 请求输入', () => {
  it('只取出认识的字段，类型不对的丢弃', () => {
    const input = inputOfRun({ kind: 'KEYWORD_ADD', externalId: 'G1', requestJson: { text: 'yoga', matchType: 'EXACT', amount: 'bad', campaignExternalId: 'C1', junk: 1 } } as never)
    expect(input).toMatchObject({ kind: 'KEYWORD_ADD', externalId: 'G1', campaignExternalId: 'C1', text: 'yoga', matchType: 'EXACT' })
    expect(input.amount).toBeUndefined()
  })
})

describe('流程：调用亚马逊', () => {
  it('动作开关已关闭：不向亚马逊发任何请求，永久失败', async () => {
    const { steps, ctx } = setup({}, { switches: [] })
    await expect(steps[0].run(ctx())).rejects.toMatchObject({ code: 'SWITCH_DISABLED' })
    expect(amazon.mutate).not.toHaveBeenCalled()
  })

  it('自动规则发起的写入：动作开关开着、来源开关没开也不能写', async () => {
    const onlyOwn = setup({ source: 'AUTO_RULE' } as never, { switches: ['sw.ads.budget'] })
    await expect(onlyOwn.steps[0].run(onlyOwn.ctx())).rejects.toMatchObject({ code: 'SWITCH_DISABLED' })
    const both = setup({ source: 'AUTO_RULE' } as never, { switches: ['sw.ads.budget', 'sw.ads.rule.run'] })
    amazon.mutate.mockResolvedValueOnce({})
    await both.steps[0].run(both.ctx())
    expect(amazon.mutate).toHaveBeenCalledTimes(1)
  })

  it('修改预算：调用统一接口的更新，记录先标为执行中', async () => {
    amazon.mutate.mockResolvedValueOnce({ campaigns: [{ campaignId: 'EXT-C1' }] })
    const { steps, ctx, prisma } = setup()
    expect(await steps[0].run(ctx())).toMatchObject({ externalId: 'EXT-C1' })
    expect(amazon.mutate).toHaveBeenCalledWith('update', 'campaigns', expect.objectContaining({ campaignId: 'EXT-C1' }))
    expect((prisma.adsWriteRun.updateMany as any).mock.calls[0][0].data).toMatchObject({ status: 'RUNNING' })
  })

  it('已经成功的记录不再调用亚马逊', async () => {
    const { steps, ctx } = setup({ status: 'SUCCEEDED' } as never)
    expect(await steps[0].run(ctx())).toMatchObject({ done: true })
    expect(amazon.mutate).not.toHaveBeenCalled()
  })

  it('亚马逊逐条拒绝：永久失败，只留短码；广告档案没有账户编号：永久失败；请求不完整：永久失败且不调用', async () => {
    amazon.mutate.mockResolvedValueOnce({ error: [{ code: 'INVALID' }] })
    const rejected = setup()
    await expect(rejected.steps[0].run(rejected.ctx())).rejects.toMatchObject({ code: 'ADS_WRITE_REJECTED' })
    const noAccount = setup({}, { adsAccountId: null })
    await expect(noAccount.steps[0].run(noAccount.ctx())).rejects.toMatchObject({ code: 'ADS_ACCOUNT_MISSING' })
    amazon.mutate.mockClear()
    const invalid = setup({ requestJson: {} } as never)
    const error = await invalid.steps[0].run(invalid.ctx()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NonRetryableError)
    expect((error as NonRetryableError).code).toBe('ADS_WRITE_REQUEST_INVALID')
    expect(amazon.mutate).not.toHaveBeenCalled()
  })

  it('对账：修改类不对账；新增类按词与匹配方式查已有的投放，找到就沿用，找不到才重新创建；已成功的直接沿用', async () => {
    const update = setup()
    expect(await update.steps[0].reconcile!(update.ctx())).toEqual({ found: false })
    const created = setup({ kind: 'NEGATIVE_ADD', externalId: 'EXT-G1', requestJson: { text: 'Free', matchType: 'NEGATIVE_EXACT', level: 'AD_GROUP', campaignExternalId: 'EXT-C1' } } as never)
    amazon.queryPage.mockResolvedValueOnce({ items: [{ targetId: 'T-1', negative: true, targetDetails: { keywordTarget: { keyword: 'free', matchType: 'NEGATIVE_EXACT' } } }] })
    expect(await created.steps[0].reconcile!(created.ctx())).toMatchObject({ found: true, response: { createdId: 'T-1' } })
    amazon.queryPage.mockResolvedValueOnce({ items: [{ targetId: 'T-2', negative: false, targetDetails: { keywordTarget: { keyword: 'free', matchType: 'NEGATIVE_EXACT' } } }] })
    expect(await created.steps[0].reconcile!(created.ctx())).toEqual({ found: false })
    const done = setup({ status: 'SUCCEEDED' } as never)
    expect(await done.steps[0].reconcile!(done.ctx())).toMatchObject({ found: true })
  })
})

describe('流程：回写', () => {
  it('预算：改本地对象、写变更记录（来源手动、带操作人与写入记录编号）与操作事件，记录标为已完成', async () => {
    const { steps, ctx, tx } = setup()
    await steps[1].run(ctx())
    expect(tx.adsWriteRun.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SUCCEEDED', failureCode: null })
    expect(tx.adsCampaign.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'c1', tenantId: 't1' } })
    expect(String(tx.adsCampaign.updateMany.mock.calls[0][0].data.budget)).toBe('30')
    expect(tx.adsChangeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({
      entityType: 'CAMPAIGN',
      entityId: 'c1',
      changedField: 'budget',
      beforeValue: '20',
      afterValue: '30',
      actorKind: 'MANUAL',
      actorId: 'user-1',
      writeRunId: 'run-1',
    })
    expect(tx.entityEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({
      entityType: 'ADS_CAMPAIGN',
      kind: 'ads.campaign.budget',
      actorKind: 'USER',
      actorId: 'user-1',
      sourceRef: 'ads-write:run-1',
      sellerAccountId: 'sa1',
    })
  })

  it('自动规则与分时策略的写入：变更记录的来源不是手动、不带操作人；事件的操作者是系统', async () => {
    const { steps, ctx, tx } = setup({ source: 'DAYPARTING', requestedBy: null } as never)
    await steps[1].run(ctx())
    expect(tx.adsChangeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ actorKind: 'DAYPARTING', actorId: null })
    expect(tx.entityEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({ actorKind: 'SYSTEM', actorId: null })
  })

  it('确认成功后，规则与分时策略里“已提交”的执行记录改为“已执行”（只改这条写入对应的）', async () => {
    const { steps, ctx, tx } = setup({ source: 'AUTO_RULE', requestedBy: null } as never)
    await steps[1].run(ctx())
    for (const table of [tx.adsAutomationRun, tx.daypartingRun]) {
      expect(table.updateMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 't1', writeRunId: 'run-1', outcome: 'QUEUED' }, data: { executed: true, outcome: 'APPLIED', message: null } })
    }
  })

  it('已经回写过（流程重放）：不重复写变更记录与事件，也不再改本地对象', async () => {
    const { steps, ctx, tx } = setup({}, { claimed: 0 })
    await steps[1].run(ctx())
    expect(tx.adsAutomationRun.updateMany).not.toHaveBeenCalled()
    expect(tx.adsChangeLog.createMany).not.toHaveBeenCalled()
    expect(tx.entityEvent.createMany).not.toHaveBeenCalled()
    expect(tx.adsCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('各类写入落到各自的本地表与字段；关键词表里的投放对象改关键词表；广告位与新增类没有本地列', async () => {
    const cases: Array<[Partial<AdsWriteRun>, keyof ReturnType<typeof setup>['tx'] | null, Record<string, unknown>]> = [
      [{ kind: 'CAMPAIGN_STATE', requestJson: { state: 'PAUSED' } }, 'adsCampaign', { state: 'PAUSED' }],
      [{ kind: 'CAMPAIGN_BID_STRATEGY', requestJson: { strategy: 'MANUAL' } }, 'adsCampaign', { bidStrategy: 'MANUAL' }],
      [{ kind: 'AD_GROUP_STATE', requestJson: { state: 'PAUSED' } }, 'adsAdGroup', { state: 'PAUSED' }],
      [{ kind: 'AD_GROUP_BID', requestJson: { amount: 1.5 } }, 'adsAdGroup', {}],
      [{ kind: 'TARGET_STATE', requestJson: { state: 'PAUSED', table: 'AdsTarget' } }, 'adsTarget', { state: 'PAUSED' }],
      [{ kind: 'TARGET_BID', requestJson: { amount: 2, table: 'AdsKeyword' } }, 'adsKeyword', {}],
      [{ kind: 'CAMPAIGN_PLACEMENT', requestJson: { placement: 'TOP_OF_SEARCH', amount: 50 } }, null, {}],
      [{ kind: 'KEYWORD_ADD', requestJson: { text: 'x', matchType: 'EXACT' } }, null, {}],
    ]
    for (const [run, table, data] of cases) {
      const { steps, ctx, tx } = setup(run as never)
      await steps[1].run(ctx())
      for (const name of ['adsCampaign', 'adsAdGroup', 'adsTarget', 'adsKeyword'] as const) {
        expect(tx[name].updateMany.mock.calls.length, `${run.kind}:${name}`).toBe(name === table ? 1 : 0)
      }
      if (table) expect(tx[table].updateMany.mock.calls[0][0].data).toMatchObject(data)
    }
  })

  it('变更记录里关键词表的投放对象记为 KEYWORD，投放表的记为 TARGET；新增类记在父对象上', async () => {
    const keyword = setup({ kind: 'TARGET_BID', entityType: 'TARGET', requestJson: { amount: 2, table: 'AdsKeyword' } } as never)
    await keyword.steps[1].run(keyword.ctx())
    expect(keyword.tx.adsChangeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ entityType: 'KEYWORD', changedField: 'bid' })
    const target = setup({ kind: 'TARGET_BID', entityType: 'TARGET', requestJson: { amount: 2, table: 'AdsTarget' } } as never)
    await target.steps[1].run(target.ctx())
    expect(target.tx.adsChangeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ entityType: 'TARGET', changedField: 'bid' })
    const negative = setup({ kind: 'NEGATIVE_ADD', entityType: 'AD_GROUP', requestJson: { text: 'x', matchType: 'NEGATIVE_EXACT', level: 'AD_GROUP' } } as never)
    await negative.steps[1].run(negative.ctx())
    expect(negative.tx.adsChangeLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ entityType: 'AD_GROUP', changedField: 'negativeTarget' })
  })
})

describe('永久失败的处置', () => {
  const failing = (run: Record<string, unknown> | null) => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const automation = vi.fn(async () => ({ count: 1 }))
    const dayparting = vi.fn(async () => ({ count: 1 }))
    const db = { adsWriteRun: { findFirst: vi.fn(async () => run), updateMany }, adsAutomationRun: { updateMany: automation }, daypartingRun: { updateMany: dayparting } } as unknown as PrismaClient
    return { db, updateMany, automation, dayparting }
  }
  const payload = { syncJobId: 'j1', requestId: 'r', adsWriteRunId: 'run-1' }

  it('写入记录标为失败并只留短码（不含亚马逊返回的原文）；已成功的记录不改', async () => {
    const { db, updateMany, automation, dayparting } = failing({ id: 'run-1', kind: 'CAMPAIGN_BUDGET' })
    await markAdsWriteFailed(db, 't1', payload, 'ADS_API_400_{"message":"secret detail"}')
    for (const mock of [automation, dayparting]) {
      const failed = (mock.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0]
      expect(failed.where).toMatchObject({ tenantId: 't1', writeRunId: 'run-1', outcome: 'QUEUED' })
      expect(failed.data).toMatchObject({ outcome: 'FAILED' })
      expect(JSON.stringify(failed.data)).not.toContain('secret')
    }
    const call = (updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0]
    expect(call.data).toMatchObject({ status: 'FAILED', failureCode: 'ADS_API_400' })
    expect(JSON.stringify(call.data)).not.toContain('secret')
    expect(call.where).toMatchObject({ status: { not: 'SUCCEEDED' } })
  })

  it('调用亚马逊的失败计入对应的开关，授权失效立即关闭；开关关闭、被拒绝、请求不完整不计入', async () => {
    const { db } = failing({ id: 'run-1', kind: 'CAMPAIGN_BUDGET' })
    await markAdsWriteFailed(db, 't1', payload, 'ADS_API_403_x')
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(db, 't1', 'sw.ads.budget', expect.objectContaining({ success: false, authInvalid: true }))
    outcome.recordSwitchOutcome.mockClear()
    await markAdsWriteFailed(db, 't1', payload, 'ADS_API_500_x')
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(db, 't1', 'sw.ads.budget', expect.objectContaining({ success: false, authInvalid: false }))
    outcome.recordSwitchOutcome.mockClear()
    for (const code of ['SWITCH_DISABLED', 'ADS_WRITE_REJECTED', 'ADS_WRITE_REQUEST_INVALID', 'ADS_ACCOUNT_MISSING']) await markAdsWriteFailed(db, 't1', payload, code)
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('没有写入记录编号或记录不存在：什么都不做', async () => {
    const none = failing(null)
    await markAdsWriteFailed(none.db, 't1', payload, 'ADS_API_500_x')
    await markAdsWriteFailed(none.db, 't1', { syncJobId: 'j1', requestId: 'r' }, 'ADS_API_500_x')
    expect(none.updateMany).not.toHaveBeenCalled()
  })

  it('失败码短码：只留来源加状态码，其余截断', () => {
    expect(shortAdsWriteCode('ADS_API_429_{"x":1}')).toBe('ADS_API_429')
    expect(shortAdsWriteCode('X'.repeat(100))).toHaveLength(60)
  })
})
