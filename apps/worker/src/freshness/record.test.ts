import { describe, expect, it, vi } from 'vitest'
import { recordFreshness, recordSyncOutcome } from './record'

const NOW = new Date('2026-10-22T08:00:00Z')

function dbFor(existing: { id: string } | null = null, job: Record<string, unknown> | null = { tenantId: 't1', domain: 'orders', connection: { sellerAccountId: 's1' } }) {
  return {
    dataFreshness: {
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    syncJob: { findUnique: vi.fn().mockResolvedValue(job) },
  }
}

describe('新鲜度记录', () => {
  it('首次成功：新建一行，最近成功时间与数据覆盖时间都是现在，状态正常，清空失败码', async () => {
    const db = dbFor()
    await recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: true, rowCount: 42, now: NOW })
    expect(db.dataFreshness.create.mock.calls[0][0].data).toEqual({
      tenantId: 't1',
      sellerAccountId: 's1',
      sourceKey: 'orders.api',
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      dataThrough: NOW,
      lastRowCount: 42,
      status: 'NORMAL',
      lastErrorCode: null,
    })
  })

  it('已有记录：成功时更新；指定了数据覆盖时间就用它（不假装覆盖到现在）', async () => {
    const db = dbFor({ id: 'f1' })
    const through = new Date('2026-10-21T00:00:00Z')
    await recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: true, dataThrough: through, now: NOW })
    expect(db.dataFreshness.update.mock.calls[0][0]).toMatchObject({ where: { id: 'f1' }, data: { dataThrough: through, lastSuccessAt: NOW, status: 'NORMAL' } })
    expect(db.dataFreshness.create).not.toHaveBeenCalled()
  })

  it('失败：只记录尝试时间、状态与失败码，保留上一次成功的时间与覆盖时间', async () => {
    const db = dbFor({ id: 'f1' })
    await recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: false, errorCode: 'AUTH_EXPIRED', now: NOW })
    const data = db.dataFreshness.update.mock.calls[0][0].data
    expect(data).toEqual({ lastAttemptAt: NOW, status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED' })
    expect(data).not.toHaveProperty('lastSuccessAt')
    expect(data).not.toHaveProperty('dataThrough')
  })

  it('首次就失败：新建的行没有成功时间，页面显示“尚无成功同步”', async () => {
    const db = dbFor()
    await recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: false, errorCode: 'PARSE_HEADER', now: NOW })
    const data = db.dataFreshness.create.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'FAILED', lastErrorCode: 'PARSE_HEADER' })
    expect(data).not.toHaveProperty('lastSuccessAt')
  })

  it('并发创建冲突（唯一约束）时改为更新，其他错误照常抛出', async () => {
    const db = dbFor()
    db.dataFreshness.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    await recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: true, now: NOW })
    expect(db.dataFreshness.updateMany).toHaveBeenCalledTimes(1)
    db.dataFreshness.create.mockRejectedValueOnce(new Error('db down'))
    await expect(recordFreshness(db as never, { tenantId: 't1', sellerAccountId: 's1', sourceKey: 'orders.api', ok: true, now: NOW })).rejects.toThrow('db down')
  })
})

describe('同步任务结果落到新鲜度', () => {
  it('按任务的数据域找到来源键，记在连接所属店铺上', async () => {
    const db = dbFor(null, { tenantId: 't1', domain: 'finance', connection: { sellerAccountId: 's9' } })
    expect(await recordSyncOutcome(db as never, 'job-1', { ok: true })).toBe(true)
    expect(db.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ tenantId: 't1', sellerAccountId: 's9', sourceKey: 'finance.transactions' })
  })

  it('报告类任务（数据域 reports）按上下文里的报告类型找来源键：成功带行数，失败带失败码', async () => {
    const ok = dbFor(null, { tenantId: 't1', domain: 'reports', context: { reportType: 'GET_FBA_INVENTORY_PLANNING_DATA' }, connection: { sellerAccountId: 's2' } })
    expect(await recordSyncOutcome(ok as never, 'job-2', { ok: true, rowCount: 7 })).toBe(true)
    expect(ok.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sellerAccountId: 's2', sourceKey: 'rpt.inventory-planning', lastRowCount: 7, status: 'NORMAL' })
    const failed = dbFor(null, { tenantId: 't1', domain: 'reports', context: { reportType: 'GET_LEDGER_DETAIL_VIEW_DATA' }, connection: { sellerAccountId: 's2' } })
    expect(await recordSyncOutcome(failed as never, 'job-3', { ok: false, errorCode: 'PARSE_HEADER' })).toBe(true)
    expect(failed.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'rpt.ledger-detail', status: 'FAILED', lastErrorCode: 'PARSE_HEADER' })
    const unknown = dbFor(null, { tenantId: 't1', domain: 'reports', context: { reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA' }, connection: { sellerAccountId: 's2' } })
    expect(await recordSyncOutcome(unknown as never, 'job-4', { ok: true })).toBe(false)
  })

  it('订阅省同步（任务类型 FBA_REPLENISHMENT，走库存数据域）记在自己的来源 replenishment.api，不会覆盖库存的新鲜度；不适用记为“不适用”', async () => {
    const db = dbFor(null, { tenantId: 't1', type: 'FBA_REPLENISHMENT', domain: 'inventory', connection: { sellerAccountId: 's3' } })
    expect(await recordSyncOutcome(db as never, 'job-r', { ok: true, rowCount: 12 })).toBe(true)
    expect(db.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sellerAccountId: 's3', sourceKey: 'replenishment.api', lastRowCount: 12, status: 'NORMAL' })
    const none = dbFor(null, { tenantId: 't1', type: 'FBA_REPLENISHMENT', domain: 'inventory', connection: { sellerAccountId: 's3' } })
    await recordSyncOutcome(none as never, 'job-n', { ok: false, errorCode: 'SCOPE_UNAVAILABLE' })
    expect(none.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'replenishment.api', status: 'NOT_APPLICABLE', lastErrorCode: 'SCOPE_UNAVAILABLE' })
    const inventory = dbFor(null, { tenantId: 't1', type: 'FBA_INVENTORY', domain: 'inventory', connection: { sellerAccountId: 's3' } })
    await recordSyncOutcome(inventory as never, 'job-i', { ok: true })
    expect(inventory.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'inventory.api' })
  })

  it('没有登记新鲜度来源的数据域、没有店铺的连接、找不到的任务：不记录；记录出错也不影响同步', async () => {
    const ads = dbFor(null, { tenantId: 't1', domain: 'ads', connection: { sellerAccountId: 's1' } })
    expect(await recordSyncOutcome(ads as never, 'j', { ok: true })).toBe(false)
    const noStore = dbFor(null, { tenantId: 't1', domain: 'orders', connection: { sellerAccountId: null } })
    expect(await recordSyncOutcome(noStore as never, 'j', { ok: true })).toBe(false)
    expect(await recordSyncOutcome(dbFor(null, null) as never, 'j', { ok: true })).toBe(false)
    const broken = dbFor()
    broken.dataFreshness.findFirst.mockRejectedValue(new Error('db down'))
    expect(await recordSyncOutcome(broken as never, 'j', { ok: false, errorCode: 'UPSTREAM_ERROR' })).toBe(false)
    expect(ads.dataFreshness.create).not.toHaveBeenCalled()
  })
})
