import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../testing/harness'

// 未预期的内部错误（P1-17，12.9 第 12 条）：对外只给统一的提示与请求编号；只有明确的开发模式才返回原始错误信息。
describe('内部错误不泄露细节', () => {
  let harness: Awaited<ReturnType<typeof createTestApp>>
  const previous = process.env.APP_MODE

  beforeAll(async () => {
    // 会话与权限可以通过，但读取用户资料时替身未提供对应能力，会抛出普通错误（内部错误）
    harness = await createTestApp({ ...sessionStub(['entity.read']) })
  })
  afterAll(async () => {
    process.env.APP_MODE = previous
    await harness.close()
  })

  for (const mode of ['production', 'test', 'staging']) {
    it(`${mode} 模式：返回统一提示与请求编号，不含内部信息`, async () => {
      process.env.APP_MODE = mode
      const res = await harness.call('GET', '/auth/me')
      expect(res.status).toBe(500)
      expect(res.json.error.code).toBe('INTERNAL_ERROR')
      expect(res.json.error.message).toBe('服务暂时无法完成请求，提供 Request ID 供排查')
      expect(res.json.error.requestId).toBeTruthy()
      expect(JSON.stringify(res.json)).not.toMatch(/prisma|替身|stack|at /)
    })
  }

  it('参数校验失败：422 与 fieldErrors 的默认文案保持 zod 3 风格（X-01 升级 zod 4 后不变）', async () => {
    process.env.APP_MODE = 'test'
    const res = await harness.call('POST', '/auth/login', { body: { email: 'not-an-email', tenantId: 5 }, auth: false })
    expect(res.status).toBe(422)
    expect(res.json.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '请求参数校验失败，请检查输入',
      fieldErrors: { email: ['Invalid email'], password: ['Required'], tenantId: ['Expected string, received number'] },
    })
  })

  it('开发模式：返回原始错误信息，方便本地排查', async () => {
    process.env.APP_MODE = 'development'
    const res = await harness.call('GET', '/auth/me')
    expect(res.status).toBe(500)
    expect(res.json.error.message).toMatch(/prisma/)
  })
})
