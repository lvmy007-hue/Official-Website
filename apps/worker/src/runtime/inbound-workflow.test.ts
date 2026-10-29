import type { FbaInboundPlan, InboundOperation, PrismaClient } from '@prisma/client'
import { NonRetryableError, type StepContext, type WriteRunIntent } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 入仓计划写操作流程（P2a-12）：调用亚马逊前先确认开关（生成类不受开关控制）；创建沿用已有计划编号；
// 预处理方与贴标方固定为卖家；箱内物品按装箱组提交；确认类与取消靠重新读计划对账；回写记操作编号并把计划置为处理中。

const amazon = vi.hoisted(() => ({
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  generatePacking: vi.fn(),
  listPackingOptions: vi.fn(),
  confirmPacking: vi.fn(),
  setPackingInformation: vi.fn(),
  generatePlacement: vi.fn(),
  listPlacementOptions: vi.fn(),
  confirmPlacement: vi.fn(),
  generateTransport: vi.fn(),
  confirmTransport: vi.fn(),
  generateWindows: vi.fn(),
  confirmWindow: vi.fn(),
  updateTracking: vi.fn(),
  cancelPlan: vi.fn(),
}))
vi.mock('../connectors/inbound-api', () => ({
  InboundApi: vi.fn(function () {
    return amazon
  }),
}))
vi.mock('../connectors/amazon-sp-api', () => ({ AmazonSpApiClient: vi.fn() }))
vi.mock('@nova/tenancy', () => ({ runWithTenant: (_tenantId: string, fn: () => unknown) => fn() }))

import { createInboundWorkflow, toPackageGroupings } from './inbound-workflow'

beforeEach(() => {
  for (const fn of Object.values(amazon)) fn.mockReset()
})

const address = { name: 'Our Warehouse', addressLine1: '9 Origin St', city: 'LA', stateOrProvinceCode: 'CA', postalCode: '90001', countryCode: 'US' }
const plan = {
  id: 'plan-1',
  tenantId: 't1',
  name: 'Plan A',
  marketplaceId: 'ATVPDKIKX0DER',
  sourceAddress: JSON.stringify(address),
  externalPlanId: null,
  selectedPackingOptionId: 'po1',
  selectedPlacementOptionId: 'pl1',
} as unknown as FbaInboundPlan
const op = (operation: string, params: unknown = {}) => ({ id: 'op-1', planId: 'plan-1', operation, paramsJson: params, status: 'QUEUED' }) as unknown as InboundOperation
const box = { boxId: 'B1', packingGroupId: 'pg1', quantity: 2, weightLb: 20, lengthIn: 20, widthIn: 15, heightIn: 10, contentJson: [{ sku: 'SKU-A', quantity: 12 }] }

function setup(options: { op: InboundOperation; plan?: Partial<FbaInboundPlan>; switchOn?: boolean; boxes?: unknown[] }) {
  const current = { ...plan, ...options.plan }
  const planUpdate = vi.fn(async () => current)
  const opUpdate = vi.fn(async () => options.op)
  const prisma = {
    inboundOperation: { findFirst: vi.fn(async () => options.op), update: opUpdate },
    fbaInboundPlan: { findFirst: vi.fn(async () => current), update: planUpdate },
    inboundPlanItem: {
      findMany: vi.fn(async () => [
        { sku: 'SKU-A', quantity: 120, expiry: new Date('2027-06-30T00:00:00Z') },
        { sku: 'SKU-B', quantity: 60, expiry: null },
      ]),
    },
    inboundBox: { findMany: vi.fn(async () => options.boxes ?? [box]) },
    packingGroup: { findMany: vi.fn(async () => [{ packingGroupId: 'pg1' }]) },
    integrationSwitch: { findFirst: vi.fn(async () => (options.switchOn === false ? null : { id: 's1' })) },
    platformConnection: { findFirst: vi.fn(async () => ({ id: 'c1' })) },
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
  } as unknown as PrismaClient
  const definition = createInboundWorkflow({ prisma, guardFor: vi.fn(), secrets: {} as never })
  const ctx = (responses: unknown[] = [], request: unknown = { requestedAt: '2026-10-22T10:00:00Z' }) =>
    ({
      tenantId: 't1',
      runId: 'run-1',
      intent: { tenantId: 't1', connectionId: 'c1', inboundOpId: 'op-1' },
      request,
      responseOf: (seq: number) => responses[seq],
    }) as unknown as StepContext<WriteRunIntent>
  return { steps: definition.steps, ctx, planUpdate, opUpdate, prisma }
}
const dataOf = (fn: { mock: { calls: unknown[][] } }, index = 0) => (fn.mock.calls[index][0] as { data: Record<string, unknown> }).data

describe('箱内物品的请求体', () => {
  it('按装箱组分组；只有一个装箱组时箱子可以不写组；有效期按 SKU 带上；预处理方与贴标方固定为卖家', () => {
    const grouped = toPackageGroupings([box, { ...box, boxId: 'B2', packingGroupId: null }], ['pg1'], new Map([['SKU-A', '2027-06-30']])) as Array<{
      packingGroupId: string
      boxes: Array<Record<string, unknown>>
    }>
    expect(grouped).toHaveLength(1)
    expect(grouped[0].boxes).toHaveLength(2)
    expect(grouped[0].boxes[0]).toMatchObject({
      contentInformationSource: 'BOX_CONTENT_PROVIDED',
      dimensions: { length: 20, width: 15, height: 10, unitOfMeasurement: 'IN' },
      weight: { value: 20, unit: 'LB' },
      quantity: 2,
      items: [{ msku: 'SKU-A', quantity: 12, labelOwner: 'SELLER', prepOwner: 'SELLER', expiration: '2027-06-30' }],
    })
  })
  it('有多个装箱组而箱子没有指定组：永久失败，不猜', () => {
    expect(() => toPackageGroupings([{ ...box, packingGroupId: null }], ['pg1', 'pg2'], new Map())).toThrow(NonRetryableError)
  })
})

describe('流程：调用亚马逊', () => {
  it('开关已关闭：确认类操作不向亚马逊发任何请求；生成类操作不受开关控制', async () => {
    const closed = setup({ op: op('CONFIRM_PACKING', { optionId: 'po1' }), plan: { externalPlanId: 'ext-1' }, switchOn: false })
    await expect(closed.steps[0].run(closed.ctx())).rejects.toMatchObject({ code: 'SWITCH_DISABLED' })
    expect(amazon.confirmPacking).not.toHaveBeenCalled()
    amazon.generatePacking.mockResolvedValueOnce({ operationId: 'o-1' })
    const generate = setup({ op: op('GENERATE_PACKING'), plan: { externalPlanId: 'ext-1' }, switchOn: false })
    expect(await generate.steps[0].run(generate.ctx())).toEqual({ operationId: 'o-1' })
    expect(generate.prisma.integrationSwitch.findFirst).not.toHaveBeenCalled()
  })

  it('创建：带商品与有效期；已经有计划编号时沿用不重复创建；没有商品或地址坏了都是永久失败', async () => {
    amazon.createPlan.mockResolvedValueOnce({ operationId: 'o-9', inboundPlanId: 'ext-9' })
    const fresh = setup({ op: op('CREATE_PLAN') })
    expect(await fresh.steps[0].run(fresh.ctx())).toEqual({ operationId: 'o-9', inboundPlanId: 'ext-9' })
    expect(amazon.createPlan.mock.calls[0][0]).toMatchObject({
      name: 'Plan A',
      marketplaceIds: ['ATVPDKIKX0DER'],
      sourceAddress: address,
      items: [
        { msku: 'SKU-A', quantity: 120, expiration: '2027-06-30' },
        { msku: 'SKU-B', quantity: 60 },
      ],
    })
    amazon.createPlan.mockClear()
    const again = setup({ op: op('CREATE_PLAN'), plan: { externalPlanId: 'ext-old' } })
    expect(await again.steps[0].run(again.ctx())).toEqual({ operationId: null, inboundPlanId: 'ext-old' })
    expect(amazon.createPlan).not.toHaveBeenCalled()
    const badAddress = setup({ op: op('CREATE_PLAN'), plan: { sourceAddress: '{not json' } })
    await expect(badAddress.steps[0].run(badAddress.ctx())).rejects.toMatchObject({ code: 'INB_ADDRESS_INVALID' })
  })

  it('除创建外都要求计划已提交到亚马逊；缺参数是永久失败', async () => {
    const unsent = setup({ op: op('GENERATE_PACKING') })
    await expect(unsent.steps[0].run(unsent.ctx())).rejects.toMatchObject({ code: 'INB_PLAN_NOT_SUBMITTED' })
    const missing = setup({ op: op('CONFIRM_PLACEMENT', {}), plan: { externalPlanId: 'ext-1' } })
    await expect(missing.steps[0].run(missing.ctx())).rejects.toMatchObject({ code: 'INB_PARAM_MISSING' })
  })

  it('各确认类操作调用对应接口并带上所选编号', async () => {
    const external = { externalPlanId: 'ext-1' }
    amazon.confirmPlacement.mockResolvedValue({ operationId: 'o' })
    await (async () => {
      const t = setup({ op: op('CONFIRM_PLACEMENT', { optionId: 'pl2' }), plan: external })
      await t.steps[0].run(t.ctx())
    })()
    expect(amazon.confirmPlacement).toHaveBeenCalledWith('ext-1', 'pl2')
    amazon.confirmTransport.mockResolvedValue({ operationId: 'o' })
    const transport = setup({ op: op('CONFIRM_TRANSPORT', { selections: [{ shipmentId: 's1', transportOptionId: 'tr1' }] }), plan: external })
    await transport.steps[0].run(transport.ctx())
    expect(amazon.confirmTransport).toHaveBeenCalledWith('ext-1', [{ shipmentId: 's1', transportationOptionId: 'tr1', contactInformation: undefined }])
    amazon.confirmWindow.mockResolvedValue({ operationId: 'o' })
    const window = setup({ op: op('CONFIRM_WINDOW', { shipmentId: 's1', optionId: 'dw1' }), plan: external })
    await window.steps[0].run(window.ctx())
    expect(amazon.confirmWindow).toHaveBeenCalledWith('ext-1', 's1', 'dw1')
    amazon.cancelPlan.mockResolvedValue({ operationId: 'o' })
    const cancel = setup({ op: op('CANCEL_PLAN'), plan: external })
    await cancel.steps[0].run(cancel.ctx())
    expect(amazon.cancelPlan).toHaveBeenCalledWith('ext-1')
  })

  it('提交箱内物品：用已选装箱方案的装箱组；没有箱子时永久失败', async () => {
    amazon.setPackingInformation.mockResolvedValueOnce({ operationId: 'o' })
    const ok = setup({ op: op('SUBMIT_PACKING_INFO'), plan: { externalPlanId: 'ext-1' } })
    await ok.steps[0].run(ok.ctx())
    expect(amazon.setPackingInformation.mock.calls[0][0]).toBe('ext-1')
    expect(amazon.setPackingInformation.mock.calls[0][1]).toMatchObject([{ packingGroupId: 'pg1' }])
    const empty = setup({ op: op('SUBMIT_PACKING_INFO'), plan: { externalPlanId: 'ext-1' }, boxes: [] })
    await expect(empty.steps[0].run(empty.ctx())).rejects.toMatchObject({ code: 'INB_BOXES_EMPTY' })
  })

  it('回填追踪号：小包裹按箱，零担填提单号', async () => {
    amazon.updateTracking.mockResolvedValue({ operationId: 'o' })
    const spd = setup({ op: op('UPDATE_TRACKING', { shipmentId: 's1', items: [{ boxId: 'b1', trackingId: '1Z' }] }), plan: { externalPlanId: 'ext-1' } })
    await spd.steps[0].run(spd.ctx())
    expect(amazon.updateTracking).toHaveBeenLastCalledWith('ext-1', 's1', { spdTrackingDetail: { spdTrackingItems: [{ boxId: 'b1', trackingId: '1Z' }] } })
    const ltl = setup({ op: op('UPDATE_TRACKING', { shipmentId: 's1', billOfLadingNumber: 'BOL1' }), plan: { externalPlanId: 'ext-1' } })
    await ltl.steps[0].run(ltl.ctx())
    expect(amazon.updateTracking).toHaveBeenLastCalledWith('ext-1', 's1', { ltlTrackingDetail: { billOfLadingNumber: 'BOL1' } })
  })
})

describe('流程：对账', () => {
  it('创建：按名称与请求发出之后创建来找；更早的同名计划不算', async () => {
    const t = setup({ op: op('CREATE_PLAN') })
    amazon.listPlans.mockResolvedValueOnce({ inboundPlans: [{ name: 'Plan A', inboundPlanId: 'old', createdAt: '2026-10-01T00:00:00Z' }] })
    expect(await t.steps[0].reconcile!(t.ctx())).toEqual({ found: false })
    amazon.listPlans.mockResolvedValueOnce({ inboundPlans: [{ name: 'Plan A', inboundPlanId: 'new', createdAt: '2026-10-22T10:00:30Z' }] })
    expect(await t.steps[0].reconcile!(t.ctx())).toMatchObject({ found: true, response: { inboundPlanId: 'new' } })
  })

  it('确认类看方案是否已接受；取消看计划是否已作废；其他操作不对账', async () => {
    const external = { externalPlanId: 'ext-1' }
    const packing = setup({ op: op('CONFIRM_PACKING', { optionId: 'po1' }), plan: external })
    amazon.listPackingOptions.mockResolvedValueOnce({ packingOptions: [{ packingOptionId: 'po1', status: 'ACCEPTED' }] })
    expect(await packing.steps[0].reconcile!(packing.ctx())).toMatchObject({ found: true })
    amazon.listPackingOptions.mockResolvedValueOnce({ packingOptions: [{ packingOptionId: 'po1', status: 'OFFERED' }] })
    expect(await packing.steps[0].reconcile!(packing.ctx())).toEqual({ found: false })
    const placement = setup({ op: op('CONFIRM_PLACEMENT', { optionId: 'pl2' }), plan: external })
    amazon.listPlacementOptions.mockResolvedValueOnce({ placementOptions: [{ placementOptionId: 'pl2', status: 'ACCEPTED' }] })
    expect(await placement.steps[0].reconcile!(placement.ctx())).toMatchObject({ found: true })
    const cancel = setup({ op: op('CANCEL_PLAN'), plan: external })
    amazon.getPlan.mockResolvedValueOnce({ status: 'VOIDED' })
    expect(await cancel.steps[0].reconcile!(cancel.ctx())).toMatchObject({ found: true })
    const generate = setup({ op: op('GENERATE_PLACEMENT'), plan: external })
    expect(await generate.steps[0].reconcile!(generate.ctx())).toEqual({ found: false })
  })
})

describe('流程：回写', () => {
  it('记操作编号并置为处理中；创建时同时落计划编号', async () => {
    const t = setup({ op: op('CREATE_PLAN') })
    await t.steps[1].run(t.ctx([{ operationId: 'o-9', inboundPlanId: 'ext-9' }]))
    expect(dataOf(t.opUpdate)).toMatchObject({ operationId: 'o-9', status: 'IN_PROGRESS', writeRunId: 'run-1' })
    expect(dataOf(t.planUpdate)).toMatchObject({ externalPlanId: 'ext-9', status: 'ACTIVE' })
    const confirm = setup({ op: op('CONFIRM_PACKING'), plan: { externalPlanId: 'ext-1' } })
    await confirm.steps[1].run(confirm.ctx([{ operationId: 'o-2' }]))
    expect(confirm.planUpdate).not.toHaveBeenCalled()
  })
})
