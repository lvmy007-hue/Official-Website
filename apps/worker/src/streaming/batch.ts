import type { PrismaClient } from '@prisma/client'
import type { ImportContext } from '../types'
import type { Row } from './rows'

// 分批写库（12.5 后台任务第 4 条）：每批最多 1000 行，一批一个事务——单个事务大小有界，
// 失败只回滚当前批，整个任务按幂等键重试时已提交的批不会重复。

export const BATCH_SIZE = 1000
/** 单批事务的超时（毫秒）。1000 行带有关联写入时远低于此值；超时说明数据库异常，让任务按可重试错误处理。 */
export const BATCH_TX_TIMEOUT_MS = 120_000

export type RowOutcome = 'imported' | 'skipped' | 'ignored'

export interface ImportResult {
  /** 实际写入（新增或更新）的行数。 */
  imported: number
  /** 读到的数据行总数（含被跳过与忽略的）。 */
  read: number
  /** 因缺少关键字段（例如日期）而被跳过的行数。 */
  skipped: number
}

/** 把任意迭代器切成固定大小的批；内存里同时只有一批。 */
export async function* inBatches<T>(source: AsyncIterable<T>, size = BATCH_SIZE): AsyncGenerator<T[]> {
  let batch: T[] = []
  for await (const item of source) {
    batch.push(item)
    if (batch.length >= size) {
      yield batch
      batch = []
    }
  }
  if (batch.length > 0) yield batch
}

export interface ImportRowsOptions {
  batchSize?: number
  /** 被跳过的行的汇总告警文案；没有行被跳过时不输出。 */
  skippedMessage?: string
  /** 汇总告警里附带的定位信息（不要放个人信息）。 */
  logFields?: Record<string, unknown>
}

/**
 * 流式导入：从行流里逐批取行，每批在一个事务里调用 handle 写库。
 * handle 里使用传入的 ctx.prisma（它是事务内的客户端，自动带租户条件）。
 */
export async function importRows(
  ctx: ImportContext,
  rows: AsyncIterable<Row>,
  handle: (ctx: ImportContext, row: Row, index: number) => Promise<RowOutcome>,
  options: ImportRowsOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, read: 0, skipped: 0 }
  for await (const batch of inBatches(rows, options.batchSize ?? BATCH_SIZE)) {
    const offset = result.read
    const outcomes = await ctx.prisma.$transaction(
      async tx => {
        const inner: ImportContext = { ...ctx, prisma: tx as unknown as PrismaClient }
        const collected: RowOutcome[] = []
        for (let index = 0; index < batch.length; index += 1) collected.push(await handle(inner, batch[index], offset + index))
        return collected
      },
      { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 },
    )
    result.read += batch.length
    for (const outcome of outcomes) {
      if (outcome === 'imported') result.imported += 1
      else if (outcome === 'skipped') result.skipped += 1
    }
  }
  if (result.skipped > 0 && options.skippedMessage) ctx.logger.warn({ skipped: result.skipped, ...options.logFields }, options.skippedMessage)
  return result
}
