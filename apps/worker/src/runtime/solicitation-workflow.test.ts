import type { PrismaClient } from '@prisma/client'
import { NonRetryableError, type StepContext, type WriteRunIntent } from '@nova/workflow'
import { REVIEWS_LIMITS } from '@nova/api-contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'

// 请求评价写操作流程（P4-13，I-16）：开关关闭时不调用亚马逊；有动作才发请求；窗口外、无动作、已请求过、其他 4xx 各有归宿；
// 限速向上抛且其余订单保持 QUEUED，重试只处理 QUEUED；授权失败立即终止整批；意图不含订单明细。

const amazon = vi.hoisted(() => ({ getActions: vi.fn(), requestReview: vi.fn() }))
vi.mock('../connectors/solicitations-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../connectors/solicitations-api')>()),
  SolicitationsApi: vi.fn(function () {
    return amazon
  }),
}))
vi.mock('../connectors/amazon-sp-api', () => ({ AmazonSpApiClient: vi.fn() }))
vi.mock('@nova/tenancy', () => ({ runWithTenant: (_tenantId: string, fn: () => unknown) => fn() }))

import { createSolicitationWorkflow } from './solicitation-workflow'

const NOW = new Date('2026-10-24T08:00:00.000Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  amazon.getActions.mockReset()
  amazon.requestReview.mockReset()
})
afterEach(() => vi.useRealTimers())

const withAction = { _links: { actions: [{ href: '/solicitations/v1/orders/x/solicitations/productReviewAndSellerFeedback', name: 'productReviewAndSellerFeedback' }] } }
const noAction = { _links: { actions: [] } }
const upstream = (status: number, message = `SP_API_${status}_{}`) => new UpstreamHttpError(message, status, undefined, 'api')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

type Row = Record<string, ReturnType<typeof JSON.parse>>
const rowOf = (orderId: string, over: Row = {}): Row => ({
  id: `r-${orderId}`,
  tenantId: 't1',
  sellerAccountId: 'sa1',
  amazonOrderId: orderId,
  batchId: 'b1',
  status: 'QUEUED',
  failureCode: null,
  sentAt: null,
  writeRunId: null,
  ...over,
})
const ids = ['111-0000001-0000001', '111-0000002-0000002', '111-0000003-0000003']

function setup(rows: Row[], options: { switchOn?: boolean; deliveredAt?: Date | null } = {}) {
  const findMany = vi.fn(async ({ where, take }: { where: Row; take: number }) =>
    rows
      .filter(row => row.batchId === where.batchId && row.status === where.status && (!where.sellerAccountId || row.sellerAccountId === where.sellerAccountId))
      .sort((a, b) => (a.amazonOrderId < b.amazonOrderId ? -1 : 1))
      .slice(0, take)
      .map(row => ({ ...row })),
  )
  const updateMany = vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = rows.find(item => item.id === where.id && item.status === where.status)
    if (row) Object.assign(row, data)
    return { count: row ? 1 : 0 }
  })
  const count = vi.fn(async ({ where }: { where: Row }) => rows.filter(row => row.batchId === where.batchId && row.status === where.status).length)
  const orderPackage = { findFirst: vi.fn(async () => (options.deliveredAt ? { deliveredAt: options.deliveredAt } : null)) }
  const prisma = {
    solicitationRequest: { findMany, updateMany, count },
    orderPackage,
    integrationSwitch: { findFirst: vi.fn(async () => (options.switchOn === false ? null : { id: 's1' })) },
    platformConnection: { findFirst: vi.fn(async () => ({ id: 'c1', sellerAccountId: 'sa1' })) },
  } as unknown as PrismaClient
  const definition = createSolicitationWorkflow({ prisma, guardFor: vi.fn(), secrets: {} as never })
  const ctx = (intent: Partial<WriteRunIntent> = {}) =>
    ({
      tenantId: 't1',
      runId: 'run-1',
      intent: { tenantId: 't1', connectionId: 'c1', solicitationBatchId: 'b1', ...intent },
      request: {},
      responseOf: () => undefined,
    }) as unknown as StepContext<WriteRunIntent>
  return { definition, step: definition.steps[0], ctx, rows, findMany, orderPackage }
}
const statuses = (rows: Row[]) => rows.map(row => row.status)

describe('写入开关', () => {
  it('开关已关闭：不向亚马逊发任何请求，订单保持 QUEUED，永久失败', async () => {
    const { step, ctx, rows } = setup(
      ids.map(id => rowOf(id)),
      { switchOn: false },
    )
    await expect(step.run(ctx())).rejects.toMatchObject({ code: 'SWITCH_DISABLED' })
    expect(amazon.getActions).not.toHaveBeenCalled()
    expect(amazon.requestReview).not.toHaveBeenCalled()
    expect(statuses(rows)).toEqual(['QUEUED', 'QUEUED', 'QUEUED'])
  })

  it('缺少批次编号：永久失败', async () => {
    const { step, ctx } = setup([])
    await expect(step.run(ctx({ solicitationBatchId: undefined }))).rejects.toBeInstanceOf(NonRetryableError)
  })
})

describe('逐单请求', () => {
  it('有动作就发请求：每单立即更新为已请求，记发送时间与流程编号；只读本批、本店铺、按订单号排序、不超过批量上限', async () => {
    amazon.getActions.mockResolvedValue(withAction)
    amazon.requestReview.mockResolvedValue(null)
    const other = rowOf('999-0000009-0000009', { batchId: 'b2' })
    const otherStore = rowOf('999-0000008-0000008', { sellerAccountId: 'sa2' })
    const { step, ctx, rows, findMany } = setup([rowOf(ids[2]), rowOf(ids[0]), rowOf(ids[1]), other, otherStore])
    const result = await step.run(ctx())
    expect(result).toMatchObject({ done: true, processed: 3, requested: 3, failed: 0 })
    expect(amazon.requestReview.mock.calls.map(call => call[0])).toEqual(ids)
    for (const row of rows.filter(item => ids.includes(item.amazonOrderId))) expect(row).toMatchObject({ status: 'REQUESTED', failureCode: null, sentAt: NOW, writeRunId: 'run-1' })
    expect(other.status).toBe('QUEUED')
    expect(otherStore.status).toBe('QUEUED')
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: REVIEWS_LIMITS.batchMax, orderBy: { amazonOrderId: 'asc' } }))
  })

  it('没有动作：不发请求，送达不到期限或取不到送达时间记“亚马逊不允许请求”；送达后超过 30 天记“已过请求期限”', async () => {
    amazon.getActions.mockResolvedValue(noAction)
    const unknown = setup([rowOf(ids[0])])
    expect(await unknown.step.run(unknown.ctx())).toMatchObject({ unavailable: 1, windowClosed: 0 })
    expect(unknown.rows[0]).toMatchObject({ status: 'UNAVAILABLE', failureCode: null, sentAt: null, writeRunId: null })
    const inside = setup([rowOf(ids[0])], { deliveredAt: daysAgo(10) })
    await inside.step.run(inside.ctx())
    expect(inside.rows[0].status).toBe('UNAVAILABLE')
    const late = setup([rowOf(ids[0])], { deliveredAt: daysAgo(31) })
    expect(await late.step.run(late.ctx())).toMatchObject({ windowClosed: 1 })
    expect(late.rows[0]).toMatchObject({ status: 'WINDOW_CLOSED', failureCode: null })
    expect(amazon.requestReview).not.toHaveBeenCalled()
    expect(late.orderPackage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1', sellerAccountId: 'sa1', order: { amazonOrderId: ids[0] } }), orderBy: { deliveredAt: 'desc' } }),
    )
  })

  it('送达第 30 天仍在期限内（只有超过 30 天才算过期）', async () => {
    amazon.getActions.mockResolvedValue(noAction)
    const edge = setup([rowOf(ids[0])], { deliveredAt: daysAgo(30) })
    await edge.step.run(edge.ctx())
    expect(edge.rows[0].status).toBe('UNAVAILABLE')
  })

  it('亚马逊说已经请求过：记已请求并留 SOL_ALREADY_SENT；403 以外的其他 4xx 只记这一单失败（只留来源与状态码），后面的订单照常', async () => {
    amazon.getActions.mockResolvedValue(withAction)
    amazon.requestReview.mockRejectedValueOnce(upstream(400, 'SP_API_400_{"errors":[{"message":"A solicitation has already been sent for this order"}]}'))
    amazon.requestReview.mockRejectedValueOnce(upstream(400, 'SP_API_400_{"errors":[{"message":"secret buyer text"}]}'))
    amazon.requestReview.mockResolvedValueOnce(null)
    const { step, ctx, rows } = setup(ids.map(id => rowOf(id)))
    expect(await step.run(ctx())).toMatchObject({ requested: 2, failed: 1 })
    expect(rows[0]).toMatchObject({ status: 'REQUESTED', failureCode: 'SOL_ALREADY_SENT', writeRunId: 'run-1' })
    expect(rows[1]).toMatchObject({ status: 'FAILED', failureCode: 'SP_API_400', sentAt: null })
    expect(JSON.stringify(rows[1])).not.toContain('secret')
    expect(rows[2].status).toBe('REQUESTED')
  })

  it('查询动作时被拒绝（例如 404）：这一单记失败，不发请求', async () => {
    amazon.getActions.mockRejectedValueOnce(upstream(404))
    amazon.getActions.mockResolvedValue(withAction)
    const { step, ctx, rows } = setup([rowOf(ids[0]), rowOf(ids[1])])
    await step.run(ctx())
    expect(rows[0]).toMatchObject({ status: 'FAILED', failureCode: 'SP_API_404' })
    expect(rows[1].status).toBe('REQUESTED')
    expect(amazon.requestReview).toHaveBeenCalledTimes(1)
  })

  it('401 / 403 是授权问题：记下这一单失败后立即终止整批（不可重试），后面的订单保持 QUEUED 且不再调用亚马逊', async () => {
    amazon.getActions.mockResolvedValue(withAction)
    amazon.requestReview.mockRejectedValueOnce(upstream(403))
    const { step, ctx, rows } = setup(ids.map(id => rowOf(id)))
    await expect(step.run(ctx())).rejects.toMatchObject({ code: 'SP_API_403' })
    expect(statuses(rows)).toEqual(['FAILED', 'QUEUED', 'QUEUED'])
    expect(rows[0].failureCode).toBe('SP_API_403')
    expect(amazon.getActions).toHaveBeenCalledTimes(1)
  })
})

describe('限速、故障与重试', () => {
  it('429 向上抛让流程重试：已处理的订单已落库，其余保持 QUEUED；重试只处理仍为 QUEUED 的订单', async () => {
    amazon.getActions.mockResolvedValue(withAction)
    amazon.requestReview.mockResolvedValueOnce(null)
    amazon.requestReview.mockRejectedValueOnce(upstream(429))
    const { step, ctx, rows } = setup(ids.map(id => rowOf(id)))
    await expect(step.run(ctx())).rejects.toMatchObject({ status: 429 })
    expect(statuses(rows)).toEqual(['REQUESTED', 'QUEUED', 'QUEUED'])
    amazon.getActions.mockClear()
    amazon.requestReview.mockReset()
    amazon.requestReview.mockResolvedValue(null)
    expect(await step.run(ctx())).toMatchObject({ processed: 2, requested: 2 })
    expect(amazon.getActions.mock.calls.map(call => call[0])).toEqual([ids[1], ids[2]])
    expect(statuses(rows)).toEqual(['REQUESTED', 'REQUESTED', 'REQUESTED'])
    expect(await step.run(ctx())).toMatchObject({ done: true, processed: 0 })
  })

  it('5xx 与网络错误同样向上抛，不改订单状态', async () => {
    amazon.getActions.mockRejectedValueOnce(upstream(503))
    const first = setup([rowOf(ids[0])])
    await expect(first.step.run(first.ctx())).rejects.toMatchObject({ status: 503 })
    expect(first.rows[0].status).toBe('QUEUED')
    amazon.getActions.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    const second = setup([rowOf(ids[0])])
    await expect(second.step.run(second.ctx())).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(second.rows[0].status).toBe('QUEUED')
  })
})

describe('意图与对账', () => {
  it('意图只记批次编号与订单数，不含订单号等明细', async () => {
    const { step, ctx } = setup(ids.map(id => rowOf(id)))
    const request = await step.buildRequest!(ctx())
    expect(request).toMatchObject({ solicitationBatchId: 'b1', orders: 3 })
    expect(JSON.stringify(request)).not.toContain('111-0000001')
  })

  it('对账：批里没有 QUEUED 订单就算已完成；否则没有', async () => {
    const pending = setup([rowOf(ids[0]), rowOf(ids[1], { status: 'REQUESTED' })])
    expect(await pending.step.reconcile!(pending.ctx())).toEqual({ found: false })
    const done = setup([rowOf(ids[0], { status: 'REQUESTED' }), rowOf(ids[1], { status: 'FAILED' })])
    expect(await done.step.reconcile!(done.ctx())).toEqual({ found: true, response: { done: true } })
  })
})
