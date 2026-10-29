import { describe, expect, it } from 'vitest'
import type { PrismaService } from '../prisma.service'
import { AppError } from '../http'
import { IN_PROGRESS_STALE_MS, IdempotencyService, requestFingerprint } from './idempotency.service'

// 用内存里的表模拟 IdempotencyRecord，包括唯一键冲突（Prisma 的 P2002）。
type Row = { id: string; tenantId: string; key: string; route: string; requestHash: string; responseStatus: number | null; responseJson: unknown; createdAt: Date; expiresAt: Date }

function memoryPrisma() {
  const rows: Row[] = []
  let seq = 0
  const find = (where: { id?: string; tenantId_key_route?: { tenantId: string; key: string; route: string } }) =>
    rows.find(row =>
      where.id
        ? row.id === where.id
        : where.tenantId_key_route
          ? row.tenantId === where.tenantId_key_route.tenantId && row.key === where.tenantId_key_route.key && row.route === where.tenantId_key_route.route
          : false,
    )
  const table = {
    async create({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'responseStatus' | 'responseJson'> }) {
      if (rows.some(row => row.tenantId === data.tenantId && row.key === data.key && row.route === data.route)) throw Object.assign(new Error('unique'), { code: 'P2002' })
      const row: Row = { ...data, id: `rec-${(seq += 1)}`, createdAt: new Date(), responseStatus: null, responseJson: null }
      rows.push(row)
      return { id: row.id }
    },
    async findUnique({ where }: { where: any }) {
      return find(where) ?? null
    },
    async findMany({ where, take }: { where: any; take?: number }) {
      return rows
        .filter(row => row.expiresAt <= where.expiresAt.lte)
        .slice(0, take)
        .map(row => ({ id: row.id }))
    },
    async update({ where, data }: { where: any; data: Partial<Row> }) {
      Object.assign(find(where)!, data)
      return {}
    },
    async updateMany({ where, data }: { where: any; data: Partial<Row> }) {
      const row = rows.find(item => item.id === where.id && item.responseStatus === where.responseStatus && item.createdAt.getTime() === where.createdAt.getTime())
      if (!row) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
    async deleteMany({ where }: { where: any }) {
      const doomed = rows.filter(
        row =>
          (where.id?.in ? where.id.in.includes(row.id) : where.id ? row.id === where.id : true) &&
          (where.responseStatus === null ? row.responseStatus === null : true) &&
          (where.expiresAt?.lte ? row.expiresAt <= where.expiresAt.lte : true),
      )
      for (const row of doomed) rows.splice(rows.indexOf(row), 1)
      return { count: doomed.length }
    },
  }
  return { rows, service: new IdempotencyService({ idempotencyRecord: table } as unknown as PrismaService) }
}

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    e => e,
  )
  expect(error).toBeInstanceOf(AppError)
  expect((error as AppError).code).toBe(code)
}

describe('幂等记录', () => {
  it('首次请求登记处理中；完成后相同的键与内容重放首次结果', async () => {
    const { service, rows } = memoryPrisma()
    const first = await service.begin('t1', 'key-0001', 'POST /api/v1/entities', 'hash-a')
    expect(first.state).toBe('new')
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000)
    await service.complete((first as { recordId: string }).recordId, 201, { data: { id: 'e1' } })
    const second = await service.begin('t1', 'key-0001', 'POST /api/v1/entities', 'hash-a')
    expect(second).toEqual({ state: 'replay', status: 201, body: { data: { id: 'e1' } } })
  })

  it('同一个键换了内容返回 422；换了路由或企业则互不影响', async () => {
    const { service } = memoryPrisma()
    await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')
    await expectCode(service.begin('t1', 'key-0001', 'POST /a', 'hash-b'), 'IDEMPOTENCY_KEY_REUSED')
    expect((await service.begin('t1', 'key-0001', 'POST /b', 'hash-b')).state).toBe('new')
    expect((await service.begin('t2', 'key-0001', 'POST /a', 'hash-b')).state).toBe('new')
  })

  it('处理中的重复请求返回 409（可重试）；超过 2 分钟视为上次已中断，可以接管，且只有一个请求能接管', async () => {
    const { service, rows } = memoryPrisma()
    await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')
    await expectCode(service.begin('t1', 'key-0001', 'POST /a', 'hash-a'), 'IDEMPOTENCY_IN_PROGRESS')
    rows[0].createdAt = new Date(Date.now() - IN_PROGRESS_STALE_MS - 1000)
    const taken = await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')
    expect(taken.state).toBe('new')
    await expectCode(service.begin('t1', 'key-0001', 'POST /a', 'hash-a'), 'IDEMPOTENCY_IN_PROGRESS')
  })

  it('失败后释放：客户端修正后可以用同一个键重新提交；已完成的记录不会被释放', async () => {
    const { service, rows } = memoryPrisma()
    const begun = (await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')) as { recordId: string }
    await service.release(begun.recordId)
    expect(rows).toHaveLength(0)
    const again = (await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')) as { recordId: string }
    await service.complete(again.recordId, 201, { ok: true })
    await service.release(again.recordId)
    expect(rows).toHaveLength(1)
  })

  it('过期记录被清理后，同一个键可以重新使用', async () => {
    const { service, rows } = memoryPrisma()
    await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')
    rows[0].expiresAt = new Date(Date.now() - 1000)
    expect((await service.begin('t1', 'key-0001', 'POST /a', 'hash-b')).state).toBe('new')
    rows[0].expiresAt = new Date(Date.now() - 1000)
    expect(await service.purgeExpired()).toBe(1)
    expect(rows).toHaveLength(0)
  })

  it('响应体过大不保存：记录被释放，不留半截数据', async () => {
    const { service, rows } = memoryPrisma()
    const begun = (await service.begin('t1', 'key-0001', 'POST /a', 'hash-a')) as { recordId: string }
    await service.complete(begun.recordId, 201, { blob: 'x'.repeat(300 * 1024) })
    expect(rows).toHaveLength(0)
  })
})

describe('请求摘要', () => {
  const base = { method: 'POST', route: 'POST /a/:id', params: { id: '1' }, query: {}, body: { a: 1, b: { c: 2, d: 3 } } }

  it('键的顺序不影响摘要；内容、路径参数、查询参数任一变化摘要就变', () => {
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base, body: { b: { d: 3, c: 2 }, a: 1 } }))
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ ...base, body: { a: 2, b: { c: 2, d: 3 } } }))
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ ...base, params: { id: '2' } }))
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ ...base, query: { force: 'true' } }))
  })
})
