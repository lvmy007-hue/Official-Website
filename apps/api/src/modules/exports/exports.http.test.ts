import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_KINDS, type ExportKindSpec } from '@nova/api-contracts'
import { ObjectStorageService } from '../../platform/storage/object-storage.service'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
const kinds = EXPORT_KINDS as ExportKindSpec[]
const SENSITIVE: ExportKindSpec = {
  kind: 'test-costs',
  label: '测试成本表',
  sourcePage: '/app/test',
  permission: 'orders.read',
  filterKeys: ['q'],
  columns: [
    { key: 'sku', label: 'SKU' },
    { key: 'unitCost', label: '单位成本', sensitive: 'cost' },
    { key: 'margin', label: '利润率', sensitive: 'profit' },
  ],
}
afterEach(async () => {
  await harness?.close()
  harness = undefined
  const index = kinds.findIndex(item => item.kind === SENSITIVE.kind)
  if (index >= 0) kinds.splice(index, 1)
})

const NOW = Date.now()
const job = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  tenantId: 'tenant-1',
  kind: 'orders',
  sourcePage: '/app/orders',
  filterSummary: '全部店铺',
  filterJson: {},
  format: 'CSV',
  status: 'QUEUED',
  rowCount: null,
  fileKey: null,
  fileSize: null,
  errorCode: null,
  expiresAt: new Date(NOW + 7 * 86_400_000),
  requestedBy: 'user-1',
  fieldPolicySnapshot: {},
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    exportJob: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => job({ id: 'e-new', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(job()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    tenantSetting: { findFirst: vi.fn().mockResolvedValue(null) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  return prisma
}
const audits = (prisma: Record<string, any>) => prisma.auditEvent.create.mock.calls.map((call: any[]) => call[0].data)

describe('发起导出', () => {
  it('成功：保存发起时的范围与列，入队，并在同一事务写审计；返回 202', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/exports', { body: { kind: 'orders', format: 'XLSX', filters: { status: 'Shipped' }, filterSummary: '已发货' } })
    expect(res.status).toBe(202)
    expect(res.json.data).toMatchObject({ id: 'e-new', kindLabel: '订单列表', status: 'QUEUED', statusLabel: '排队中', format: 'XLSX' })
    const data = prisma.exportJob.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: 'tenant-1', requestedBy: 'user-1', kind: 'orders', filterJson: { status: 'Shipped' } })
    expect(data.fieldPolicySnapshot).toMatchObject({ scope: { unrestricted: true, storeIds: [] } })
    expect(data.fieldPolicySnapshot.columns).toContain('amazonOrderId')
    expect(Math.round((data.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(7)
    expect(harness.queue.add).toHaveBeenCalledWith('exports', { tenantId: 'tenant-1', exportJobId: 'e-new' }, 'export:e-new')
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'EXPORT_REQUESTED', resourceType: 'ExportJob', resourceId: 'e-new' }))
  })

  it('保留天数取企业设置（P5-10）：设置了 14 天，新任务的到期时间按 14 天算；设置里的值不合格式时按默认 7 天', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    prisma.tenantSetting.findFirst.mockResolvedValue({ valueJson: { rawReportDays: 400, exportFileDays: 14, customerInfoDays: 30 } })
    harness = await createTestApp(prisma)
    await harness.call('POST', '/exports', { body: { kind: 'orders' } })
    expect(Math.round((prisma.exportJob.create.mock.calls[0][0].data.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(14)
    prisma.tenantSetting.findFirst.mockResolvedValue({ valueJson: { exportFileDays: 99 } })
    await harness.call('POST', '/exports', { body: { kind: 'orders' } })
    expect(Math.round((prisma.exportJob.create.mock.calls[1][0].data.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(7)
  })
  it('权限：没有 export.create 或没有数据读取权限都是 403', async () => {
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders' } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['export.create']))
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders' } })).status).toBe(403)
  })

  it('参数：不存在的数据类型、不支持的筛选条件、不存在的列、不支持的格式都是 422，且不创建任务', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/exports', { body: { kind: 'nope' } })).status).toBe(422)
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders', filters: { secret: 'x' } } })).status).toBe(422)
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders', columns: ['amazonOrderId', 'nope'] } })).status).toBe(422)
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders', format: 'PDF' } })).status).toBe(422)
    expect(prisma.exportJob.create).not.toHaveBeenCalled()
  })

  it('数据范围：受限成员只能导出被授权的店铺；请求授权之外的店铺返回 403', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'], { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/exports', { body: { kind: 'orders', filters: { storeIds: ['s1'] } } })
    expect(res.status).toBe(202)
    expect(prisma.exportJob.create.mock.calls[0][0].data.fieldPolicySnapshot.scope).toEqual({ unrestricted: false, storeIds: ['s1'] })
    prisma.sellerAccount.findMany.mockResolvedValue([])
    expect((await harness.call('POST', '/exports', { body: { kind: 'orders', filters: { storeIds: ['s9'] } } })).status).toBe(403)
  })

  it('同时进行的导出达到上限时拒绝（409）', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    prisma.exportJob.count.mockResolvedValue(3)
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/exports', { body: { kind: 'orders' } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('QUOTA_EXCEEDED')
    expect(prisma.exportJob.count.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', requestedBy: 'user-1', status: { in: ['QUEUED', 'RUNNING'] } })
  })

  it('队列不可用：任务标记为失败并返回 503，不留下“永远排队”的任务', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    harness = await createTestApp(prisma)
    harness.queue.add.mockRejectedValueOnce(new Error('redis down'))
    const res = await harness.call('POST', '/exports', { body: { kind: 'orders' } })
    expect(res.status).toBe(503)
    expect(prisma.exportJob.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'e-new' }, data: { status: 'FAILED', errorCode: 'EXPORT_QUEUE_UNAVAILABLE' } })
  })
})

describe('敏感字段', () => {
  it('没有字段权限的敏感列被去掉（不是留空），其余列照常导出', async () => {
    kinds.push(SENSITIVE)
    const prisma = prismaFor(['export.create', 'orders.read', 'field.profit'])
    harness = await createTestApp(prisma)
    // 选了利润列（有权限）→ 需要再次验证；先只选普通列与无权限的成本列
    const res = await harness.call('POST', '/exports', { body: { kind: 'test-costs', columns: ['sku', 'unitCost'] } })
    expect(res.status).toBe(202)
    expect(prisma.exportJob.create.mock.calls[0][0].data.fieldPolicySnapshot.columns).toEqual(['sku'])
    expect(audits(prisma)[0].detail).toMatchObject({ sensitive: false })
    expect((await harness.call('POST', '/exports', { body: { kind: 'test-costs', columns: ['unitCost'] } })).status).toBe(422)
  })

  it('含有权限的敏感列：必须先再次验证身份（STEP_UP_REQUIRED），验证后放行并把验证记录写入审计', async () => {
    kinds.push(SENSITIVE)
    const prisma = prismaFor(['export.create', 'orders.read', 'field.cost', 'field.profit'])
    harness = await createTestApp(prisma)
    const denied = await harness.call('POST', '/exports', { body: { kind: 'test-costs' } })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('STEP_UP_REQUIRED')
    expect(prisma.exportJob.create).not.toHaveBeenCalled()
    harness.writeGuardStubs.stepUpVerification.findFirst.mockResolvedValue({ id: 'step-1' })
    const res = await harness.call('POST', '/exports', { body: { kind: 'test-costs' } })
    expect(res.status).toBe(202)
    expect(prisma.exportJob.create.mock.calls[0][0].data.fieldPolicySnapshot.columns).toEqual(['sku', 'unitCost', 'margin'])
    expect(audits(prisma)[0]).toMatchObject({ action: 'EXPORT_REQUESTED', stepUpId: 'step-1', detail: expect.objectContaining({ sensitive: true }) })
  })
})

describe('查看与下载', () => {
  it('列表只返回自己发起的；已完成但已到期的显示已过期；失败显示中文原因，不暴露内部错误码', async () => {
    const prisma = prismaFor(['export.create'])
    prisma.exportJob.findMany.mockResolvedValue([
      job({ id: 'a', status: 'DONE', fileKey: 'k', fileSize: 10, rowCount: 3 }),
      job({ id: 'b', status: 'DONE', fileKey: 'k', expiresAt: new Date(NOW - 1000) }),
      job({ id: 'c', status: 'FAILED', errorCode: 'EXPORT_PERMISSION_REVOKED' }),
      job({ id: 'd', status: 'FAILED', errorCode: 'ECONNRESET_XYZ' }),
    ])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/exports')
    expect(res.status).toBe(200)
    const [a, b, c, d] = res.json.data.items
    expect(a).toMatchObject({ status: 'DONE', downloadable: true, rowCount: 3 })
    expect(b).toMatchObject({ status: 'EXPIRED', statusLabel: '已过期', downloadable: false })
    expect(c.errorMessage).toBe('发起人的导出权限已被收回，导出已取消')
    expect(d.errorMessage).toBe('生成失败，请重新发起')
    expect(JSON.stringify(res.json)).not.toContain('ECONNRESET_XYZ')
    expect(JSON.stringify(res.json)).not.toContain('fileKey')
    expect(prisma.exportJob.findMany.mock.calls[0][0].where.AND[0]).toEqual({ tenantId: 'tenant-1', requestedBy: 'user-1' })
  })

  it('详情与下载：别人的任务按“不存在”处理', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    prisma.exportJob.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/exports/e1')).status).toBe(404)
    expect((await harness.call('GET', '/exports/e1/download')).status).toBe(404)
    expect(prisma.exportJob.findFirst.mock.calls[0][0].where).toEqual({ id: 'e1', tenantId: 'tenant-1', requestedBy: 'user-1' })
  })

  it('下载：只有已完成且未过期的任务签发短时链接并写审计；未完成 409，已过期 410；发起人失去数据权限后不能下载', async () => {
    const prisma = prismaFor(['export.create', 'orders.read'])
    harness = await createTestApp(prisma)
    const signDownload = vi.fn().mockResolvedValue({ url: 'https://files.example/x?sig=1', method: 'GET', headers: {}, expiresAt: new Date(NOW + 300_000) })
    vi.spyOn(harness.app.get(ObjectStorageService), 'forTenant').mockReturnValue({ signDownload } as never)
    prisma.exportJob.findFirst.mockResolvedValue(job({ status: 'DONE', fileKey: 'tenants/tenant-1/exports/x.csv', fileSize: 99 }))
    const res = await harness.call('GET', '/exports/e1/download')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ url: 'https://files.example/x?sig=1', fileSize: 99 })
    expect(signDownload).toHaveBeenCalledWith('tenants/tenant-1/exports/x.csv', 300)
    expect(audits(prisma)).toContainEqual(expect.objectContaining({ action: 'EXPORT_DOWNLOAD_LINK_ISSUED', resourceId: 'e1' }))
    prisma.exportJob.findFirst.mockResolvedValue(job({ status: 'RUNNING' }))
    expect((await harness.call('GET', '/exports/e1/download')).status).toBe(409)
    prisma.exportJob.findFirst.mockResolvedValue(job({ status: 'DONE', fileKey: 'k', expiresAt: new Date(NOW - 1000) }))
    expect((await harness.call('GET', '/exports/e1/download')).status).toBe(410)
    expect(signDownload).toHaveBeenCalledTimes(1)
    await harness.close()
    const revoked = prismaFor(['export.create'])
    revoked.exportJob.findFirst.mockResolvedValue(job({ status: 'DONE', fileKey: 'k' }))
    harness = await createTestApp(revoked)
    expect((await harness.call('GET', '/exports/e1/download')).status).toBe(403)
  })
})
