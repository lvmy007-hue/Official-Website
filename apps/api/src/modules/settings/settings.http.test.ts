import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function prismaFor(permissions: string[], current: Record<string, unknown> | null = null) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenantSetting: {
      findFirst: vi.fn().mockResolvedValue(current),
      create: vi.fn().mockResolvedValue({ version: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  return prisma
}

const valid = { CRITICAL: 2, WARNING: 12, INFO: 48 }

describe('企业偏好设置', () => {
  it('读取：没有记录返回默认值（严重 4、警告 24、提示 72 小时），版本为 0', async () => {
    harness = await createTestApp(prismaFor(['settings.read']))
    const res = await harness.call('GET', '/settings/preferences')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toEqual([
      expect.objectContaining({ key: 'work.sla.hours', value: { CRITICAL: 4, WARNING: 24, INFO: 72 }, version: 0 }),
      expect.objectContaining({ key: 'reimbursement.windows', version: 0 }),
    ])
  })

  it('读取：库里的值格式不对时按默认值处理', async () => {
    harness = await createTestApp(prismaFor(['settings.read'], { valueJson: { CRITICAL: 99, WARNING: 1, INFO: 1 }, version: 4 }))
    const res = await harness.call('GET', '/settings/preferences')
    expect(res.json.data.items[0]).toMatchObject({ value: { CRITICAL: 4, WARNING: 24, INFO: 72 }, version: 4 })
    expect(res.json.data.items[1]).toMatchObject({ key: 'reimbursement.windows', version: 4 })
  })

  it('修改：需要 settings.write；首次创建要求版本 0；写审计（含原因与前后值）', async () => {
    const prisma = prismaFor(['settings.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/settings/preferences/work.sla.hours', { body: { value: valid, version: 0, reason: '缩短处理时限' } })
    expect(res.status).toBe(200)
    expect(prisma.tenantSetting.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', key: 'work.sla.hours', valueJson: valid, updatedBy: 'user-1' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'TENANT_SETTING_UPDATED', reason: '缩短处理时限', resourceId: 'work.sla.hours' })
    await harness.close()
    harness = await createTestApp(prismaFor(['settings.read']))
    expect((await harness.call('PUT', '/settings/preferences/work.sla.hours', { body: { value: valid, version: 0, reason: '缩短处理时限' } })).status).toBe(403)
  })

  it('修改：格式不对、严重度时限顺序颠倒、缺原因都返回 422；版本不一致返回 409；其他键不存在', async () => {
    const prisma = prismaFor(['settings.write'], { id: 's1', version: 3, valueJson: valid })
    harness = await createTestApp(prisma)
    const put = (body: unknown, key = 'work.sla.hours') => harness!.call('PUT', `/settings/preferences/${key}`, { body })
    expect((await put({ value: { CRITICAL: 0, WARNING: 12, INFO: 48 }, version: 3, reason: '测试' })).status).toBe(422)
    expect((await put({ value: { CRITICAL: 30, WARNING: 12, INFO: 48 }, version: 3, reason: '测试' })).status).toBe(422)
    expect((await put({ value: valid, version: 3 })).status).toBe(422)
    prisma.tenantSetting.updateMany.mockResolvedValue({ count: 0 })
    const conflict = await put({ value: valid, version: 2, reason: '测试冲突' })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 2 })
    expect((await put({ value: [], version: 0, reason: '测试' }, 'fx.extraCurrencies')).status).toBe(404)
  })
})
