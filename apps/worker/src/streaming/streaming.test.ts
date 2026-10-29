import { PassThrough, Readable, Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../types'
import { BATCH_SIZE, importRows, inBatches } from './batch'
import { decodeStream, StreamLimitError } from './download'
import { decodeUtf8, jsonRows, readLines, tsvRows } from './rows'

// 流式处理单元测试（P1-22）：分段边界、压缩、原始字节留存、上限、中断、分批与事务回滚。

async function collect<T>(source: AsyncIterable<T>) {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}
async function* chunksOf(bytes: Buffer, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
}
async function* strings(...parts: string[]) {
  for (const part of parts) yield part
}
const bytesOf = async (stream: Readable) => Buffer.concat(await collect(stream as AsyncIterable<Buffer>))

describe('逐行读取', () => {
  it('多字节字符被拆在两个分段之间也不乱码，兼容 CRLF 与开头的 BOM，末尾没有换行也不丢最后一行', async () => {
    const bytes = Buffer.from('\ufeff名称\t数量\r\n保温杯\t2\r\n不锈钢水壶\t3', 'utf8')
    for (const size of [1, 2, 3, 5, 64]) {
      expect(await collect(readLines(chunksOf(bytes, size)))).toEqual(['名称\t数量', '保温杯\t2', '不锈钢水壶\t3'])
    }
  })

  it('单行过长直接报错，不会让一行吃掉全部内存', async () => {
    await expect(collect(readLines(strings('x'.repeat(50), 'y'.repeat(50)), 80))).rejects.toMatchObject({ code: 'STREAM_LINE_TOO_LONG' })
  })

  it('制表符报告：以首行为表头，空行跳过，缺少的列补空串', async () => {
    const rows = await collect(tsvRows(readLines(strings('a\tb\tc\n', '1\t2\t3\n\n4\t5\n'))))
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '' },
    ])
  })
})

describe('逐条解析 JSON', () => {
  const sample = [
    { id: 1, name: '含 } 与 ] 与 \\" 的字符串', nested: { list: [1, 2, { deep: '}' }] } },
    { id: 2, name: 'b' },
  ]

  it('数组：无论在哪里切分都得到同样的记录；字符串里的括号与转义不影响边界', async () => {
    const bytes = Buffer.from(JSON.stringify(sample))
    for (const size of [1, 3, 7, 1024]) {
      expect(await collect(jsonRows(decodeUtf8(chunksOf(bytes, size))))).toEqual(sample)
    }
  })

  it('逐行 JSON（NDJSON）与带 rows 包装的返回都能读取', async () => {
    expect(await collect(jsonRows(strings(sample.map(item => JSON.stringify(item)).join('\n'))))).toEqual(sample)
    expect(await collect(jsonRows(strings(JSON.stringify({ rows: sample }))))).toEqual(sample)
  })

  it('文件在记录中间被截断时报错，不静默丢掉最后一条', async () => {
    await expect(collect(jsonRows(strings('[{"id":1},{"id":2,"na')))).rejects.toThrow('JSON_STREAM_TRUNCATED')
  })
})

describe('流式解压与原始文件留存', () => {
  const text = Array.from({ length: 2000 }, (_, index) => `行${index}\t${index}`).join('\n')

  it('gzip：显式指定与自动识别得到同样的内容；未压缩的文件自动识别后原样透传', async () => {
    const compressed = gzipSync(Buffer.from(text))
    expect((await bytesOf(decodeStream(Readable.from(chunksOf(compressed, 100)), { compression: 'gzip' }))).toString()).toBe(text)
    expect((await bytesOf(decodeStream(Readable.from(chunksOf(compressed, 100)), { compression: 'auto' }))).toString()).toBe(text)
    expect((await bytesOf(decodeStream(Readable.from(chunksOf(Buffer.from(text), 100)), { compression: 'auto' }))).toString()).toBe(text)
  })

  it('原始字节（解压之前）同时写入 sink，内容与下载的完全一致', async () => {
    const compressed = gzipSync(Buffer.from(text))
    const received: Buffer[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        received.push(chunk as Buffer)
        callback()
      },
    })
    const decoded = await bytesOf(decodeStream(Readable.from(chunksOf(compressed, 100)), { compression: 'auto', sink }))
    expect(decoded.toString()).toBe(text)
    expect(Buffer.concat(received).equals(compressed)).toBe(true)
  })

  it('解压后超过上限立即中止（防压缩炸弹）', async () => {
    const compressed = gzipSync(Buffer.alloc(1_000_000, 97))
    const error = await bytesOf(decodeStream(Readable.from(chunksOf(compressed, 100)), { compression: 'gzip', maxDecompressedBytes: 10_000 })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StreamLimitError)
    expect((error as StreamLimitError).code).toBe('STREAM_TOO_LARGE')
  })

  it('数据损坏与下载中断都会让读取方收到错误，而不是得到被截断的文件', async () => {
    const compressed = gzipSync(Buffer.from(text))
    await expect(bytesOf(decodeStream(Readable.from(chunksOf(compressed.subarray(0, compressed.length - 20), 100)), { compression: 'gzip' }))).rejects.toThrow()
    const broken = new PassThrough()
    const pending = bytesOf(decodeStream(broken, { compression: 'none' }))
    broken.write('部分内容')
    broken.destroy(new Error('连接被重置'))
    await expect(pending).rejects.toThrow('连接被重置')
  })

  it('sink 写失败时下载随之失败（不会悄悄丢掉原始文件）', async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('对象存储不可用'))
      },
    })
    await expect(bytesOf(decodeStream(Readable.from(chunksOf(Buffer.from(text), 100)), { compression: 'none', sink }))).rejects.toThrow('对象存储不可用')
  })
})

describe('分批写库', () => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  async function* numbers(count: number) {
    for (let index = 0; index < count; index += 1) yield { index }
  }

  function contextWith(transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>) {
    const prisma = { $transaction: vi.fn(transaction) } as unknown as PrismaClient
    return { ctx: { prisma, logger } as ImportContext, prisma }
  }

  it('默认每批 1000 行，一批一个事务；内存里同时只有一批', async () => {
    expect(BATCH_SIZE).toBe(1000)
    const sizes: number[] = []
    for await (const batch of inBatches(numbers(2500))) sizes.push(batch.length)
    expect(sizes).toEqual([1000, 1000, 500])
  })

  it('统计写入、跳过、忽略的行数，跳过的行汇总告警一次', async () => {
    const { ctx, prisma } = contextWith(fn => fn({}))
    const result = await importRows(ctx, numbers(7), async (_ctx, row) => ((row.index as number) % 3 === 0 ? 'imported' : (row.index as number) % 3 === 1 ? 'skipped' : 'ignored'), {
      batchSize: 3,
      skippedMessage: '部分行被跳过',
      logFields: { tenantId: 't1' },
    })
    expect(result).toEqual({ imported: 3, read: 7, skipped: 2 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalledWith({ skipped: 2, tenantId: 't1' }, '部分行被跳过')
  })

  it('某一批失败：错误向上抛出、后面的批不再处理；已提交的批保持提交（重试时靠幂等键覆盖）', async () => {
    let call = 0
    const committed: number[] = []
    const { ctx } = contextWith(async fn => {
      call += 1
      if (call === 2) throw new Error('数据库连接断开')
      const outcome = await fn({})
      committed.push(call)
      return outcome
    })
    const handled: number[] = []
    await expect(
      importRows(
        ctx,
        numbers(10),
        async (_ctx, row) => {
          handled.push(row.index as number)
          return 'imported'
        },
        { batchSize: 4 },
      ),
    ).rejects.toThrow('数据库连接断开')
    expect(committed).toEqual([1])
    expect(Math.max(...handled)).toBeLessThan(8)
  })

  it('每一批的写入都使用事务内的客户端', async () => {
    const tx = { marker: 'tx' }
    const { ctx } = contextWith(fn => fn(tx))
    const seen: unknown[] = []
    await importRows(ctx, numbers(3), async inner => {
      seen.push((inner.prisma as unknown as typeof tx).marker)
      return 'imported'
    })
    expect(seen).toEqual(['tx', 'tx', 'tx'])
  })
})
