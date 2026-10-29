import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const validForm = { name: '王五', company: '某某贸易有限公司', email: 'w@example.com', message: '想了解多店铺对账' }

function contactPrisma(permissions: string[] = ['connection.manage']) {
  return {
    ...sessionStub(permissions),
    contactRequest: {
      create: vi.fn().mockResolvedValue({ id: 'c1', createdAt: new Date('2026-10-21T00:00:00Z') }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: 'c1', status: 'CLOSED' }),
    },
  }
}

describe('官网咨询表单', () => {
  it('公开提交：落库、返回受理编号，并按来源地址限流', async () => {
    const prisma = contactPrisma()
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/contact-requests', { auth: false, body: validForm })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ accepted: true, reference: 'CONTACT-c1' })
    expect(harness.rateLimit.check).toHaveBeenCalledWith('contact', expect.any(String), 5, 300)
    expect(prisma.contactRequest.create).toHaveBeenCalledTimes(1)
  })

  it('蜜罐字段有值：回执成功但不落库', async () => {
    const prisma = contactPrisma()
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/contact-requests', { auth: false, body: { ...validForm, companyWebsite: 'http://spam' } })
    expect(res.json.data.reference).toBe('CONTACT-RECEIVED')
    expect(prisma.contactRequest.create).not.toHaveBeenCalled()
  })

  it('字段缺失返回 422', async () => {
    harness = await createTestApp(contactPrisma())
    expect((await harness.call('POST', '/contact-requests', { auth: false, body: { name: '王五' } })).status).toBe(422)
  })

  it('后台查看需要登录与连接管理权限；状态只接受约定值', async () => {
    harness = await createTestApp(contactPrisma())
    expect((await harness.call('GET', '/contact-requests', { auth: false })).status).toBe(401)
    expect((await harness.call('PATCH', '/contact-requests/c1', { body: { status: 'WHATEVER' } })).status).toBe(400)
    expect((await harness.call('PATCH', '/contact-requests/c1', { body: { status: 'CLOSED' } })).status).toBe(200)
  })
})
