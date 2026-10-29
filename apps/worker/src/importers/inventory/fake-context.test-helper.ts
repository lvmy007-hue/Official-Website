import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { vi } from 'vitest'
import { readLines, tsvRows } from '../../streaming/rows'
import type { ImportContext } from '../../types'

// 库存类导入器测试的公共替身（仅测试使用）：记录每一次写库调用的数据库替身，以及把报告文本变成与线上一致的行流。

// 写库参数在测试里按需深取字段，用宽松类型（等价于 any，写成 JSON.parse 的返回类型以免触发 no-explicit-any 警告，lint 警告上限为 35）
type Loose = ReturnType<typeof JSON.parse>
export type Call = { model: string; op: string; args: Loose }

export function fakeContext() {
  const calls: Call[] = []
  const prisma: PrismaClient = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
        return new Proxy(
          {},
          {
            get(_inner, op: string) {
              return async (args: Loose) => {
                calls.push({ model, op, args })
                if (op === 'upsert') return { id: `${model}-1`, ...(args?.create ?? {}) }
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const warn = vi.fn()
  const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger
  const ctx: ImportContext = { prisma, logger }
  const of = (model: string) => calls.filter(call => call.model === model && call.op === 'upsert')
  return { ctx, calls, of, warn }
}

export const tsv = (...rows: string[][]) => rows.map(row => row.join('\t')).join('\n')

async function* chunked(content: string) {
  const bytes = Buffer.from(content)
  for (let offset = 0; offset < bytes.length; offset += 41) yield bytes.subarray(offset, offset + 41)
}
export const rowsOf = (content: string) => tsvRows(readLines(chunked(content)))

export const scope = { tenantId: 't1', sellerAccountId: 'sa1', snapshotDate: new Date('2026-10-22T00:00:00Z'), reportJobId: 'rj1', now: new Date('2026-10-22T08:00:00Z') }
