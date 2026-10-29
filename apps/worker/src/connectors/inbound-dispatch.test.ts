import type { FbaInboundPlan, InboundOperation, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncPayload } from '../types'
import type { ProductionDeps } from './dispatch'
import { UpstreamHttpError } from './http-error'

// 入仓计划任务（P2a-12）：资格预检（不合格不是失败）、标签、异步操作的轮询（成功推进阶段、失败记原因、超时）、
// 永久失败的处置（只有真正调用了亚马逊的失败才计入开关）。

const amazon = vi.hoisted(() => ({ operationStatus: vi.fn(), eligibility: vi.fn(), boxLabels: vi.fn() }))
vi.mock('./inbound-api', () => ({
  InboundApi: vi.fn(function () {
    return amazon
  }),
}))
const sync = vi.hoisted(() => ({
  syncOnePlan: vi.fn(async () => 3),
  syncInboundPlans: vi.fn(async () => ({ imported: 1 })),
  transportVoidDeadline: vi.fn(async () => ({ shippingMode: 'SPD', deadline: new Date('2026-10-23T10:00:00Z') })),
}))
vi.mock('../importers/inbound/v2024-sync', () => sync)
const outcome = vi.hoisted(() => ({ recordSwitchOutcome: vi.fn(async () => ({ autoClosed: [] })) }))
vi.mock('../platform/switch-outcome', () => outcome)
const workflow = vi.hoisted(() => ({ runWriteWorkflow: vi.fn(async () => ({})) }))
vi.mock('../runtime/workflows', () => workflow)
const store = vi.hoisted(() => ({ put: vi.fn(async (_target: unknown, _bytes: unknown) => ({ key: 'k/label', sizeBytes: 10 })) }))
vi.mock('@nova/storage', () => ({
  TenantObjectStore: vi.fn(function () {
    return store
  }),
}))

import { markInboundOpFailed, processInbound } from './inbound-dispatch'

beforeEach(() => {
  amazon.operationStatus.mockReset()
  amazon.eligibility.mockReset()
  amazon.boxLabels.mockReset()
  sync.syncOnePlan.mockClear()
  outcome.recordSwitchOutcome.mockClear()
  workflow.runWriteWorkflow.mockClear()
  store.put.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

const T0 = new Date('2026-10-22T10:00:00Z')
const baseOp = (operation: string, extra: Partial<InboundOperation> = {}) =>
  ({ id: 'op-1', tenantId: 't1', planId: 'plan-1', operation, status: 'IN_PROGRESS', operationId: 'amz-op', paramsJson: {}, startedAt: new Date(), ...extra }) as unknown as InboundOperation
const basePlan = (extra: Partial<FbaInboundPlan> = {}) =>
  ({ id: 'plan-1', tenantId: 't1', externalPlanId: 'ext-1', marketplaceId: 'ATVPDKIKX0DER', stage: 'CREATED', pendingOp: 'X', ...extra }) as unknown as FbaInboundPlan
const payload = (extra: Partial<SyncPayload> = {}) => ({ syncJobId: 'j1', requestId: 'r', tenantId: 't1', inboundOpId: 'op-1', ...extra }) as SyncPayload
const row = (type = 'FBA_INBOUND_OP') => ({ id: 'j1', type, tenantId: 't1', connection: { id: 'c1' } })
const run = { jobId: 'bull-1', priority: 5, lease: null, isLastAttempt: false }

function setup(opRow: InboundOperation, planRow: FbaInboundPlan, extra: Record<string, unknown> = {}) {
  const planUpdate = vi.fn(async () => planRow)
  const opUpdate = vi.fn(async () => opRow)
  const jobUpdate = vi.fn(async () => ({}))
  const prisma = {
    inboundOperation: { findFirst: vi.fn(async () => opRow), update: opUpdate },
    fbaInboundPlan: { findFirst: vi.fn(async () => planRow), update: planUpdate },
    inboundPlanItem: {
      findMany: vi.fn(async () => [
        { sku: 'SKU-A', asin: 'B0A' },
        { sku: 'SKU-B', asin: null },
        { sku: 'SKU-C', asin: 'B0C' },
      ]),
    },
    inboundEligibilityCheck: { createMany: vi.fn(async () => ({ count: 3 })) },
    labelPrintJob: { findMany: vi.fn(async () => []), update: jobUpdate },
    fbaInboundShipment: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    shipmentItem: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
    ...extra,
  } as unknown as PrismaClient
  const deps = { prisma, logger: {}, reliability: { engine: {}, locks: {}, ownerId: 'w1' }, writeWorkflows: { inboundPlanOp: {} }, storage: {} } as unknown as ProductionDeps
  return { prisma, deps, planUpdate, opUpdate, jobUpdate }
}
const dataOf = (fn: { mock: { calls: unknown[][] } }, index = 0) => (fn.mock.calls[index][0] as { data: Record<string, unknown> }).data
const go = (deps: ProductionDeps, p: SyncPayload, type = 'FBA_INBOUND_OP') => processInbound(deps, {} as never, row(type), 'sa1', p, run)

describe('同步任务', () => {
  it('同步任务只做同步，不读操作记录', async () => {
    const t = setup(baseOp('X'), basePlan())
    expect(await go(t.deps, payload({ inboundOpId: undefined, fbaPlanId: 'plan-1' }), 'FBA_INBOUND_SYNC')).toEqual({ imported: 1 })
    expect(sync.syncInboundPlans).toHaveBeenCalledWith(t.deps, expect.anything(), { tenantId: 't1', sellerAccountId: 'sa1' }, { planId: 'plan-1' })
  })
})

describe('资格预检', () => {
  it('每个 SKU 记一行：缺 ASIN、亚马逊 4xx、不合格都记为不合格而不是任务失败；全部合格才进入“资格预检”阶段', async () => {
    amazon.eligibility.mockResolvedValueOnce({ isEligibleForProgram: true }).mockRejectedValueOnce(new UpstreamHttpError('SP_API_400', 400, undefined, 'api'))
    const t = setup(baseOp('ELIGIBILITY', { status: 'QUEUED', operationId: null }), basePlan({ stage: 'DRAFT' }))
    const result = await go(t.deps, payload())
    expect(result).toMatchObject({ done: true, checked: 3, ineligible: 2 })
    const rows = (t.prisma.inboundEligibilityCheck.createMany as unknown as { mock: { calls: Array<[{ data: Array<Record<string, unknown>> }]> } }).mock.calls[0][0].data
    expect(rows.map(item => [item.sku, item.eligible, item.reasonCodes])).toEqual([
      ['SKU-A', true, []],
      ['SKU-B', false, ['ASIN_UNKNOWN']],
      ['SKU-C', false, ['SP_API_400']],
    ])
    expect(dataOf(t.planUpdate)).toMatchObject({ stage: 'DRAFT', pendingOp: null })
    expect(dataOf(t.opUpdate)).toMatchObject({ status: 'SUCCESS' })
  })

  it('全部合格推进到“资格预检”；缺角色或限速不是不合格，原样抛出', async () => {
    amazon.eligibility.mockResolvedValue({ isEligibleForProgram: true })
    const ok = setup(baseOp('ELIGIBILITY'), basePlan({ stage: 'DRAFT' }), { inboundPlanItem: { findMany: vi.fn(async () => [{ sku: 'SKU-A', asin: 'B0A' }]) } })
    await go(ok.deps, payload())
    expect(dataOf(ok.planUpdate)).toMatchObject({ stage: 'ELIGIBILITY' })
    amazon.eligibility.mockReset()
    amazon.eligibility.mockRejectedValueOnce(new UpstreamHttpError('SP_API_403', 403, undefined, 'api'))
    const denied = setup(baseOp('ELIGIBILITY'), basePlan({ stage: 'DRAFT' }))
    await expect(go(denied.deps, payload())).rejects.toThrow('SP_API_403')
  })
})

describe('标签', () => {
  const shipment = { shipmentId: 's1', shipmentConfirmationId: 'FBA1', boxCount: 2, trackingJson: null }
  const labelJob = (kind: string) => ({ id: `job-${kind}`, kind, shipmentId: 's1', pageType: null })

  it('旧版本留下的商品标签任务：不再生成 CSV，标记失败并写明新入口（商品标签改为本地生成 PDF，走导出中心）', async () => {
    const update = vi.fn(async () => ({}))
    const t = setup(baseOp('LABELS', { paramsJson: { jobIds: ['job-ITEM'] } }), basePlan({ stage: 'TRANSPORT_CONFIRMED' }), {
      labelPrintJob: { findMany: vi.fn(async () => [labelJob('ITEM')]), update },
      fbaInboundShipment: { findUnique: vi.fn(async () => shipment), findMany: vi.fn(async () => [{ shipmentId: 's1' }]) },
    })
    expect(await go(t.deps, payload())).toMatchObject({ done: true, jobs: 1, failed: 1 })
    expect(store.put).not.toHaveBeenCalled()
    expect(amazon.boxLabels).not.toHaveBeenCalled()
    expect(update).toHaveBeenLastCalledWith({ where: { id: 'job-ITEM' }, data: expect.objectContaining({ status: 'FAILED', errorMessage: expect.stringContaining('生成商品标签（PDF）') }) })
  })

  it('箱标签：只接受加密链接；下载成功落对象存储；货件箱数全部有标签才进入“已打标签”', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })),
    )
    amazon.boxLabels.mockResolvedValueOnce({ DownloadURL: 'https://s3.example/label.pdf' })
    const jobs = [labelJob('BOX')]
    const labelPrintJob = { findMany: vi.fn(async (args: { where: { status?: string } }) => (args.where.status === 'READY' ? [{ shipmentId: 's1' }] : jobs)), update: vi.fn(async () => ({})) }
    const t = setup(baseOp('LABELS', { paramsJson: { jobIds: ['job-BOX'] } }), basePlan({ stage: 'TRANSPORT_CONFIRMED' }), {
      labelPrintJob,
      fbaInboundShipment: { findUnique: vi.fn(async () => shipment), findMany: vi.fn(async () => [{ shipmentId: 's1' }]) },
    })
    expect(await go(t.deps, payload())).toMatchObject({ failed: 0 })
    expect(amazon.boxLabels).toHaveBeenCalledWith('FBA1', { pageType: 'PackageLabel_Letter_6', boxCount: 2 })
    expect(labelPrintJob.update).toHaveBeenLastCalledWith({ where: { id: 'job-BOX' }, data: expect.objectContaining({ status: 'READY', objectKey: 'k/label' }) })
    expect(dataOf(t.planUpdate)).toMatchObject({ stage: 'LABELS_PRINTED' })

    amazon.boxLabels.mockResolvedValueOnce({ DownloadURL: 'http://insecure.example/label.pdf' })
    const bad = setup(baseOp('LABELS', { paramsJson: { jobIds: ['job-BOX'] } }), basePlan({ stage: 'TRANSPORT_CONFIRMED' }), {
      labelPrintJob: { findMany: vi.fn(async (args: { where: { status?: string } }) => (args.where.status === 'READY' ? [] : jobs)), update: vi.fn(async () => ({})) },
      fbaInboundShipment: { findUnique: vi.fn(async () => shipment), findMany: vi.fn(async () => [{ shipmentId: 's1' }]) },
    })
    expect(await go(bad.deps, payload())).toMatchObject({ failed: 1 })
    expect(dataOf(bad.opUpdate)).toMatchObject({ status: 'FAILED', errorCode: 'INB_LABELS_FAILED' })
    expect(dataOf(bad.planUpdate)).not.toHaveProperty('stage')
  })

  it('货件还没有确认号或箱数：该标签失败并说明原因，不调用亚马逊', async () => {
    const update = vi.fn(async () => ({}))
    const t = setup(baseOp('LABELS', { paramsJson: { jobIds: ['job-BOX'] } }), basePlan(), {
      labelPrintJob: { findMany: vi.fn(async () => [labelJob('BOX')]), update },
      fbaInboundShipment: { findUnique: vi.fn(async () => ({ shipmentId: 's1', shipmentConfirmationId: null, boxCount: null, trackingJson: null })), findMany: vi.fn(async () => []) },
    })
    expect(await go(t.deps, payload())).toMatchObject({ failed: 1 })
    expect(update).toHaveBeenLastCalledWith({ where: { id: 'job-BOX' }, data: { status: 'FAILED', errorMessage: expect.stringContaining('确认号') } })
    expect(amazon.boxLabels).not.toHaveBeenCalled()
  })
})

describe('异步操作的轮询', () => {
  it('第一次进来：走流程提交到亚马逊，然后返回“等待中”；写开关结果登记为成功', async () => {
    const t = setup(baseOp('CONFIRM_PACKING', { status: 'QUEUED', operationId: null }), basePlan())
    expect(await go(t.deps, payload())).toEqual({ pending: true, operation: 'CONFIRM_PACKING' })
    expect(workflow.runWriteWorkflow).toHaveBeenCalledOnce()
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(t.prisma, 't1', 'sw.inbound.packing.confirm', { success: true })
    const generate = setup(baseOp('GENERATE_PACKING', { status: 'QUEUED', operationId: null }), basePlan())
    await go(generate.deps, payload())
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledTimes(1) // 生成类不受开关控制，不登记
  })

  it('仍在处理：返回等待；超过 15 分钟记“等待超时”并永久失败', async () => {
    amazon.operationStatus.mockResolvedValue({ status: 'IN_PROGRESS', problems: [] })
    const waiting = setup(baseOp('CONFIRM_PACKING'), basePlan())
    expect(await go(waiting.deps, payload({ poll: true }))).toEqual({ pending: true, operationId: 'amz-op' })
    const late = setup(baseOp('CONFIRM_PACKING', { startedAt: new Date(Date.now() - 16 * 60_000) }), basePlan())
    await expect(go(late.deps, payload({ poll: true }))).rejects.toMatchObject({ code: 'INB_OP_TIMEOUT' })
    expect(dataOf(late.opUpdate)).toMatchObject({ status: 'TIMEOUT', errorCode: 'INB_OP_TIMEOUT' })
    expect(dataOf(late.planUpdate)).toMatchObject({ pendingOp: null, lastErrorCode: 'INB_OP_TIMEOUT' })
  })

  it('亚马逊返回失败：记原因与问题清单，不重试；创建计划失败时清掉计划编号以便重新提交', async () => {
    amazon.operationStatus.mockResolvedValue({ status: 'FAILED', problems: [{ code: 'E1', message: 'SKU 不可入仓', severity: 'ERROR' }] })
    const t = setup(baseOp('CREATE_PLAN'), basePlan({ stage: 'ELIGIBILITY' }))
    await expect(go(t.deps, payload({ poll: true }))).rejects.toMatchObject({ code: 'INB_OP_FAILED' })
    expect(dataOf(t.opUpdate)).toMatchObject({ status: 'FAILED', errorCode: 'INB_OP_FAILED' })
    expect(dataOf(t.planUpdate)).toMatchObject({ externalPlanId: null, pendingOp: null })
    expect(String(dataOf(t.planUpdate).lastErrorMessage)).toContain('SKU 不可入仓')
  })

  it('成功：同步计划、按操作推进阶段、清在途标记；确认运输方案时记作废截止与运输方式', async () => {
    amazon.operationStatus.mockResolvedValue({ status: 'SUCCESS', problems: [] })
    const packing = setup(baseOp('CONFIRM_PACKING'), basePlan())
    expect(await go(packing.deps, payload({ poll: true }))).toMatchObject({ done: true, imported: 3 })
    expect(dataOf(packing.planUpdate)).toMatchObject({ stage: 'PACKING_CONFIRMED', pendingOp: null, lastErrorCode: null })
    expect(dataOf(packing.opUpdate)).toMatchObject({ status: 'SUCCESS' })
    const transport = setup(baseOp('CONFIRM_TRANSPORT'), basePlan({ stage: 'PLACEMENT_CONFIRMED' }))
    await go(transport.deps, payload({ poll: true }))
    expect(dataOf(transport.planUpdate)).toMatchObject({ stage: 'TRANSPORT_CONFIRMED', shippingMode: 'SPD', voidDeadlineAt: new Date('2026-10-23T10:00:00Z') })
    expect(dataOf(transport.planUpdate).transportConfirmedAt).toBeInstanceOf(Date)
    const generate = setup(baseOp('GENERATE_PLACEMENT'), basePlan({ stage: 'PACKING_INFO_SUBMITTED' }))
    await go(generate.deps, payload({ poll: true }))
    expect(dataOf(generate.planUpdate)).not.toHaveProperty('stage') // 生成类只刷新方案，阶段不变
  })

  it('已经结束的操作被重复投递：不再重复处理', async () => {
    const t = setup(baseOp('CONFIRM_PACKING', { status: 'SUCCESS' }), basePlan())
    expect(await go(t.deps, payload({ poll: true }))).toEqual({ done: true, status: 'SUCCESS' })
    expect(amazon.operationStatus).not.toHaveBeenCalled()
    expect(t.planUpdate).not.toHaveBeenCalled()
    void T0
  })
})

describe('永久失败的处置', () => {
  it('调用亚马逊的失败：操作标为失败、计划不再处理中，计入开关；授权失效立即关闭', async () => {
    const t = setup(baseOp('CONFIRM_PACKING', { status: 'QUEUED', operationId: null }), basePlan())
    await markInboundOpFailed(t.prisma, 't1', payload(), 'SP_API_403_{"errors":[{"message":"secret"}]}')
    expect(dataOf(t.opUpdate)).toMatchObject({ status: 'FAILED', errorCode: 'SP_API_403' })
    expect(dataOf(t.planUpdate)).toMatchObject({ pendingOp: null, lastErrorCode: 'SP_API_403' })
    expect(String(dataOf(t.planUpdate).lastErrorMessage)).not.toContain('secret')
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(t.prisma, 't1', 'sw.inbound.packing.confirm', expect.objectContaining({ success: false, authInvalid: true }))
  })

  it('开关已关闭、计划信息不完整、亚马逊异步失败：不计入开关；生成类操作没有开关可记；创建失败清掉计划编号', async () => {
    const closed = setup(baseOp('CONFIRM_PACKING', { status: 'QUEUED' }), basePlan())
    await markInboundOpFailed(closed.prisma, 't1', payload(), 'SWITCH_DISABLED')
    await markInboundOpFailed(closed.prisma, 't1', payload(), 'INB_BOXES_EMPTY')
    const generate = setup(baseOp('GENERATE_PACKING', { status: 'QUEUED' }), basePlan())
    await markInboundOpFailed(generate.prisma, 't1', payload(), 'SP_API_500_x')
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
    const create = setup(baseOp('CREATE_PLAN', { status: 'QUEUED' }), basePlan())
    await markInboundOpFailed(create.prisma, 't1', payload(), 'SP_API_400_x')
    expect(dataOf(create.planUpdate)).toMatchObject({ externalPlanId: null })
  })

  it('操作已经结束：只补清计划的在途标记；没有操作编号的任务什么都不做', async () => {
    const done = setup(baseOp('CONFIRM_PACKING', { status: 'FAILED' }), basePlan())
    await markInboundOpFailed(done.prisma, 't1', payload(), 'INB_OP_FAILED')
    expect(done.opUpdate).not.toHaveBeenCalled()
    expect(dataOf(done.planUpdate)).toEqual({ pendingOp: null })
    const none = setup(baseOp('X'), basePlan())
    await markInboundOpFailed(none.prisma, 't1', payload({ inboundOpId: undefined }), 'SP_API_500')
    expect(none.planUpdate).not.toHaveBeenCalled()
  })
})
