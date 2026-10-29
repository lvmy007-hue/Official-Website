import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { vi } from 'vitest'
import type { AdsV1Api } from '../../connectors/ads-v1-api'
import type { ImportContext, JsonObject } from '../../types'

// 广告连接器测试的公共替身（仅测试使用）：记录每次写库调用的数据库替身，以及按资源返回固定条目的统一接口替身。

type Loose = ReturnType<typeof JSON.parse>
export type Call = { model: string; op: string; args: Loose }

/** overrides 的键是 `模型.操作`，值是返回值或按参数计算返回值的函数；没有覆盖时 create 返回带 id 的行，其余返回 null。 */
export function recorder(overrides: Record<string, unknown> = {}) {
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
                const key = `${model}.${op}`
                if (key in overrides) return typeof overrides[key] === 'function' ? (overrides[key] as (a: unknown) => unknown)(args) : overrides[key]
                if (op === 'create') return { id: `${model}-1`, ...(args?.data ?? {}) }
                if (op === 'findMany') return []
                if (op === 'updateMany') return { count: 0 }
                return null
              }
            },
          },
        )
      },
    },
  ) as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const ctx: ImportContext = { prisma, logger }
  const of = (model: string, op: string) => calls.filter(call => call.model === model && call.op === op)
  return { ctx, prisma, logger, calls, of }
}

/** 统一接口替身：queryAll 逐条交出给定条目，返回值里的 complete 可控。 */
export function fakeQueryAll(items: Record<string, JsonObject[]>, complete = true): Pick<AdsV1Api, 'queryAll'> {
  return {
    async *queryAll(resource: string) {
      for (const item of items[resource] ?? []) yield item
      return { complete, pages: 1 }
    },
  } as unknown as Pick<AdsV1Api, 'queryAll'>
}
