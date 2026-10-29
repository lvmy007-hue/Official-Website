import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { LocalDiskStorage, deriveSigningKey, TenantObjectStore } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importReportDocument } from '../connectors/report-import'
import { decodeStream } from './download'
import { createRawFileOpener } from './raw-files'
import { readLines, tsvRows } from './rows'
import { importRows } from './batch'

// 原始文件留存（P1-23）：真实的本地存储 + 记录型的数据库替身。

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map(entry => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]))))).flat()
}
const dataFiles = async (root: string) => (await filesUnder(path.join(root, 'tenants'))).length

describe('原始报告文件留存', () => {
  let root: string
  let storage: LocalDiskStorage
  let table: Array<Record<string, unknown>>
  let tenantPolicy: unknown = null
  let prisma: PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const text = ['order-id\tamount', ...Array.from({ length: 500 }, (_, index) => `111-${index}\t${index}.5`)].join('\n')
  const record = { storeKey: 'sa1', sellerAccountId: 'sa1', sourceKey: 'report:rj1', reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nova-raw-'))
    storage = new LocalDiskStorage({ rootDir: root, signingKey: deriveSigningKey('s'.repeat(40)), publicBaseUrl: 'http://x' })
    table = []
    tenantPolicy = null
    prisma = {
      tenantSetting: { findFirst: vi.fn(async () => (tenantPolicy === null ? null : { valueJson: tenantPolicy })) },
      rawReportFile: {
        findUnique: vi.fn(
          async ({ where }: { where: { tenantId_storeKey_sha256: { tenantId: string; storeKey: string; sha256: string } } }) =>
            table.find(
              row => row.tenantId === where.tenantId_storeKey_sha256.tenantId && row.storeKey === where.tenantId_storeKey_sha256.storeKey && row.sha256 === where.tenantId_storeKey_sha256.sha256,
            ) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          table.push(data)
          return data
        }),
      },
    } as unknown as PrismaClient
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const opener = (now = () => new Date('2026-09-01T00:00:00Z')) => createRawFileOpener({ storage, prisma, logger, retentionDays: 400, now })

  async function importThrough(raw: ReturnType<ReturnType<typeof opener>>, compressed: Buffer) {
    const stream = decodeStream(Readable.from([compressed]), { compression: 'auto', sink: raw!.sink })
    const result = await importRows({ prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as PrismaClient, logger }, tsvRows(readLines(stream)), async () => 'imported')
    return result
  }

  it('导入成功：原始字节（压缩状态）落对象存储并登记路径、大小、摘要、行数与保留期限', async () => {
    const compressed = gzipSync(Buffer.from(text))
    const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'rj1-orders.raw' })!
    const result = await importThrough(raw, compressed)
    await raw.complete({ ...record, rowCount: result.read })
    expect(table).toHaveLength(1)
    const row = table[0]
    expect(row).toMatchObject({ tenantId: 't1', storeKey: 'sa1', sourceKey: 'report:rj1', rowCount: 500, sizeBytes: BigInt(compressed.length) })
    expect(String(row.objectKey)).toMatch(/^tenants\/t1\/reports\/2026\/09\/01\/[0-9a-f-]{36}-rj1-orders\.raw$/)
    expect((row.retentionUntil as Date).toISOString().slice(0, 10)).toBe('2027-10-06') // 2026-09-01 + 400 天
    // 对象存储里的内容就是下载的原始字节
    const chunks: Buffer[] = []
    for await (const chunk of await new TenantObjectStore(storage, 't1').read(String(row.objectKey))) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).equals(compressed)).toBe(true)
  })

  it('企业在设置里改了原始报告保留天数：新保存的文件按企业的天数；没改过的企业仍用部署默认', async () => {
    tenantPolicy = { rawReportDays: 90, exportFileDays: 7, customerInfoDays: 30 }
    const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'custom.raw' })!
    const result = await importThrough(raw, gzipSync(Buffer.from(text)))
    await raw.complete({ ...record, rowCount: result.read })
    expect((table[0].retentionUntil as Date).toISOString().slice(0, 10)).toBe('2026-11-30') // 2026-09-01 + 90 天
  })

  it('同店铺内容相同的文件只登记一次：多出来的新文件被删除', async () => {
    const compressed = gzipSync(Buffer.from(text))
    for (let round = 0; round < 2; round += 1) {
      const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'again.raw' })!
      const result = await importThrough(raw, compressed)
      await raw.complete({ ...record, rowCount: result.read })
    }
    expect(table).toHaveLength(1)
    expect(await dataFiles(root)).toBe(1)
  })

  it('导入失败：丢弃已写入的文件，不登记', async () => {
    const compressed = gzipSync(Buffer.from(text))
    const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'bad.raw' })!
    decodeStream(Readable.from([compressed]), { compression: 'auto', sink: raw.sink }).resume()
    await new Promise(resolve => setTimeout(resolve, 100))
    await raw.discard()
    await raw.discard() // 可重复调用
    expect(table).toHaveLength(0)
    expect(await dataFiles(root)).toBe(0)
  })

  it('登记失败（数据库错误）：文件被丢弃，错误向上抛出', async () => {
    ;(prisma.rawReportFile.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('数据库断开'))
    const compressed = gzipSync(Buffer.from(text))
    const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'x.raw' })!
    await importThrough(raw, compressed)
    await expect(raw.complete(record)).rejects.toThrow('数据库断开')
    expect(await dataFiles(root)).toBe(0)
  })

  it('并发的相同文件：唯一键冲突时丢弃新文件，不报错', async () => {
    ;(prisma.rawReportFile.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    const compressed = gzipSync(Buffer.from(text))
    const raw = opener()({ tenantId: 't1', domain: 'reports', name: 'x.raw' })!
    await importThrough(raw, compressed)
    await expect(raw.complete(record)).resolves.toBeUndefined()
    expect(await dataFiles(root)).toBe(0)
  })

  it('报告导入的完整流程：解析入库、留存并登记；读到数据却一行没写入则按失败处理并丢弃文件', async () => {
    const compressed = gzipSync(Buffer.from(text))
    const client = {
      openReportDocument: vi.fn(async (_id: string, options: { sink?: NodeJS.WritableStream }) => ({
        metadata: { url: 'https://example.test/doc' },
        stream: decodeStream(Readable.from([compressed]), { compression: 'gzip', sink: options.sink as never }),
      })),
    }
    const meta = { tenantId: 't1', reportJobId: 'rj1', reportType: 'T', fileName: 'rj1-T.raw', record }
    const deps = { prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as PrismaClient, logger, openRawFile: opener() }

    const ok = await importReportDocument(deps, client, 'doc1', (ctx, rows) => importRows(ctx, rows, async () => 'imported'), meta)
    expect(ok).toMatchObject({ imported: 500, read: 500, downloadUrl: 'https://example.test/doc' })
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ rowCount: 500 })

    table.length = 0
    const before = await dataFiles(root)
    await expect(importReportDocument(deps, client, 'doc2', (ctx, rows) => importRows(ctx, rows, async () => 'ignored'), meta)).rejects.toThrow('REPORT_ROWS_NOT_IMPORTED')
    expect(table).toHaveLength(0)
    expect(await dataFiles(root)).toBe(before) // 失败的那次没有留下文件
  })
})
