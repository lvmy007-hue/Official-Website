import { NonRetryableError } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAplusDb } from '../importers/aplus/fake-db.test-helper'
import type { SyncPayload } from '../types'

// A+ 写入任务分发与永久失败的处置（P4-14）：流程以写入记录编号 + 队列任务编号为去重键；成功登记开关结果；记录不存在或已有结论就幂等跳过；
// 开关关闭、请求不完整在发请求之前就不可重试地结束；永久失败后记录置为失败，失败码只留“来源 + 状态码”或 APL_*，只有真正调用了亚马逊的失败才计入开关。

const outcome = vi.hoisted(() => ({ recordSwitchOutcome: vi.fn(async () => ({ autoClosed: [] })) }))
vi.mock('../platform/switch-outcome', () => outcome)
const flow = vi.hoisted(() => ({ runWriteWorkflow: vi.fn(async () => ({ done: true })) }))
vi.mock('../runtime/workflows', () => flow)

import { APLUS_JOB_TYPES, aplusFailureCode, markAplusFailed, processAplusWrite } from './aplus-dispatch'

beforeEach(() => {
  outcome.recordSwitchOutcome.mockClear()
  flow.runWriteWorkflow.mockClear()
})

const payload = (extra: Partial<SyncPayload> = {}): SyncPayload => ({ syncJobId: 'sj1', requestId: 'r1', tenantId: 't1', aplusRunId: 'run1', ...extra })
const row = { tenantId: 't1', connection: { id: 'c1' } }
const run = { jobId: 'job-7', priority: 3, lease: null, isLastAttempt: false }

function setup(options: { switchOn?: boolean; status?: string; kind?: string; requestJson?: unknown; sellerAccountId?: string; noRun?: boolean } = {}) {
  const db = fakeAplusDb()
  if (options.switchOn !== false) db.switches.rows.push({ id: 'sw1', tenantId: 't1', switchKey: 'sw.aplus.submit', sellerAccountId: null, enabled: true })
  if (!options.noRun)
    db.runs.rows.push({
      id: 'run1',
      tenantId: 't1',
      sellerAccountId: options.sellerAccountId ?? 'sa1',
      contentId: 'c1',
      kind: options.kind ?? 'SUBMIT',
      status: options.status ?? 'QUEUED',
      requestJson: options.requestJson ?? {},
    })
  const deps = { prisma: db.prisma, reliability: { engine: {}, locks: {}, ownerId: 'w1' }, writeWorkflows: { aplusWrite: { kind: 'aplus.write', steps: [] } } } as never
  return { ...db, deps }
}

describe('任务分发', () => {
  it('任务类型是 APLUS_WRITE', () => {
    expect(APLUS_JOB_TYPES).toEqual(['APLUS_WRITE'])
  })

  it('以记录编号 + 队列任务编号为去重键启动流程，意图只含内部编号；记录先置为处理中，成功后登记开关结果', async () => {
    const db = setup()
    expect(await processAplusWrite(db.deps, row, 'sa1', payload(), run)).toEqual({ done: true })
    expect(db.runs.rows[0]).toMatchObject({ status: 'RUNNING', failureCode: null })
    const call = flow.runWriteWorkflow.mock.calls[0] as unknown as [unknown, unknown, { kind: string }, Record<string, unknown>]
    expect(call[2].kind).toBe('aplus.write')
    expect(call[3]).toMatchObject({
      tenantId: 't1',
      dedupeKey: 'aplus.write:run1:job-7',
      syncJobId: 'sj1',
      priority: 3,
      isLastAttempt: false,
      owner: 'w1:job-7',
      intent: { tenantId: 't1', connectionId: 'c1', aplusRunId: 'run1' },
    })
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(expect.anything(), 't1', 'sw.aplus.submit', { success: true })
  })

  it('缺记录编号：不可重试的 APL_RUN_CONTEXT_MISSING', async () => {
    const failure = processAplusWrite(setup().deps, row, 'sa1', payload({ aplusRunId: undefined }), run)
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
    await expect(failure).rejects.toMatchObject({ code: 'APL_RUN_CONTEXT_MISSING' })
    expect(flow.runWriteWorkflow).not.toHaveBeenCalled()
  })

  it('记录不存在或属于别的店铺：幂等跳过，不启动流程；记录已有结论（成功、失败）也跳过，不重复调用亚马逊', async () => {
    expect(await processAplusWrite(setup({ noRun: true }).deps, row, 'sa1', payload(), run)).toEqual({ skipped: true, reason: 'RUN_NOT_FOUND' })
    expect(await processAplusWrite(setup({ sellerAccountId: 'sa2' }).deps, row, 'sa1', payload(), run)).toEqual({ skipped: true, reason: 'RUN_NOT_FOUND' })
    for (const status of ['SUCCEEDED', 'FAILED']) {
      const db = setup({ status })
      expect(await processAplusWrite(db.deps, row, 'sa1', payload(), run)).toEqual({ skipped: true, reason: 'RUN_FINISHED', status })
      expect(db.runs.rows[0].status).toBe(status)
    }
    expect(flow.runWriteWorkflow).not.toHaveBeenCalled()
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('写入开关已关闭：APL_SWITCH_OFF（不可重试），记录不变、不启动流程、不计入开关结果', async () => {
    const db = setup({ switchOn: false })
    const failure = processAplusWrite(db.deps, row, 'sa1', payload(), run)
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
    await expect(failure).rejects.toMatchObject({ code: 'APL_SWITCH_OFF' })
    expect(db.runs.rows[0].status).toBe('QUEUED')
    expect(flow.runWriteWorkflow).not.toHaveBeenCalled()
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('请求内容不完整：APL_REQUEST_INVALID，不启动流程', async () => {
    const db = setup({ kind: 'ASSOCIATE', requestJson: { asins: [] } })
    await expect(processAplusWrite(db.deps, row, 'sa1', payload(), run)).rejects.toMatchObject({ code: 'APL_REQUEST_INVALID' })
    expect(flow.runWriteWorkflow).not.toHaveBeenCalled()
  })

  it('流程失败原样抛出，不在这里收尾（由监听器调用 markAplusFailed），也不登记开关结果', async () => {
    const db = setup()
    flow.runWriteWorkflow.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'SP_API_500' }))
    await expect(processAplusWrite(db.deps, row, 'sa1', payload(), run)).rejects.toThrow('boom')
    expect(db.runs.rows[0].status).toBe('RUNNING')
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })
})

describe('失败码', () => {
  it('只留“来源 + 状态码”；HTTP_ 开头的运行时分类统一成 SP_API_；开关关闭记 APL_SWITCH_OFF；APL_* 原样保留', () => {
    expect(aplusFailureCode('SP_API_400_{"errors":[{"message":"seller text"}]}')).toBe('SP_API_400')
    expect(aplusFailureCode('HTTP_429')).toBe('SP_API_429')
    expect(aplusFailureCode('SWITCH_DISABLED')).toBe('APL_SWITCH_OFF')
    expect(aplusFailureCode('APL_FILE_MISSING')).toBe('APL_FILE_MISSING')
    expect(aplusFailureCode('X'.repeat(100))).toHaveLength(60)
  })
})

describe('永久失败的处置', () => {
  it('调用亚马逊失败：记录置为失败（带失败码与结束时间），计入开关的失败；403 会让开关立即关闭', async () => {
    const db = setup({ status: 'RUNNING' })
    await markAplusFailed(db.prisma, 't1', payload(), 'SP_API_400_{"message":"secret"}')
    expect(db.runs.rows[0]).toMatchObject({ status: 'FAILED', failureCode: 'SP_API_400' })
    expect(db.runs.rows[0].finishedAt).toBeInstanceOf(Date)
    expect(outcome.recordSwitchOutcome).toHaveBeenLastCalledWith(db.prisma, 't1', 'sw.aplus.submit', { success: false, errorCode: 'SP_API_400_{"message":"secret"}'.slice(0, 40), authInvalid: false })
    const forbidden = setup({ status: 'RUNNING' })
    await markAplusFailed(forbidden.prisma, 't1', payload(), 'HTTP_403')
    expect(outcome.recordSwitchOutcome).toHaveBeenLastCalledWith(forbidden.prisma, 't1', 'sw.aplus.submit', { success: false, errorCode: 'HTTP_403', authInvalid: true })
    expect(forbidden.runs.rows[0].failureCode).toBe('SP_API_403')
  })

  it('没有真正调用亚马逊的失败（开关关闭、文件缺失、请求不完整、授权缺角色）不计入开关', async () => {
    for (const code of ['SWITCH_DISABLED', 'APL_SWITCH_OFF', 'APL_FILE_MISSING', 'APL_REQUEST_INVALID', 'APL_KEY_MISSING', 'APL_UPLOAD_FAILED']) {
      const db = setup({ status: 'QUEUED' })
      await markAplusFailed(db.prisma, 't1', payload(), code)
      expect(db.runs.rows[0]).toMatchObject({ status: 'FAILED', failureCode: aplusFailureCode(code) })
    }
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('已有结论的记录、不存在的记录、没有记录编号的任务：什么也不改', async () => {
    const done = setup({ status: 'SUCCEEDED' })
    await markAplusFailed(done.prisma, 't1', payload(), 'SP_API_500')
    expect(done.runs.rows[0]).toMatchObject({ status: 'SUCCEEDED' })
    expect(done.runs.rows[0].failureCode).toBeUndefined()
    await markAplusFailed(setup({ noRun: true }).prisma, 't1', payload(), 'SP_API_500')
    await markAplusFailed(setup().prisma, 't1', payload({ aplusRunId: undefined }), 'SP_API_500')
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })
})
