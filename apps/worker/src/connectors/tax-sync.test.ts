import { SALES_TAX_REPORT_TYPE, TAX_NOT_GENERATED, TAX_ROLE_PENDING } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from './http-error'
import { ReportListApi, parseReportRefs } from './report-retrieval'
import { syncSalesTax } from './tax-dispatch'

// 销售税报告同步（R-33，P2b-12）：检索（不能申请）→ 去重 → 逐份导入；403 与“一份都没有”用专用失败码结束。
// 下载与解析（importReportDocument）有自己的测试，这里替换掉，只验证检索与失败码逻辑。

const mocks = vi.hoisted(() => ({ importReportDocument: vi.fn(), reportImporterFor: vi.fn() }))
vi.mock('./report-import', () => ({ importReportDocument: mocks.importReportDocument, reportImporterFor: mocks.reportImporterFor }))

const now = new Date('2026-10-23T00:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const report = (id: string, end: string) => ({
  reportId: id,
  reportType: SALES_TAX_REPORT_TYPE,
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
  const listDone = vi.fn(async (_since: Date, _token?: string) => {
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
  return { ctx: { prisma, logger }, job, listDone, api: { listDone } }
}
const client = { openReportDocument: vi.fn() }

beforeEach(() => {
  mocks.importReportDocument.mockReset().mockResolvedValue({ imported: 30, read: 30, downloadUrl: 'https://x' })
  mocks.reportImporterFor.mockReset().mockReturnValue(async () => ({ imported: 0, read: 0, skipped: 0 }))
})

describe('列出报告', () => {
  it('请求只列已生成（DONE）的销售税报告类型，往回看 90 天；翻页只带 nextToken', async () => {
    const request = vi.fn().mockResolvedValue({})
    const api = new ReportListApi({ request }, SALES_TAX_REPORT_TYPE)
    await api.listDone(new Date('2026-07-25T00:00:00Z'))
    await api.listDone(new Date('2026-07-25T00:00:00Z'), 'tok')
    expect(request.mock.calls[0]![0]).toMatchObject({
      path: '/reports/2021-06-30/reports',
      query: { reportTypes: SALES_TAX_REPORT_TYPE, processingStatuses: 'DONE', createdSince: '2026-07-25T00:00:00.000Z' },
    })
    expect(request.mock.calls[1]![0].query).toEqual({ nextToken: 'tok' })
  })

  it('只取指定类型且有报告与文档编号的条目：结算报告混进来也不当成销售税报告', () => {
    const parsed = parseReportRefs(
      { reports: [report('r1', '2026-09-15T00:00:00Z'), { ...report('r2', '2026-09-15T00:00:00Z'), reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' }, { reportId: 'r3' }] },
      SALES_TAX_REPORT_TYPE,
    )
    expect(parsed.reports.map(item => item.reportId)).toEqual(['r1'])
    expect(parsed.skipped).toBe(2)
  })
})

describe('销售税同步', () => {
  it('新报告按结束时间从早到晚导入，按销售税报告类型建报告任务与选导入器', async () => {
    const { ctx, api, job } = setup([{ reports: [report('r2', '2026-10-01T00:00:00Z')], nextToken: 'n1' }, { reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    const result = await syncSalesTax(ctx, api, client, scope, { now })
    expect(job.create.mock.calls.map(call => call[0].data)).toEqual([
      expect.objectContaining({ externalReportId: 'r1', reportType: SALES_TAX_REPORT_TYPE, requestId: 'tax-sync', tenantId: 't1', sellerAccountId: 'sa1' }),
      expect.objectContaining({ externalReportId: 'r2', reportType: SALES_TAX_REPORT_TYPE }),
    ])
    expect(mocks.reportImporterFor).toHaveBeenCalledWith(expect.objectContaining({ reportType: SALES_TAX_REPORT_TYPE }), expect.objectContaining({ tenantId: 't1', sellerAccountId: 'sa1' }))
    expect(job.update).toHaveBeenCalledWith({ where: { id: 'job-r1' }, data: expect.objectContaining({ status: 'READY', failureCode: null }) })
    expect(result).toMatchObject({ listed: 2, imported: 2, rows: 60, failed: 0 })
  })

  it('已导入成功（READY）的报告不再下载，也不算“没有报告”：同步成功结束', async () => {
    const { ctx, api } = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }], [{ id: 'job-1', externalReportId: 'r1', status: 'READY' }])
    const result = await syncSalesTax(ctx, api, client, scope, { now })
    expect(mocks.importReportDocument).not.toHaveBeenCalled()
    expect(result).toMatchObject({ listed: 1, imported: 0 })
  })

  it('最近 90 天一份报告都没有：以不可重试的 TAX_NOT_GENERATED 结束（页面写“需在卖家后台税务文档库先生成”）', async () => {
    const { ctx, api, job } = setup([{ reports: [] }])
    const failure = await syncSalesTax(ctx, api, client, scope, { now }).catch(error => error)
    expect(failure).toBeInstanceOf(NonRetryableError)
    expect(failure).toMatchObject({ code: TAX_NOT_GENERATED })
    expect(job.create).not.toHaveBeenCalled()
  })

  it('403（受限角色“税务汇缴”未获批）：以不可重试的 TAX_ROLE_PENDING 结束，一份都不导入', async () => {
    const { ctx, api } = setup([new UpstreamHttpError('SP_API_403', 403, new Headers(), 'api')])
    const failure = await syncSalesTax(ctx, api, client, scope, { now }).catch(error => error)
    expect(failure).toMatchObject({ code: TAX_ROLE_PENDING })
    expect(mocks.importReportDocument).not.toHaveBeenCalled()
  })

  it('下载时被拒绝（403）同样按角色未批处理；限流等其它上游错误原样抛出交给任务运行时重试', async () => {
    mocks.importReportDocument.mockRejectedValueOnce(new UpstreamHttpError('SP_API_403', 403, new Headers(), 'api'))
    const denied = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    await expect(syncSalesTax(denied.ctx, denied.api, client, scope, { now })).rejects.toMatchObject({ code: TAX_ROLE_PENDING })

    mocks.importReportDocument.mockRejectedValueOnce(new UpstreamHttpError('SP_API_429', 429, new Headers(), 'api'))
    const throttled = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    await expect(syncSalesTax(throttled.ctx, throttled.api, client, scope, { now })).rejects.toBeInstanceOf(UpstreamHttpError)
  })

  it('某份报告格式不对：标记失败、继续下一份，其余成功就不让任务失败；全部失败才抛出', async () => {
    mocks.importReportDocument.mockRejectedValueOnce(new Error('PARSE_HEADER')).mockResolvedValue({ imported: 5, read: 5, downloadUrl: undefined })
    const some = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z'), report('r2', '2026-10-01T00:00:00Z')] }])
    const result = await syncSalesTax(some.ctx, some.api, client, scope, { now })
    expect(some.job.update).toHaveBeenCalledWith({ where: { id: 'job-r1' }, data: expect.objectContaining({ status: 'FAILED', failureCode: 'PARSE_HEADER' }) })
    expect(result).toMatchObject({ imported: 1, failed: 1 })

    mocks.importReportDocument.mockReset().mockRejectedValue(new Error('PARSE_HEADER'))
    const all = setup([{ reports: [report('r1', '2026-09-15T00:00:00Z')] }])
    await expect(syncSalesTax(all.ctx, all.api, client, scope, { now })).rejects.toThrow('PARSE_HEADER')
  })
})
