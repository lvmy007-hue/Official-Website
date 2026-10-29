import type { PrismaClient } from '@prisma/client'
import { vi } from 'vitest'

// A+ 测试用的内存数据库替身（P4-14）：只实现同步器、写入流程与分发用到的几个 Prisma 方法，足以验证“写了什么、没写什么”。
// 没有连真实 Postgres：行级安全、唯一约束的真实行为由 API 侧的真实库测试与迁移覆盖；这里的唯一键只模拟审核事件与关联行两处。

export type Row = Record<string, ReturnType<typeof JSON.parse>>
type Where = Record<string, ReturnType<typeof JSON.parse>>

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null))

/** 支持等值、{ in }、{ notIn }、{ not }，足够覆盖代码里用到的条件。 */
export function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return (want.in as unknown[]).some(item => same(row[key], item))
      if ('notIn' in want) return !(want.notIn as unknown[]).some(item => same(row[key], item))
      if ('not' in want) return !same(row[key], want.not)
    }
    return same(row[key], want)
  })
}

const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))

function table(unique?: string[]) {
  const rows: Row[] = []
  let counter = 0
  return {
    rows,
    // 读出来的是副本（和真实数据库一样）：之后对库里这一行的修改不会改动已经读出的对象
    findMany: vi.fn(async ({ where, take }: { where?: Where; take?: number } = {}) =>
      rows
        .filter(row => matches(row, where))
        .slice(0, take ?? rows.length)
        .map(row => ({ ...row })),
    ),
    findFirst: vi.fn(async ({ where }: { where?: Where } = {}) => {
      const found = rows.find(row => matches(row, where))
      return found ? { ...found } : null
    }),
    count: vi.fn(async ({ where }: { where?: Where } = {}) => rows.filter(row => matches(row, where)).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      counter += 1
      const row = { id: `r${counter}`, ...defined(data) }
      rows.push(row)
      return row
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const row = rows.find(item => matches(item, where))
      if (!row) throw new Error('RECORD_NOT_FOUND')
      Object.assign(row, defined(data))
      return row
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: Where; data: Row }) => {
      const hit = rows.filter(row => matches(row, where))
      for (const row of hit) Object.assign(row, defined(data))
      return { count: hit.length }
    }),
    createMany: vi.fn(async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0
      for (const item of data) {
        if (unique && rows.some(row => unique.every(key => same(row[key], item[key])))) {
          if (skipDuplicates) continue
          throw new Error('UNIQUE_VIOLATION')
        }
        counter += 1
        rows.push({ id: `r${counter}`, ...defined(item) })
        count += 1
      }
      return { count }
    }),
  }
}

export function fakeAplusDb() {
  const contents = table()
  const relations = table(['contentId', 'asin'])
  const events = table(['contentId', 'status', 'occurredAt'])
  const runs = table()
  const switches = table()
  const prisma: PrismaClient = {
    aplusContent: contents,
    aplusAsinRelation: relations,
    aplusReviewEvent: events,
    aplusWriteRun: runs,
    integrationSwitch: switches,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaClient
  /** 一份已有的本地内容（带默认字段）。 */
  const seedContent = (row: Row) => {
    const full = {
      id: `c-${row.contentReferenceKey ?? 'local'}`,
      tenantId: 't1',
      sellerAccountId: 'sa1',
      marketplaceId: 'ATVPDKIKX0DER',
      name: 'Local',
      contentType: 'EBC',
      locale: 'en-US',
      status: 'DRAFT',
      asinCount: 0,
      version: 1,
      draftJson: {},
      rejectionReason: null,
      publishedAt: null,
      ...row,
    }
    contents.rows.push(full)
    return full
  }
  return { prisma, contents, relations, events, runs, switches, seedContent }
}
