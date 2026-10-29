import { hashSync } from 'bcryptjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function prismaFor(permissions: string[]) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    // 事务回调里拿到的就是这个对象，审计事件必须在它上面
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    legalEntity: {
      create: vi.fn().mockResolvedValue({ id: 'e2', name: '主体乙', registeredCountry: '中国', registrationNo: null, status: 'ACTIVE', version: 1, createdAt: new Date('2026-10-01T00:00:00Z') }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ passwordHash: hashSync('right-password', 4), status: 'ACTIVE' }) },
    stepUpVerification: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'su-1', action: data.action, method: data.method, expiresAt: data.expiresAt })),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  return prisma
}

const body = { name: '主体乙', registeredCountry: '中国' }

describe('写接口：幂等键、重复提交与审计（经过真实应用）', () => {
  it('写接口必须带幂等键；格式不合法同样拒绝；都不会执行业务', async () => {
    const prisma = prismaFor(['entity.write'])
    harness = await createTestApp(prisma)
    const missing = await harness.call('POST', '/entities', { body, idempotencyKey: false })
    expect(missing.status).toBe(400)
    expect(missing.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect(missing.json.error.requestId).toBeTruthy()
    const invalid = await harness.call('POST', '/entities', { body, idempotencyKey: 'bad key!' })
    expect(invalid.json.error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(prisma.legalEntity.create).not.toHaveBeenCalled()
  })

  it('首次成功：业务与审计在同一事务；审计带请求编号、来源地址、访问模式与修改后的内容；结果先保存再返回', async () => {
    const prisma = prismaFor(['entity.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/entities', { body, headers: { 'x-request-id': 'req-write-0001', 'user-agent': 'vitest-agent' }, idempotencyKey: 'key-first-0001' })
    expect(res.status).toBe(201)
    expect(prisma.$transaction).toHaveBeenCalled()
    const audit = prisma.auditEvent.create.mock.calls
    expect(audit).toHaveLength(1)
    expect(audit[0][0].data).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      action: 'LEGAL_ENTITY_CREATED',
      resourceType: 'LegalEntity',
      resourceId: 'e2',
      requestId: 'req-write-0001',
      result: 'SUCCEEDED',
      userAgent: 'vitest-agent',
      afterJson: { name: '主体乙', registeredCountry: '中国' },
      detail: { accessMode: 'NORMAL', changes: expect.arrayContaining([{ field: 'name', before: null, after: '主体乙' }]) },
    })
    expect(audit[0][0].data.ip).toBeTruthy()
    // 拦截器没有再补写第二条通用审计
    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1)
    const stored = harness.writeGuardStubs.idempotencyRecord.update.mock.calls[0][0]
    expect(stored.where).toEqual({ id: 'idem-1' })
    expect(stored.data).toMatchObject({ responseStatus: 201, responseJson: { success: true, data: { id: 'e2' } } })
    expect(harness.writeGuardStubs.idempotencyRecord.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', key: 'key-first-0001', route: 'POST /api/v1/entities' })
  })

  it('重复提交：返回同一个结果与状态码，标注重放，业务与审计都不再执行', async () => {
    const prisma = prismaFor(['entity.write'])
    harness = await createTestApp(prisma)
    const stubs = harness.writeGuardStubs.idempotencyRecord
    stubs.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    stubs.findUnique.mockImplementation(async () => ({
      id: 'idem-old',
      requestHash: '',
      responseStatus: 201,
      responseJson: { success: true, data: { id: 'e-first' }, meta: { requestId: 'req-first' } },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    // 摘要不一致 → 422；让它一致：先发一次拿到真实摘要
    const mismatch = await harness.call('POST', '/entities', { body, idempotencyKey: 'key-replay-0001' })
    expect(mismatch.status).toBe(422)
    expect(mismatch.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const lookedUp = stubs.create.mock.calls[0][0].data.requestHash as string
    stubs.findUnique.mockImplementation(async () => ({
      id: 'idem-old',
      requestHash: lookedUp,
      responseStatus: 201,
      responseJson: { success: true, data: { id: 'e-first' }, meta: { requestId: 'req-first' } },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    const replay = await harness.call('POST', '/entities', { body, idempotencyKey: 'key-replay-0001' })
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(replay.json).toEqual({ success: true, data: { id: 'e-first' }, meta: { requestId: 'req-first' } })
    expect(prisma.legalEntity.create).not.toHaveBeenCalled()
    expect(prisma.auditEvent.create).not.toHaveBeenCalled()
  })

  it('同一个键仍在处理中：409 IDEMPOTENCY_IN_PROGRESS，可重试', async () => {
    harness = await createTestApp(prismaFor(['entity.write']))
    const stubs = harness.writeGuardStubs.idempotencyRecord
    stubs.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    stubs.findUnique.mockImplementation(async () => ({ id: 'idem-old', requestHash: '', responseStatus: null, responseJson: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }))
    const first = await harness.call('POST', '/entities', { body, idempotencyKey: 'key-busy-0001' })
    // 摘要不一致优先于“处理中”：不同内容永远不能共用一个键
    expect(first.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const hash = stubs.create.mock.calls[0][0].data.requestHash as string
    stubs.findUnique.mockImplementation(async () => ({
      id: 'idem-old',
      requestHash: hash,
      responseStatus: null,
      responseJson: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    const busy = await harness.call('POST', '/entities', { body, idempotencyKey: 'key-busy-0001' })
    expect(busy.status).toBe(409)
    expect(busy.json.error).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true })
  })

  it('参数校验失败（422）：释放幂等记录，修正后可以用同一个键重试', async () => {
    const prisma = prismaFor(['entity.write'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/entities', { body: { name: 'x' }, idempotencyKey: 'key-invalid-0001' })
    expect(res.status).toBe(422)
    await vi.waitFor(() => expect(harness!.writeGuardStubs.idempotencyRecord.deleteMany).toHaveBeenCalledWith({ where: { id: 'idem-1', responseStatus: null } }))
    expect(prisma.auditEvent.create).not.toHaveBeenCalled()
  })

  it('没有权限：先于幂等处理被拒绝（403），并留下 DENIED 审计，业务数据不动', async () => {
    const prisma = prismaFor(['orders.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/entities', { body })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
    expect(prisma.legalEntity.create).not.toHaveBeenCalled()
    expect(harness.writeGuardStubs.idempotencyRecord.create).not.toHaveBeenCalled()
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'LEGAL_ENTITY_CREATED', result: 'DENIED', detail: { status: 403, errorCode: 'TENANT_ACCESS_DENIED' } })
  })

  it('统一错误体：路径不存在带统一错误码，不暴露内部细节', async () => {
    harness = await createTestApp(prismaFor([]))
    const res = await harness.call('GET', '/nonexistent-path')
    expect(res.status).toBe(404)
    expect(res.json.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
    expect(res.json.error.requestId).toBeTruthy()
    expect(JSON.stringify(res.json)).not.toContain('Cannot')
  })
})

describe('再次验证身份：POST /auth/step-up', () => {
  it('密码正确：返回操作与有效期，并写审计', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/auth/step-up', { body: { action: 'role.manage', password: 'right-password' } })
    expect(res.status).toBe(200)
    expect(res.json.data.action).toBe('role.manage')
    expect(new Date(res.json.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(prisma.stepUpVerification.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', action: 'role.manage', method: 'PASSWORD' })
    const audit = prisma.auditEvent.create.mock.calls.map((call: any[]) => call[0].data)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'STEP_UP_VERIFIED', resourceType: 'StepUp', detail: { action: 'role.manage', method: 'PASSWORD' } })
  })

  it('密码错误：403 STEP_UP_FAILED，不留验证记录，不返回任何令牌', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/auth/step-up', { body: { action: 'role.manage', password: 'wrong' } })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('STEP_UP_FAILED')
    expect(prisma.stepUpVerification.create).not.toHaveBeenCalled()
  })

  it('不是登记过的操作、缺少密码：422', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('POST', '/auth/step-up', { body: { action: 'delete.everything', password: 'x' } })).status).toBe(422)
    expect((await harness.call('POST', '/auth/step-up', { body: { action: 'role.manage' } })).status).toBe(422)
  })

  it('没有登录凭证：401', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('POST', '/auth/step-up', { auth: false, body: { action: 'role.manage', password: 'x' } })).status).toBe(401)
  })
})
