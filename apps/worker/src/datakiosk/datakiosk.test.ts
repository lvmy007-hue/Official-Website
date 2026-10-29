import { PassThrough, Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { NonRetryableError, RetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataKiosk, DATA_KIOSK_MAX_QUERY_CHARS, DATA_KIOSK_RETENTION_DAYS, compactQuery } from '../connectors/datakiosk'
import type { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import type { RowOutcome } from '../streaming/batch'
import type { RawFileHandle } from '../streaming/raw-files'
import { readLines } from '../streaming/rows'
import type { ImportContext } from '../types'
import { KIOSK_MAX_WAIT_MS, runDataKioskQuery, type KioskCheckpoint, type KioskCheckpointStore } from './executor'
import { clearDataKioskDatasetsForTest, registerDataKioskDataset } from './registry'

// 数据中心：连接器（提交、轮询、取文档）与查询执行器（多次短调用的状态机、流式落库、分页、失败处置、30 天留存提醒）。

const NOW = new Date('2026-09-20T12:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }

describe('数据中心连接器', () => {
  const fakeClient = (responses: Array<Record<string, unknown>>) => {
    const request = vi.fn(async () => responses.shift() ?? {})
    return { client: { request } as unknown as AmazonSpApiClient, request }
  }

  it('提交查询：压缩空白后 POST，返回查询编号；空查询、超过 8000 字符的查询在本地拒绝，不浪费一次限速额度', async () => {
    const { client, request } = fakeClient([{ queryId: 'q-1' }])
    const kiosk = new DataKiosk(client)
    expect(await kiosk.createQuery('{\n  salesAndTrafficByDate(startDate: "2026-09-01")   { date }\n}', undefined)).toBe('q-1')
    expect(request).toHaveBeenCalledWith({ method: 'POST', path: '/dataKiosk/2023-11-15/queries', body: { query: '{ salesAndTrafficByDate(startDate: "2026-09-01") { date } }' } })
    await expect(kiosk.createQuery('   ')).rejects.toThrow('DATA_KIOSK_QUERY_EMPTY')
    await expect(kiosk.createQuery('x'.repeat(DATA_KIOSK_MAX_QUERY_CHARS + 1))).rejects.toThrow('DATA_KIOSK_QUERY_TOO_LONG')
    expect(request).toHaveBeenCalledTimes(1)
    expect(compactQuery(`a${' '.repeat(20)}b`)).toBe('a b')
  })

  it('下一页：把上一页返回的分页令牌带上；响应没有查询编号时报错', async () => {
    const { client, request } = fakeClient([{ queryId: 'q-2' }, {}])
    const kiosk = new DataKiosk(client)
    await kiosk.createQuery('{ a }', 'token-1')
    expect((request.mock.calls[0] as unknown[])[0]).toMatchObject({ body: { query: '{ a }', paginationToken: 'token-1' } })
    await expect(kiosk.createQuery('{ a }')).rejects.toThrow('DATA_KIOSK_QUERY_ID_NOT_RETURNED')
  })

  it('查询状态：映射处理状态、数据文档、错误文档、分页令牌', async () => {
    const { client, request } = fakeClient([
      { queryId: 'q-1', processingStatus: 'DONE', dataDocumentId: 'd-1', pagination: { nextToken: 'n-1' } },
      { queryId: 'q-1', processingStatus: 'FATAL', errorDocumentId: 'e-1' },
      { queryId: 'q-1' },
    ])
    const kiosk = new DataKiosk(client)
    expect(await kiosk.getQuery('q-1')).toEqual({ queryId: 'q-1', processingStatus: 'DONE', dataDocumentId: 'd-1', errorDocumentId: undefined, nextToken: 'n-1' })
    expect(await kiosk.getQuery('q-1')).toMatchObject({ processingStatus: 'FATAL', errorDocumentId: 'e-1' })
    expect((await kiosk.getQuery('q-1')).processingStatus).toBe('IN_QUEUE')
    expect((request.mock.calls[0] as unknown[])[0]).toEqual({ path: '/dataKiosk/2023-11-15/queries/q-1' })
  })

  describe('取文档', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
    afterEach(() => vi.unstubAllGlobals())

    it('先换取 5 分钟有效的文档地址，再流式下载；压缩内容自动解压，原始字节同时写入对象存储', async () => {
      const lines = '{"a":1}\n{"a":2}\n'
      const compressed = gzipSync(Buffer.from(lines))
      vi.mocked(fetch).mockResolvedValue(new Response(compressed, { status: 200 }))
      const { client, request } = fakeClient([{ documentId: 'd-1', documentUrl: 'https://example.invalid/doc' }])
      const sink = new PassThrough()
      const stored: Buffer[] = []
      sink.on('data', chunk => stored.push(chunk))
      const stream = await new DataKiosk(client).openDocument('d-1', { sink })
      const out: string[] = []
      for await (const line of readLines(stream)) out.push(line)
      expect(out).toEqual(['{"a":1}', '{"a":2}'])
      expect(Buffer.concat(stored).equals(compressed)).toBe(true)
      expect((request.mock.calls[0] as unknown[])[0]).toEqual({ path: '/dataKiosk/2023-11-15/documents/d-1' })
    })

    it('没有文档地址、下载失败都明确报错（下载失败带状态码，交给重试判断）', async () => {
      const missing = fakeClient([{ documentId: 'd-1' }])
      await expect(new DataKiosk(missing.client).openDocument('d-1')).rejects.toThrow('DATA_KIOSK_DOCUMENT_URL_MISSING')
      vi.mocked(fetch).mockResolvedValue(new Response('gone', { status: 403 }))
      const denied = fakeClient([{ documentUrl: 'https://example.invalid/doc' }])
      await expect(new DataKiosk(denied.client).openDocument('d-1')).rejects.toMatchObject({ status: 403, source: 'download' })
    })
  })
})

type Row = Record<string, unknown>
const jsonl = (rows: Row[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const streamOf = (text: string) => Readable.from([Buffer.from(text)])

function context(): { ctx: ImportContext; warn: ReturnType<typeof vi.fn> } {
  const prisma: PrismaClient = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) } as unknown as PrismaClient
  const warn = vi.fn()
  return { ctx: { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }, warn }
}

function memoryCheckpoint(initial: KioskCheckpoint | null = null) {
  let value = initial
  const store: KioskCheckpointStore = { read: () => value, write: async next => void (value = next) }
  return { store, get: () => value }
}

function fakeKiosk(plan: { statuses: Array<Record<string, unknown>>; documents?: Record<string, string> }) {
  const created: Array<{ query: string; token?: string }> = []
  return {
    created,
    kiosk: {
      createQuery: vi.fn(async (query: string, token?: string) => {
        created.push({ query, token })
        return `query-${created.length}`
      }),
      getQuery: vi.fn(async (queryId: string) => ({ queryId, ...(plan.statuses.shift() ?? { processingStatus: 'IN_PROGRESS' }) }) as never),
      openDocument: vi.fn(async (documentId: string) => streamOf(plan.documents?.[documentId] ?? '')),
    },
  }
}

function fakeRaw() {
  const complete = vi.fn(async () => undefined)
  const discard = vi.fn(async () => undefined)
  const handle: RawFileHandle = { sink: new PassThrough(), complete, discard }
  return { openRawFile: vi.fn(() => handle), complete, discard }
}

const handled: Row[] = []
beforeEach(() => {
  handled.length = 0
  clearDataKioskDatasetsForTest()
  registerDataKioskDataset({
    id: 'TEST_SALES',
    reportType: 'DATA_KIOSK_TEST_SALES',
    buildQuery: params => `{ sales(start: "${params.startDate}", end: "${params.endDate}") { date amount } }`,
    handle: async (_ctx, row): Promise<RowOutcome> => {
      handled.push(row)
      return row.date ? 'imported' : 'ignored'
    },
  })
})

const task = { dataset: 'TEST_SALES', params: { startDate: '2026-09-01', endDate: '2026-09-07' }, syncJobId: 'job-1' }

describe('数据中心查询执行器', () => {
  it('数据集没有注册导入器：不可重试错误，不调用接口', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [] })
    await expect(runDataKioskQuery(ctx, kiosk, scope, { ...task, dataset: 'NOPE' }, memoryCheckpoint().store, () => NOW)).rejects.toMatchObject({ code: 'DATA_KIOSK_DATASET_NOT_REGISTERED' })
    expect(kiosk.createQuery).not.toHaveBeenCalled()
  })

  it('第 1 次调用只提交查询并记下查询编号；仍在排队或运行时继续等待，不导入任何数据', async () => {
    const { ctx } = context()
    const { kiosk, created } = fakeKiosk({ statuses: [{ processingStatus: 'IN_QUEUE' }, { processingStatus: 'IN_PROGRESS' }] })
    const checkpoint = memoryCheckpoint()
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toEqual({ pending: true, page: 1 })
    expect(created[0].query).toBe('{ sales(start: "2026-09-01", end: "2026-09-07") { date amount } }')
    expect(checkpoint.get()).toMatchObject({ queryId: 'query-1', page: 1, submittedAt: NOW.toISOString() })
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toEqual({ pending: true, page: 1 })
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toEqual({ pending: true, page: 1 })
    expect(kiosk.createQuery).toHaveBeenCalledTimes(1)
    expect(handled).toHaveLength(0)
  })

  it('查询完成：逐行解析 JSONL 分批落库，登记原始文件，清掉断点，并带 30 天留存提醒', async () => {
    const { ctx } = context()
    const raw = fakeRaw()
    const { kiosk } = fakeKiosk({
      statuses: [{ processingStatus: 'DONE', dataDocumentId: 'doc-1' }],
      documents: { 'doc-1': jsonl([{ date: '2026-09-01', amount: 10 }, { amount: 5 }, { date: '2026-09-02', amount: 12 }]) },
    })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0, submittedAt: NOW.toISOString() })
    const result = await runDataKioskQuery({ ...ctx, openRawFile: raw.openRawFile }, kiosk, scope, task, checkpoint.store, () => NOW)
    expect(result).toMatchObject({ done: true, imported: 2, read: 3, pages: 1, retentionDays: DATA_KIOSK_RETENTION_DAYS })
    expect((result as { retentionExpiresAt: string }).retentionExpiresAt).toBe('2026-10-20T12:00:00.000Z')
    expect((result as { retentionWarning: string }).retentionWarning).toContain('30 天')
    expect(handled).toEqual([{ date: '2026-09-01', amount: 10 }, { amount: 5 }, { date: '2026-09-02', amount: 12 }])
    expect(raw.openRawFile).toHaveBeenCalledWith({ tenantId: 't1', domain: 'datakiosk', name: 'TEST_SALES-query-1.raw' })
    expect(raw.complete).toHaveBeenCalledWith({
      storeKey: 'sa1',
      sellerAccountId: 'sa1',
      sourceKey: 'datakiosk:job-1:1',
      reportType: 'DATA_KIOSK_TEST_SALES',
      reportId: 'query-1',
      rowCount: 3,
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-07'),
    })
    expect(raw.discard).not.toHaveBeenCalled()
    expect(checkpoint.get()).toBeNull()
  })

  it('结果有下一页：记下分页令牌，下一次调用用该令牌提交下一页；各页行数累计', async () => {
    const { ctx } = context()
    const { kiosk, created } = fakeKiosk({
      statuses: [
        { processingStatus: 'DONE', dataDocumentId: 'doc-1', nextToken: 'page-2-token' },
        { processingStatus: 'DONE', dataDocumentId: 'doc-2' },
      ],
      documents: { 'doc-1': jsonl([{ date: '2026-09-01' }, { date: '2026-09-02' }]), 'doc-2': jsonl([{ date: '2026-09-03' }]) },
    })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0, submittedAt: NOW.toISOString() })
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toEqual({ pending: true, page: 2 })
    expect(checkpoint.get()).toEqual({ page: 2, paginationToken: 'page-2-token', imported: 2, read: 2 })
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toEqual({ pending: true, page: 2 })
    expect(created[0].token).toBe('page-2-token')
    const final = await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)
    expect(final).toMatchObject({ done: true, imported: 3, read: 3, pages: 2 })
  })

  it('完成但没有数据文档：时间范围内确实没有数据，不是错误', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'DONE' }] })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0 })
    expect(await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).toMatchObject({ done: true, imported: 0, read: 0, pages: 1 })
    expect(kiosk.openDocument).not.toHaveBeenCalled()
  })

  it('查询失败：读取错误文档，不可重试错误结束并清掉断点（同样的查询重试不会成功）', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'FATAL', errorDocumentId: 'err-1' }], documents: { 'err-1': '{"errors":[{"message":"Unknown field salez"}]}' } })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0 })
    const failure = await runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW).catch(error => error)
    expect(failure).toBeInstanceOf(NonRetryableError)
    expect(failure).toMatchObject({ code: 'DATA_KIOSK_QUERY_FATAL' })
    expect(failure.message).toContain('Unknown field salez')
    expect(checkpoint.get()).toBeNull()
  })

  it('查询被取消：可重试，下次重新提交（断点里去掉查询编号但保留已导入的累计）', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'CANCELLED' }] })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 2, imported: 5, read: 5, paginationToken: 't' })
    await expect(runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).rejects.toBeInstanceOf(RetryableError)
    expect(checkpoint.get()).toMatchObject({ queryId: undefined, page: 2, imported: 5, paginationToken: 't' })
  })

  it('等待超过 6 小时：可重试，放弃当前查询重新提交', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'IN_PROGRESS' }] })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0, submittedAt: new Date(NOW.getTime() - KIOSK_MAX_WAIT_MS - 1000).toISOString() })
    await expect(runDataKioskQuery(ctx, kiosk, scope, task, checkpoint.store, () => NOW)).rejects.toMatchObject({ code: 'DATA_KIOSK_QUERY_TIMEOUT' })
    expect(checkpoint.get()?.queryId).toBeUndefined()
  })

  it('读到了数据但一行都没导入：字段与导入器预期不符，不可重试，丢弃已写入的原始文件', async () => {
    const { ctx } = context()
    const raw = fakeRaw()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'DONE', dataDocumentId: 'doc-1' }], documents: { 'doc-1': jsonl([{ amount: 1 }, { amount: 2 }]) } })
    const checkpoint = memoryCheckpoint({ queryId: 'query-1', page: 1, imported: 0, read: 0 })
    await expect(runDataKioskQuery({ ...ctx, openRawFile: raw.openRawFile }, kiosk, scope, task, checkpoint.store, () => NOW)).rejects.toMatchObject({ code: 'DATA_KIOSK_ROWS_NOT_IMPORTED' })
    expect(raw.discard).toHaveBeenCalledTimes(1)
    expect(raw.complete).not.toHaveBeenCalled()
    expect(checkpoint.get()).not.toBeNull()
  })

  it('官方将来新增的未知查询状态：不可重试，明确报出状态值', async () => {
    const { ctx } = context()
    const { kiosk } = fakeKiosk({ statuses: [{ processingStatus: 'PAUSED' }] })
    await expect(runDataKioskQuery(ctx, kiosk, scope, task, memoryCheckpoint({ queryId: 'q', page: 1, imported: 0, read: 0 }).store, () => NOW)).rejects.toMatchObject({
      code: 'DATA_KIOSK_STATUS_UNKNOWN',
    })
  })
})
