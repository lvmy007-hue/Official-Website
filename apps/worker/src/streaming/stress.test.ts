import { Readable, Writable } from 'node:stream'
import { createGzip } from 'node:zlib'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import type { ImportContext } from '../types'
import { importRows } from './batch'
import { decodeStream } from './download'
import { readLines, tsvRows } from './rows'

// 内存压测（P1-22 验收：“1GB 报告处理期间进程常驻内存不随文件大小增长”）。
// 整条流水线与线上一致：生成数据 → gzip → 下载流 → 自动识别解压（同时把原始字节写入 sink）→ 逐行解析 → 每 1000 行一批、一批一个事务；
// 数据库用“什么都不做”的替身（只验证解析、分批与内存，不验证数据库写入速度，真实库写入由 importers 与 db 测试覆盖）。
// 默认体量（CI）：16MB 与 96MB 各跑一次，断言大文件的内存峰值不比小文件高多少；
// 手动跑 1GB：STRESS_STREAM_MB=1024 corepack pnpm exec vitest run --project worker src/streaming/stress

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const MB = 1024 * 1024

interface Report {
  megabytes: number
  rows: number
  compressedMb: number
  baselineMb: number
  peakMb: number
  growthMb: number
  peakRssMb: number
  seconds: number
}

/** 生成约 `megabytes` MB 的 TSV 报告（订单报告格式），按约 1MB 一段产出，内容带变化以免压缩得过于轻松。 */
async function* generate(megabytes: number): AsyncGenerator<Buffer> {
  yield Buffer.from(['amazon-order-id', 'purchase-date', 'order-status', 'sku', 'asin', 'quantity', 'item-price', 'currency'].join('\t') + '\n')
  const target = megabytes * MB
  let produced = 0
  let sequence = 0
  while (produced < target) {
    const lines: string[] = []
    let size = 0
    while (size < MB) {
      sequence += 1
      const seed = (sequence * 2654435761) % 1_000_003
      const orderId = `111-${String(seed).padStart(7, '0')}-${String(sequence).padStart(9, '0')}`
      const purchaseDate = `2026-09-${String((sequence % 28) + 1).padStart(2, '0')}T10:00:00Z`
      const line = [orderId, purchaseDate, 'Shipped', `SKU-${seed % 5000}`, `B0${String(seed).padStart(8, '0')}`, (seed % 5) + 1, (seed % 9000) / 100, 'USD'].join('\t') + '\n'
      lines.push(line)
      size += line.length
    }
    const chunk = Buffer.from(lines.join(''))
    produced += chunk.length
    yield chunk
  }
}

async function runPipeline(megabytes: number): Promise<Report> {
  const started = Date.now()
  const logger = { warn() {}, info() {}, error() {} } as unknown as Logger
  const prisma = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as PrismaClient
  const ctx: ImportContext = { prisma, logger }

  let compressedBytes = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length
      callback()
    },
  })
  const raw = Readable.from(generate(megabytes)).pipe(createGzip())
  const rows = tsvRows(readLines(decodeStream(raw, { compression: 'auto', sink })))

  gc()
  const baseline = process.memoryUsage()
  const baselineBytes = baseline.heapUsed + baseline.external
  let peakBytes = baselineBytes
  let peakRss = baseline.rss
  let handled = 0
  const result = await importRows(ctx, rows, async () => {
    handled += 1
    if (handled % 20_000 === 0) {
      gc() // 先回收再测量：测的是“仍被引用的内存”，也就是真正的占用，而不是还没来得及回收的垃圾
      const usage = process.memoryUsage()
      peakBytes = Math.max(peakBytes, usage.heapUsed + usage.external)
      peakRss = Math.max(peakRss, usage.rss)
    }
    return 'imported'
  })
  expect(result.read).toBe(handled)
  expect(result.imported).toBe(handled)
  expect(compressedBytes).toBeGreaterThan(0)
  return {
    megabytes,
    rows: handled,
    compressedMb: Math.round(compressedBytes / MB),
    baselineMb: Math.round(baselineBytes / MB),
    peakMb: Math.round(peakBytes / MB),
    growthMb: Math.round((peakBytes - baselineBytes) / MB),
    peakRssMb: Math.round(peakRss / MB),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  }
}
const show = (report: Report) =>
  process.stdout.write(
    `[压测] ${report.megabytes}MB（压缩后 ${report.compressedMb}MB，${report.rows} 行）：基线 ${report.baselineMb}MB → 峰值 ${report.peakMb}MB（增长 ${report.growthMb}MB），RSS 峰值 ${report.peakRssMb}MB，用时 ${report.seconds} 秒\n`,
  )

describe('流式处理内存压测', () => {
  it('大文件的内存峰值不随文件大小增长（16MB 对比 96MB）', async () => {
    const small = await runPipeline(16)
    const large = await runPipeline(96)
    show(small)
    show(large)
    expect(large.rows).toBeGreaterThan(small.rows * 5)
    expect(large.growthMb).toBeLessThanOrEqual(small.growthMb + 24)
    expect(large.growthMb).toBeLessThan(48) // 文件是 96MB，若整份读入内存，增长至少是文件大小的数倍
  }, 120_000)

  const stress = Number(process.env.STRESS_STREAM_MB)
  it.skipIf(!(stress > 0))(
    '手动压测：STRESS_STREAM_MB 指定的体量（例如 1024 即 1GB）',
    async () => {
      const baseline = await runPipeline(128)
      const big = await runPipeline(stress)
      show(baseline)
      show(big)
      expect(big.growthMb).toBeLessThanOrEqual(baseline.growthMb + 32)
      expect(big.growthMb).toBeLessThan(96)
    },
    3_600_000,
  )
})
