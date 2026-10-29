import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_KINDS, type ExportKindSpec } from '@nova/api-contracts'
import { LocalDiskStorage, TenantObjectStore } from '@nova/storage'
import { NonRetryableError } from '@nova/workflow'
import { purgeExpiredExports } from './expire'
import { ExportFailure, runExport } from './run-export'
import { EXPORT_PAGE_SIZE, EXPORT_SOURCES, type ExportSource } from './sources'
import { readZip, zipText } from './zip-reader.test-helper'

const NOW = new Date('2026-10-22T04:00:00Z')
const kinds = EXPORT_KINDS as ExportKindSpec[]
const sources = EXPORT_SOURCES as Record<string, ExportSource>
const COSTS: ExportKindSpec = {
  kind: 'test-costs',
  label: '测试成本表',
  sourcePage: '/app/test',
  permission: 'orders.read',
  filterKeys: [],
  columns: [
    { key: 'sku', label: 'SKU' },
    { key: 'unitCost', label: '单位成本', sensitive: 'cost' },
  ],
}

let root: string
let storage: LocalDiskStorage
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nova-export-'))
  storage = new LocalDiskStorage({ rootDir: root, signingKey: Buffer.alloc(32, 7), publicBaseUrl: 'http://localhost/storage' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  for (const kind of ['test-costs']) {
    const index = kinds.findIndex(item => item.kind === kind)
    if (index >= 0) kinds.splice(index, 1)
    delete sources[kind]
  }
})

const orderRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  amazonOrderId: `111-${id}`,
  purchaseDate: new Date('2026-10-20T10:00:00Z'),
  status: 'Shipped',
  fulfillment: 'FBA',
  currency: 'USD',
  amount: { toString: () => '19.99' },
  itemCount: 2,
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  tenantId: 't1',
  kind: 'orders',
  format: 'CSV',
  status: 'QUEUED',
  filterJson: {},
  requestedBy: 'u1',
  createdAt: new Date('2026-10-20T00:00:00Z'),
  expiresAt: new Date('2026-10-27T00:00:00Z'), // 创建时按企业设置的保留天数算好（默认 7 天）
  fieldPolicySnapshot: { columns: ['amazonOrderId', 'storeName', 'amount'], scope: { unrestricted: true, storeIds: [] } },
  ...over,
})

function dbFor(over: { job?: Record<string, unknown> | null; permissions?: string[]; member?: boolean; scopes?: unknown[]; orders?: unknown[][] } = {}) {
  const orders = [...(over.orders ?? [[orderRow('o1'), orderRow('o2', { amount: null, fulfillment: null })]])]
  const db: Record<string, any> = {
    exportJob: { findFirst: vi.fn().mockResolvedValue(over.job === undefined ? jobRow() : over.job), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    membership: {
      findFirst: vi
        .fn()
        .mockResolvedValue(over.member === false ? null : { id: 'm1', role: { permissions: over.permissions ?? ['export.create', 'orders.read'], system: true, version: 2, fieldPermissions: [] } }),
    },
    membershipScope: { findMany: vi.fn().mockResolvedValue(over.scopes ?? [{ legalEntityId: null, sellerAccountId: null }]) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    order: { findMany: vi.fn().mockImplementation(async () => orders.shift() ?? []) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockImplementation(async args => args) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  }
  return db
}
const deps = (db: Record<string, any>) => ({ db: db as never, storage, now: () => NOW })
const fileOf = async (key: string) => {
  const chunks: Buffer[] = []
  for await (const chunk of await storage.openRead(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
const storedFiles = async () => {
  const names: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name))
      else if (!entry.name.endsWith('.json')) names.push(entry.name)
    }
  }
  await walk(root)
  return names
}
const lastUpdate = (db: Record<string, any>) => db.exportJob.updateMany.mock.calls.at(-1)[0]
const auditActions = (db: Record<string, any>) => db.auditEvent.create.mock.calls.map((call: any[]) => call[0].data.action)

describe('导出任务执行', () => {
  it('CSV：按发起时选定的列生成文件，写入对象存储；任务置为完成并记录行数与大小；写审计并通知发起人；不读买家信息', async () => {
    const db = dbFor()
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome).toMatchObject({ status: 'DONE', rows: 2 })
    const done = lastUpdate(db)
    expect(done.data).toMatchObject({ status: 'DONE', rowCount: 2, finishedAt: NOW, errorCode: null })
    const text = (await fileOf(done.data.fileKey)).toString('utf8')
    expect(text).toBe('\uFEFF订单号,店铺,订单金额\r\n111-o1,美国主店,19.99\r\n111-o2,美国主店,\r\n')
    expect(done.data.fileSize).toBe(Buffer.byteLength(text))
    expect(done.data.fileKey).toMatch(/^tenants\/t1\/exports\//)
    expect(auditActions(db)).toEqual(['EXPORT_COMPLETED'])
    expect(db.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ userId: 'u1', kind: 'EXPORT_DONE', link: '/app/my/exports', dedupKey: 'export:e1' })
    expect(db.notification.createMany.mock.calls[0][0].data[0].body).toContain('文件保留 7 天') // 天数来自任务的到期时间，不是写死的
    const select = db.order.findMany.mock.calls[0][0].select
    expect(select).not.toHaveProperty('piiCiphertext')
    expect(db.order.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1' })
  })

  it('经营数字类导出：最后一列写明生效的口径版本；没有生效版本写默认；其他类型不加', async () => {
    const report = jobRow({
      kind: 'custom-report',
      filterJson: { rows: [{ id: 'r1', label: '甲', valuesJson: '{}' }] },
      fieldPolicySnapshot: { columns: ['id', 'label'], scope: { unrestricted: true, storeIds: [] } },
    })
    const withVersions = dbFor({ job: report, permissions: ['export.create', 'reports.read'] })
    withVersions.metricVersion = {
      findMany: vi.fn().mockResolvedValue([
        { kind: 'PROFIT_FORMULA', versionNo: 3 },
        { kind: 'BUSINESS_RULES', versionNo: 2 },
      ]),
    }
    expect((await runExport(deps(withVersions), 't1', 'e1')).status).toBe('DONE')
    const text = (await fileOf(lastUpdate(withVersions).data.fileKey)).toString('utf8')
    expect(text).toBe('\uFEFF行编号,名称,口径版本\r\nr1,甲,利润公式 v3；业务口径 v2\r\n')
    expect(withVersions.metricVersion.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', status: 'ACTIVE' })

    const plain = dbFor({ job: report, permissions: ['export.create', 'reports.read'] })
    plain.metricVersion = { findMany: vi.fn().mockResolvedValue([]) }
    await runExport(deps(plain), 't1', 'e1')
    expect((await fileOf(lastUpdate(plain).data.fileKey)).toString('utf8')).toContain('r1,甲,利润公式 默认；业务口径 默认')

    const orders = dbFor()
    await runExport(deps(orders), 't1', 'e1')
    expect((await fileOf(lastUpdate(orders).data.fileKey)).toString('utf8')).not.toContain('口径版本')
  })

  it('XLSX：生成合法的工作簿，金额是数值', async () => {
    const db = dbFor({ job: jobRow({ format: 'XLSX' }) })
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome.status).toBe('DONE')
    const sheet = zipText(readZip(await fileOf(lastUpdate(db).data.fileKey)), 'xl/worksheets/sheet1.xml') ?? ''
    expect(sheet).toContain('<c r="C2"><v>19.99</v></c>')
    expect(sheet).toContain('美国主店')
  })

  it('筛选：状态、关键词、日期范围、店铺范围都落到查询条件上', async () => {
    const db = dbFor({
      job: jobRow({
        filterJson: { status: 'Shipped', q: '111', from: '2026-10-01', to: '2026-10-21' },
        fieldPolicySnapshot: { columns: ['amazonOrderId'], scope: { unrestricted: false, storeIds: ['s1', 's2'] } },
      }),
      scopes: [{ legalEntityId: null, sellerAccountId: null }],
    })
    await runExport(deps(db), 't1', 'e1')
    expect(db.order.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      sellerAccountId: { in: ['s1', 's2'] },
      status: 'Shipped',
      amazonOrderId: { contains: '111', mode: 'insensitive' },
      purchaseDate: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-10-22T00:00:00Z') },
    })
  })

  it('分页：满页后继续按游标读下一页，直到不足一页；内存里一次只有一页', async () => {
    const page1 = Array.from({ length: EXPORT_PAGE_SIZE }, (_, index) => orderRow(`a${index}`))
    const db = dbFor({ orders: [page1, [orderRow('b1'), orderRow('b2')]] })
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome).toMatchObject({ status: 'DONE', rows: EXPORT_PAGE_SIZE + 2 })
    expect(db.order.findMany).toHaveBeenCalledTimes(2)
    const second = db.order.findMany.mock.calls[1][0].where.AND[1].OR
    expect(second[1]).toEqual({ purchaseDate: page1[EXPORT_PAGE_SIZE - 1].purchaseDate, id: { gt: `a${EXPORT_PAGE_SIZE - 1}` } })
  })

  it('权限在排队期间被收回：任务失败并说明原因，不生成任何文件，不读取数据', async () => {
    const db = dbFor({ permissions: ['orders.read'] })
    const outcome = await runExport(deps(db), 't1', 'e1')
    expect(outcome).toEqual({ status: 'FAILED', code: 'EXPORT_PERMISSION_REVOKED' })
    expect(lastUpdate(db).data).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_PERMISSION_REVOKED', fileKey: null })
    expect(db.order.findMany).not.toHaveBeenCalled()
    expect(await storedFiles()).toEqual([])
    expect(auditActions(db)).toEqual(['EXPORT_FAILED'])
    expect(db.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ kind: 'EXPORT_FAILED', severity: 'WARNING' })
  })

  it('发起人已离开企业：任务失败（EXPORT_ACTOR_INACTIVE）', async () => {
    const db = dbFor({ member: false })
    expect(await runExport(deps(db), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'EXPORT_ACTOR_INACTIVE' })
  })

  it('数据范围在排队期间被收窄：只导出现在仍有权访问的店铺；交集为空则失败', async () => {
    const narrowed = dbFor({ scopes: [{ legalEntityId: null, sellerAccountId: 's1' }] })
    await runExport(deps(narrowed), 't1', 'e1')
    expect(narrowed.order.findMany.mock.calls[0][0].where.sellerAccountId).toEqual({ in: ['s1'] })
    const none = dbFor({ scopes: [] })
    expect(await runExport(deps(none), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'EXPORT_SCOPE_EMPTY' })
    expect(none.order.findMany).not.toHaveBeenCalled()
    const disjoint = dbFor({
      job: jobRow({ fieldPolicySnapshot: { columns: ['amazonOrderId'], scope: { unrestricted: false, storeIds: ['s9'] } } }),
      scopes: [{ legalEntityId: null, sellerAccountId: 's1' }],
    })
    expect(await runExport(deps(disjoint), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'EXPORT_SCOPE_EMPTY' })
  })

  it('不分店铺的数据（审计日志）：没有任何店铺授权也能导出，只看审计读取权限；没有该权限则失败', async () => {
    const auditJob = jobRow({ kind: 'audit-events', fieldPolicySnapshot: { columns: ['occurredAt', 'actorName', 'action'], scope: { unrestricted: true, storeIds: [] } } })
    const db = dbFor({ job: auditJob, scopes: [], permissions: ['export.create', 'audit.read'] })
    db.auditEvent.findMany = vi.fn().mockResolvedValue([])
    expect(await runExport(deps(db), 't1', 'e1')).toMatchObject({ status: 'DONE' })
    expect(db.auditEvent.findMany).toHaveBeenCalled()
    const denied = dbFor({ job: auditJob, scopes: [], permissions: ['export.create'] })
    denied.auditEvent.findMany = vi.fn()
    expect(await runExport(deps(denied), 't1', 'e1')).toMatchObject({ status: 'FAILED' })
    expect(denied.auditEvent.findMany).not.toHaveBeenCalled()
  })

  it('敏感列：发起人此刻没有字段权限就不出现在文件里（即使发起时有）；有权限则导出', async () => {
    kinds.push(COSTS)
    sources['test-costs'] = async function* () {
      yield { sku: 'SKU-1', unitCost: 3.5 }
    }
    const snapshot = { columns: ['sku', 'unitCost'], scope: { unrestricted: true, storeIds: [] } }
    const without = dbFor({ job: jobRow({ kind: 'test-costs', fieldPolicySnapshot: snapshot }) })
    await runExport(deps(without), 't1', 'e1')
    expect((await fileOf(lastUpdate(without).data.fileKey)).toString('utf8')).toBe('\uFEFFSKU\r\nSKU-1\r\n')
    const withCost = dbFor({ job: jobRow({ kind: 'test-costs', fieldPolicySnapshot: snapshot }), permissions: ['export.create', 'orders.read', 'field.cost'] })
    await runExport(deps(withCost), 't1', 'e1')
    expect((await fileOf(lastUpdate(withCost).data.fileKey)).toString('utf8')).toBe('\uFEFFSKU,单位成本\r\nSKU-1,3.5\r\n')
  })

  it('重复投递：已有结论的任务直接跳过，不重复生成；找不到任务是不可重试的错误', async () => {
    for (const status of ['DONE', 'FAILED', 'EXPIRED']) {
      const db = dbFor({ job: jobRow({ status }) })
      expect(await runExport(deps(db), 't1', 'e1')).toEqual({ status: 'SKIPPED' })
      expect(db.order.findMany).not.toHaveBeenCalled()
    }
    await expect(runExport(deps(dbFor({ job: null })), 't1', 'e1')).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('未知错误：任务标为失败（用户只看到通用说明），丢弃半成品文件，并抛不可重试错误交给死信留现场', async () => {
    const db = dbFor()
    db.order.findMany.mockRejectedValue(new Error('connection refused 10.0.0.5'))
    await expect(runExport(deps(db), 't1', 'e1')).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
    expect(lastUpdate(db).data).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_FAILED' })
    expect(JSON.stringify(db.exportJob.updateMany.mock.calls)).not.toContain('10.0.0.5')
    expect(await storedFiles()).toEqual([])
  })

  it('未知的导出类型：失败码 EXPORT_KIND_UNKNOWN', async () => {
    const db = dbFor({ job: jobRow({ kind: 'removed-kind' }) })
    expect(await runExport(deps(db), 't1', 'e1')).toEqual({ status: 'FAILED', code: 'EXPORT_KIND_UNKNOWN' })
    expect(new ExportFailure('X', 'm').name).toBe('ExportFailure')
  })
})

describe('契约与实现一致', () => {
  it('契约里每个可导出的数据类型都有取数实现，反之亦然', () => {
    expect(Object.keys(EXPORT_SOURCES).sort()).toEqual(EXPORT_KINDS.map(kind => kind.kind).sort())
  })
})

describe('到期清理', () => {
  const logger = { info: vi.fn(), warn: vi.fn() }
  const prismaFor = (rows: { id: string; fileKey: string | null }[]) => ({
    exportJob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  })

  it('先删文件再标记已过期；删除失败的保持原状下次再试；卡死的排队与生成中任务置为失败', async () => {
    const system = prismaFor([
      { id: 'a', fileKey: 'tenants/t1/exports/a.csv' },
      { id: 'b', fileKey: 'tenants/t1/exports/b.csv' },
    ])
    const remove = vi.fn().mockImplementation(async (key: string) => {
      if (key.endsWith('b.csv')) throw new Error('storage down')
    })
    const result = await purgeExpiredExports({ systemPrisma: system as never, storage: { delete: remove }, logger, now: () => NOW })
    expect(result).toEqual({ expired: 1, failedToDelete: 1, stale: 1 })
    expect(system.exportJob.update).toHaveBeenCalledTimes(1)
    expect(system.exportJob.update.mock.calls[0][0]).toEqual({ where: { id: 'a' }, data: { status: 'EXPIRED', fileKey: null } })
    const stale = system.exportJob.updateMany.mock.calls[0][0]
    expect(stale.where.status).toEqual({ in: ['QUEUED', 'RUNNING'] })
    expect(stale.where.createdAt.lte).toEqual(new Date(NOW.getTime() - 2 * 3_600_000))
    expect(stale.data).toMatchObject({ status: 'FAILED', errorCode: 'EXPORT_STALE' })
    expect(logger.warn).toHaveBeenCalled()
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('tenants/')
  })

  it('租户视角的存储只能删自己的文件（别的租户的路径删不掉）', async () => {
    const foreign = new TenantObjectStore(storage, 't2', () => NOW)
    const stored = await foreign.put({ domain: 'exports', name: 'x.csv' }, Buffer.from('x'))
    await new TenantObjectStore(storage, 't1', () => NOW).remove(stored.key)
    expect(await storage.stat(stored.key)).not.toBeNull()
  })
})
