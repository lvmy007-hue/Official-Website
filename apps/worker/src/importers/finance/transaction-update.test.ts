import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { accountIdsOf, createTransactionUpdateProcessor } from './transaction-update'

// TRANSACTION_UPDATE 推送处理器（importers.md N-14，P2b-05）：推送只是“有变化”的信号，处理器排一个财务增量同步；
// 接收端暂缓，这里验证事件一旦进来（含人工重放）的行为。

const event = { id: 'e1', tenantId: 't1', sellerAccountId: 's1', notificationType: 'TRANSACTION_UPDATE', payloadObjectKey: 'events/e1.json' }

function setup(over: { connection?: unknown; queued?: number; payload?: unknown; sellerAccounts?: unknown[]; addSync?: ReturnType<typeof vi.fn> } = {}) {
  const db = {
    platformConnection: { findFirst: vi.fn().mockResolvedValue(over.connection === undefined ? { id: 'c1' } : over.connection) },
    syncJob: { count: vi.fn().mockResolvedValue(over.queued ?? 0), create: vi.fn().mockResolvedValue({ id: 'j1' }), update: vi.fn().mockResolvedValue({}) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue(over.sellerAccounts ?? []) },
    dataFreshness: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn(), updateMany: vi.fn() },
  }
  const storage = { openRead: vi.fn(async () => Readable.from([Buffer.from(JSON.stringify(over.payload ?? {}))])) }
  const addSync = over.addSync ?? vi.fn().mockResolvedValue({})
  return { db, addSync, processor: createTransactionUpdateProcessor({ db: db as never, storage, queues: { addSync } }) }
}

describe('交易更新推送处理', () => {
  it('授权中的店铺：排一个财务增量同步（推送增量优先级），请求号带事件编号，并入队；记录新鲜度', async () => {
    const { db, addSync, processor } = setup()
    await processor(event)
    const created = db.syncJob.create.mock.calls[0][0].data
    expect(created).toMatchObject({ tenantId: 't1', connectionId: 'c1', type: 'FBA_FINANCE', status: 'PENDING', requestId: 'push:e1' })
    expect(addSync).toHaveBeenCalledTimes(1)
    expect(addSync.mock.calls[0][0]).toBe('FBA_FINANCE')
    expect(addSync.mock.calls[0][2]).toMatchObject({ jobId: 'j1', priority: created.priority })
    expect(db.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'ntf.transaction-update', lastRowCount: 1 })
  })

  it('已经有一个排队中的财务同步：不重复排（它前推 14 天重拉，包含这次变化），新鲜度记 0 个新任务', async () => {
    const { db, addSync, processor } = setup({ queued: 1 })
    await processor(event)
    expect(db.syncJob.create).not.toHaveBeenCalled()
    expect(addSync).not.toHaveBeenCalled()
    expect(db.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'ntf.transaction-update', lastRowCount: 0 })
  })

  it('店铺没有授权的连接：抛错交给重试与死信，不排任务', async () => {
    const { db, processor } = setup({ connection: null })
    await expect(processor(event)).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' })
    expect(db.syncJob.create).not.toHaveBeenCalled()
  })

  it('入队失败：任务标记失败并抛出原错误（不留下永远排队的任务）', async () => {
    const { db, processor } = setup({ addSync: vi.fn().mockRejectedValue(new Error('redis down')) })
    await expect(processor(event)).rejects.toThrow('redis down')
    expect(db.syncJob.update.mock.calls[0][0]).toMatchObject({ where: { id: 'j1' }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE' } })
  })

  it('事件没带店铺：从载荷里的卖家编号反查；反查不到抛 SELLER_ACCOUNT_UNRESOLVED', async () => {
    const unresolved = setup({ payload: { payload: { sellerId: 'A1' } }, sellerAccounts: [] })
    await expect(unresolved.processor({ ...event, sellerAccountId: null })).rejects.toMatchObject({ code: 'SELLER_ACCOUNT_UNRESOLVED' })
    const resolved = setup({ payload: { payload: { sellerId: 'A1' } }, sellerAccounts: [{ id: 's9' }] })
    await resolved.processor({ ...event, sellerAccountId: null })
    expect(resolved.db.platformConnection.findFirst.mock.calls[0][0].where).toMatchObject({ sellerAccountId: 's9' })
  })

  it('载荷里的店铺编号：顶层与 payload 里的 sellerId、accountId，去掉空白与非字符串', () => {
    expect(accountIdsOf({ sellerId: ' A1 ', payload: { accountId: 'A2', sellerId: 7 } })).toEqual(['A1', 'A2'])
    expect(accountIdsOf(null)).toEqual([])
    expect(accountIdsOf({ payload: [] })).toEqual([])
  })
})
