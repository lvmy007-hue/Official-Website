import type { PrismaClient } from '@prisma/client'
import { NonRetryableError } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncPayload } from '../types'

// 请求评价任务分发与永久失败的处置（P4-13）：流程以批次 + 队列任务编号为去重键；成功登记开关结果；永久失败后这一批还在“处理中”的订单改为发送失败，
// 失败码只留“来源 + 状态码”，只有真正调用了亚马逊的失败才计入开关，授权失效立即关闭；已有结果的订单不动。

const outcome = vi.hoisted(() => ({ recordSwitchOutcome: vi.fn(async () => ({ autoClosed: [] })) }))
vi.mock('../platform/switch-outcome', () => outcome)
const flow = vi.hoisted(() => ({ runWriteWorkflow: vi.fn(async () => ({ done: true })) }))
vi.mock('../runtime/workflows', () => flow)

import { SOLICITATION_JOB_TYPES, markSolicitationFailed, processSolicitation, solicitationFailureCode } from './solicitation-dispatch'

beforeEach(() => {
  outcome.recordSwitchOutcome.mockClear()
  flow.runWriteWorkflow.mockClear()
})

const payload = (extra: Partial<SyncPayload> = {}): SyncPayload => ({ syncJobId: 'sj1', requestId: 'r1', tenantId: 't1', solicitationBatchId: 'b1', ...extra })

describe('任务分发', () => {
  it('任务类型是 SOLICITATION_SEND', () => {
    expect(SOLICITATION_JOB_TYPES).toEqual(['SOLICITATION_SEND'])
  })

  const deps = (batchRows: number) => {
    const count = vi.fn(async () => batchRows)
    const prisma = { solicitationRequest: { count } } as unknown as PrismaClient
    return { count, deps: { prisma, reliability: { engine: {}, locks: {}, ownerId: 'w1' }, writeWorkflows: { solicitationSend: { kind: 'solicitation.send', steps: [] } } } as never }
  }
  const run = { jobId: 'job-7', priority: 3, lease: null, isLastAttempt: false }

  it('以批次编号 + 队列任务编号为去重键启动流程，意图只含内部编号；成功后登记开关结果', async () => {
    const { deps: d, count } = deps(2)
    expect(await processSolicitation(d, { tenantId: 't1', connection: { id: 'c1' } }, 'sa1', payload(), run)).toEqual({ done: true })
    expect(count).toHaveBeenCalledWith({ where: { tenantId: 't1', sellerAccountId: 'sa1', batchId: 'b1' } })
    const call = flow.runWriteWorkflow.mock.calls[0] as unknown as [unknown, unknown, { kind: string }, Record<string, unknown>]
    expect(call[2].kind).toBe('solicitation.send')
    expect(call[3]).toMatchObject({
      tenantId: 't1',
      dedupeKey: 'solicitation.send:b1:job-7',
      syncJobId: 'sj1',
      intent: { tenantId: 't1', connectionId: 'c1', solicitationBatchId: 'b1' },
    })
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(expect.anything(), 't1', 'sw.solicitation.send', { success: true })
  })

  it('缺批次编号或批次不属于这个店铺：永久失败，不启动流程', async () => {
    const { deps: d } = deps(2)
    await expect(processSolicitation(d, { tenantId: 't1', connection: { id: 'c1' } }, 'sa1', payload({ solicitationBatchId: undefined }), run)).rejects.toMatchObject({
      code: 'SOLICITATION_CONTEXT_MISSING',
    })
    const empty = deps(0)
    const failure = processSolicitation(empty.deps, { tenantId: 't1', connection: { id: 'c1' } }, 'sa1', payload(), run)
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
    await expect(failure).rejects.toMatchObject({ code: 'SOLICITATION_BATCH_NOT_FOUND' })
    expect(flow.runWriteWorkflow).not.toHaveBeenCalled()
  })
})

describe('失败码', () => {
  it('只留“来源 + 状态码”；HTTP_ 开头的运行时分类统一成 SP_API_；开关关闭记 SOL_SWITCH_OFF', () => {
    expect(solicitationFailureCode('SP_API_400_{"errors":[{"message":"buyer text"}]}')).toBe('SP_API_400')
    expect(solicitationFailureCode('HTTP_429')).toBe('SP_API_429')
    expect(solicitationFailureCode('SWITCH_DISABLED')).toBe('SOL_SWITCH_OFF')
    expect(solicitationFailureCode('X'.repeat(100))).toHaveLength(60)
  })
})

describe('永久失败的处置', () => {
  const failing = () => {
    const updateMany = vi.fn(async () => ({ count: 2 }))
    return { db: { solicitationRequest: { updateMany } } as unknown as PrismaClient, updateMany }
  }

  it('这一批还在“处理中”的订单改为发送失败并记失败码（不含亚马逊原文）；调用亚马逊的失败计入开关，授权失效立即关闭', async () => {
    const { db, updateMany } = failing()
    await markSolicitationFailed(db, 't1', payload(), 'SP_API_403_{"errors":[{"message":"nope"}]}')
    expect(updateMany).toHaveBeenCalledWith({ where: { tenantId: 't1', batchId: 'b1', status: 'QUEUED' }, data: { status: 'FAILED', failureCode: 'SP_API_403' } })
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(db, 't1', 'sw.solicitation.send', expect.objectContaining({ success: false, authInvalid: true }))
    outcome.recordSwitchOutcome.mockClear()
    await markSolicitationFailed(db, 't1', payload(), 'SP_API_400_x')
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(db, 't1', 'sw.solicitation.send', expect.objectContaining({ success: false, authInvalid: false }))
    outcome.recordSwitchOutcome.mockClear()
    await markSolicitationFailed(db, 't1', payload(), 'HTTP_401')
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(db, 't1', 'sw.solicitation.send', expect.objectContaining({ authInvalid: true }))
  })

  it('开关关闭、批次缺失等没有调用亚马逊的失败：订单照样改为失败，但不计入开关', async () => {
    const { db, updateMany } = failing()
    await markSolicitationFailed(db, 't1', payload(), 'SWITCH_DISABLED')
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'FAILED', failureCode: 'SOL_SWITCH_OFF' } }))
    await markSolicitationFailed(db, 't1', payload(), 'SOLICITATION_BATCH_NOT_FOUND')
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('载荷没有批次编号时什么也不做；登记开关结果失败不影响订单处置', async () => {
    const { db, updateMany } = failing()
    await markSolicitationFailed(db, 't1', payload({ solicitationBatchId: undefined }), 'SP_API_500_x')
    expect(updateMany).not.toHaveBeenCalled()
    outcome.recordSwitchOutcome.mockRejectedValueOnce(new Error('db down'))
    await expect(markSolicitationFailed(db, 't1', payload(), 'SP_API_500_x')).resolves.toBeUndefined()
    expect(updateMany).toHaveBeenCalledTimes(1)
  })
})
