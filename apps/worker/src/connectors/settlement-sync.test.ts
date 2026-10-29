import { SETTLEMENT_REPORT_TYPE } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from './http-error'
import { parseReportList } from './settlement-api'
import { syncSettlements } from './settlement-dispatch'

// 结算报告同步：列出 → 去重 → 逐份导入 → 导入后核对。下载与解析（importReportDocument）、核对（reconcileTenant）各有自己的测试，这里替换掉，只验证调度逻辑。
const mocks = vi.hoisted(() => ({ importReportDocument: vi.fn(), reconcileTenant: vi.fn() }))
vi.mock('./report-import', () => ({ importReportDocument: mocks.importReportDocument, reportImporterFor: vi.fn(() => async () => ({ imported: 0, read: 0, skipped: 0 })) }))
vi.mock('../settlements/run', () => ({ reconcileTenant: mocks.reconcileTenant }))

const now = new Date('2026-10-23T00:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const report = (id: string, end: string) => ({
  reportId: id,
  reportType: SETTLEMENT_REPORT_TYPE,
  reportDocumentId: `doc-${id}`,
  dataStartTime: '2026-09-01T00:00:00Z',
  dataEndTime: end,
  processingStatus: 'DONE',
})

function setup(pages: unknown[], existing: Array<{ id: string; externalReportId: string; status: string }> = []) {
  const job = {
    findMany: vi.fn(async () => existing),
    create: vi.fn(async (args: { data: { externalReportId: string } }) => ({ id: `job-${args.data.externalReportId}`, externalReportId: args.data.externalReportId, status: 'PENDING' })),
    update: vi.fn(async () => ({})),
  }
  const prisma = { fbaReportJob: job } as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const queue = [...pages]
  const listDone = vi.fn(async (_since: Date, _token?: string) => queue.shift())
  return { ctx: { prisma, logger }, job, listDone, api: { listDone } }
}
const client = { openReportDocument: vi.fn() }

beforeEach(() => {
  mocks.importReportDocument.mockReset().mockResolvedValue({ imported: 12, read: 12, downloadUrl: 'https://x' })
  mocks.reconcileTenant.mockReset().mockResolvedValue({ settlements: 2, matched: 1, discrepancy: 1, pending: 0, errors: [] })
})

describe('解析报告列表', () => {
  it('只取结算报告类型且有报告与文档编号的条目，其余计数跳过；nextToken 单独取出', () => {
    const parsed = parseReportList({
      reports: [report('r1', '2026-09-15T00:00:00Z'), { ...report('r2', '2026-09-15T00:00:00Z'), reportType: 'OTHER' }, { reportId: 'r3' }],
      nextToken: 'next',
    })
    expect(parsed.reports).toEqual([{ reportId: 'r1', documentId: 'doc-r1', dataStart: new Date('2026-09-01T00:00:00Z'), dataEnd: new Date('2026-09-15T00:00:00Z') }])
    expect(parsed.skipped).toBe(2)
    expect(parsed.nextToken).toBe('next')
  })

  it('响应被 payload 包着也能解析；空响应不报错', () => {
    expect(parseReportList({ payload: { reports: [report('r1', '2026-09-15T00:00:00Z')] } }).reports).toHaveLength(1)
    expect(parseReportList(null)).toEqual({ reports: [], skipped: 0, nextToken: null })
  })
})

describe('结算报告同步', () => {
  it('翻页只带 nextToken；新报告按结束时间从早到晚导入，导入后核对该店铺', async () => {
    const { ctx, api, listDone, job } = setup([{ reports: [report('r2', '2026-10-01T00:00:00Z')], nextToken: 'n1' }, { reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    const result = await syncSettlements(ctx, api, client, scope, { now })
    expect(listDone.mock.calls.map(call => call[1])).toEqual([undefined, 'n1'])
    expect(listDone.mock.calls[0]![0]).toEqual(new Date('2026-07-25T00:00:00Z')) // 往回 90 天
    expect(job.create.mock.calls.map(call => call[0].data.externalReportId)).toEqual(['r1', 'r2'])
    expect(job.update).toHaveBeenCalledWith({ where: { id: 'job-r1' }, data: expect.objectContaining({ status: 'READY', failureCode: null }) })
    expect(result).toMatchObject({ listed: 2, imported: 2, rows: 24, failed: 0 })
    expect(mocks.reconcileTenant).toHaveBeenCalledWith(ctx.prisma, 't1', now, 'sa1')
  })

  it('已导入成功（READY）的报告不再下载；全都已导入时也不重复核对', async () => {
    const { ctx, api } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }], [{ id: 'job-1', externalReportId: 'r1', status: 'READY' }])
    const result = await syncSettlements(ctx, api, client, scope, { now })
    expect(mocks.importReportDocument).not.toHaveBeenCalled()
    expect(mocks.reconcileTenant).not.toHaveBeenCalled()
    expect(result).toMatchObject({ listed: 1, imported: 0, reconcile: null })
  })

  it('上次失败的报告沿用原记录重试，不新建', async () => {
    const { ctx, api, job } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }], [{ id: 'job-old', externalReportId: 'r1', status: 'FAILED' }])
    await syncSettlements(ctx, api, client, scope, { now })
    expect(job.create).not.toHaveBeenCalled()
    expect(job.update).toHaveBeenCalledWith({ where: { id: 'job-old' }, data: expect.objectContaining({ status: 'READY' }) })
  })

  it('某份报告解析失败：标记失败、继续下一份，其余成功就不让任务失败', async () => {
    mocks.importReportDocument.mockRejectedValueOnce(new Error('PARSE_HEADER')).mockResolvedValue({ imported: 5, read: 5, downloadUrl: undefined })
    const { ctx, api, job } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z'), report('r2', '2026-10-01T00:00:00Z')] }])
    const result = await syncSettlements(ctx, api, client, scope, { now })
    expect(job.update).toHaveBeenCalledWith({ where: { id: 'job-r1' }, data: expect.objectContaining({ status: 'FAILED', failureCode: 'PARSE_HEADER' }) })
    expect(result).toMatchObject({ imported: 1, failed: 1 })
  })

  it('全部报告都失败：抛出第一份的错误', async () => {
    mocks.importReportDocument.mockRejectedValue(new Error('PARSE_HEADER'))
    const { ctx, api } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    await expect(syncSettlements(ctx, api, client, scope, { now })).rejects.toThrow('PARSE_HEADER')
    expect(mocks.reconcileTenant).not.toHaveBeenCalled()
  })

  it('上游错误（限流、授权）原样抛出交给任务运行时重试，不当成这份报告的问题继续', async () => {
    mocks.importReportDocument.mockRejectedValue(new UpstreamHttpError('SP_API_429', 429, new Headers(), 'api'))
    const { ctx, api } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z'), report('r2', '2026-10-01T00:00:00Z')] }])
    await expect(syncSettlements(ctx, api, client, scope, { now })).rejects.toBeInstanceOf(UpstreamHttpError)
    expect(mocks.importReportDocument).toHaveBeenCalledTimes(1)
  })

  it('没有任何结算报告：不查库也不核对', async () => {
    const { ctx, api, job } = setup([{ reports: [] }])
    const result = await syncSettlements(ctx, api, client, scope, { now })
    expect(job.findMany).not.toHaveBeenCalled()
    expect(result).toMatchObject({ listed: 0, imported: 0, reconcile: null })
  })
})
