import 'reflect-metadata'
import { Reflector } from '@nestjs/core'
import { defer, lastValueFrom } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import { AppError, IdempotentReplay, appError } from '../../platform/http'
import type { ApiContext } from '../../platform/http'
import { WRITE_META, type WriteMeta } from '../../platform/write'
import { WriteInterceptor } from './write.interceptor'

const context: ApiContext = { userId: 'u1', sessionId: 's1', tenantId: 't1', membershipId: 'm1', permissions: ['member.manage'] }
const KEY = 'idem-key-0001'

class DemoController {
  handler() {}
}

function setup(
  options: {
    method?: string
    meta?: WriteMeta
    user?: boolean
    headers?: Record<string, string>
    body?: unknown
    begin?: unknown
    stepUpId?: string
    stepUpError?: Error
    requirePermission?: Error
  } = {},
) {
  const meta = 'meta' in options ? options.meta : ({ kind: 'write', action: 'DEMO_CHANGED', resourceType: 'Demo' } as WriteMeta)
  if (meta) Reflect.defineMetadata(WRITE_META, meta, DemoController.prototype.handler)
  else Reflect.deleteMetadata(WRITE_META, DemoController.prototype.handler)

  const headers: Record<string, string> = { 'idempotency-key': KEY, ...(options.headers ?? {}) }
  const sent: { status: number; body: unknown }[] = []
  const res = {
    statusCode: 201,
    json: vi.fn(function (this: unknown, body: unknown) {
      sent.push({ status: res.statusCode, body })
      return res
    }),
  }
  const req: any = {
    method: options.method ?? 'POST',
    user: options.user === false ? undefined : { userId: 'u1', sessionId: 's1' },
    header: (name: string) => headers[name.toLowerCase()],
    body: options.body ?? { name: '甲' },
    params: { id: 'obj-1' },
    query: {},
    route: { path: '/demo/:id' },
    baseUrl: '/api/v1',
    requestId: 'req-1',
    ip: '203.0.113.9',
  }
  const contexts = {
    resolve: vi.fn().mockImplementation(async (request: any) => (request.apiContext = context)),
    require: vi.fn().mockImplementation(() => {
      if (options.requirePermission) throw options.requirePermission
    }),
  }
  const idempotency = {
    purgeOpportunistically: vi.fn(),
    begin: vi.fn().mockResolvedValue(options.begin ?? { state: 'new', recordId: 'rec-1' }),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  }
  const stepUp = {
    require: vi.fn().mockImplementation(async () => {
      if (options.stepUpError) throw options.stepUpError
      return options.stepUpId ?? 'su-1'
    }),
  }
  const audit = { recordQuietly: vi.fn().mockResolvedValue(undefined) }
  const interceptor = new WriteInterceptor(new Reflector(), contexts as any, idempotency as any, stepUp as any, audit as any)
  const execution: any = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => DemoController.prototype.handler,
    getClass: () => DemoController,
  }
  const run = (handler: () => unknown = () => ({ data: 'ok' })) => lastValueFrom(interceptor.intercept(execution, { handle: () => defer(async () => handler()) }))
  return { run, req, res, sent, contexts, idempotency, stepUp, audit }
}

describe('写接口拦截器', () => {
  it('读请求（GET/HEAD/OPTIONS）不经过任何写入处理', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const t = setup({ method })
      expect(await t.run()).toEqual({ data: 'ok' })
      expect(t.contexts.resolve).not.toHaveBeenCalled()
      expect(t.idempotency.begin).not.toHaveBeenCalled()
    }
  })

  it('声明为豁免的写接口（公开接口、登录等）直接放行', async () => {
    const t = setup({ meta: { kind: 'exempt', reason: '公开接口' }, user: false, headers: { 'idempotency-key': '' } })
    expect(await t.run()).toEqual({ data: 'ok' })
    expect(t.idempotency.begin).not.toHaveBeenCalled()
    expect(t.audit.recordQuietly).not.toHaveBeenCalled()
  })

  it('缺少幂等键返回 400 IDEMPOTENCY_KEY_REQUIRED，业务不执行', async () => {
    const t = setup({ headers: { 'idempotency-key': '' } })
    const handler = vi.fn()
    await expect(t.run(handler)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(handler).not.toHaveBeenCalled()
    expect(t.audit.recordQuietly).not.toHaveBeenCalled()
  })

  it('幂等键格式不合法返回 400 IDEMPOTENCY_KEY_INVALID', async () => {
    const t = setup({ headers: { 'idempotency-key': 'short' } })
    await expect(t.run()).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' })
    const space = setup({ headers: { 'idempotency-key': 'has space in it' } })
    await expect(space.run()).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' })
  })

  it('首次请求：登记幂等记录，业务执行，响应发出前保存结果，并补写一条通用审计', async () => {
    const t = setup()
    const result = await t.run(() => {
      t.res.json({ success: true, data: { id: 'new-1' } })
      return { data: 'ok' }
    })
    expect(result).toEqual({ data: 'ok' })
    expect(t.idempotency.begin).toHaveBeenCalledWith('t1', KEY, 'POST /api/v1/demo/:id', expect.stringMatching(/^[0-9a-f]{64}$/))
    // 响应体已原样发出，同时保存了首次结果
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    expect(t.idempotency.complete).toHaveBeenCalledWith('rec-1', 201, { success: true, data: { id: 'new-1' } })
    expect(t.audit.recordQuietly).toHaveBeenCalledTimes(1)
    expect(t.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ action: 'DEMO_CHANGED', resourceType: 'Demo', resourceId: 'obj-1', detail: { route: 'POST /api/v1/demo/:id' } })
  })

  it('重复提交：直接返回首次结果（IdempotentReplay），业务与审计都不再执行', async () => {
    const t = setup({ begin: { state: 'replay', status: 201, body: { data: { id: 'first' } } } })
    const handler = vi.fn()
    const error = await t.run(handler).then(
      () => null,
      e => e,
    )
    expect(error).toBeInstanceOf(IdempotentReplay)
    expect(error).toMatchObject({ status: 201, body: { data: { id: 'first' } } })
    expect(handler).not.toHaveBeenCalled()
    expect(t.audit.recordQuietly).not.toHaveBeenCalled()
    expect(t.idempotency.release).not.toHaveBeenCalled()
  })

  it('业务失败：释放幂等记录，客户端修正后可以用同一个键重试；校验类错误不进审计', async () => {
    const t = setup()
    await expect(
      t.run(() => {
        throw new AppError(422, 'VALIDATION_FAILED', '参数不对')
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(t.idempotency.release).toHaveBeenCalledWith('rec-1')
    expect(t.audit.recordQuietly).not.toHaveBeenCalled()
  })

  it('被拒绝的写操作（403）记 DENIED，服务端失败（500）记 FAILED，且都带错误码，业务数据不受影响', async () => {
    const denied = setup()
    await expect(
      denied.run(() => {
        throw appError('TENANT_ACCESS_DENIED', '没有权限')
      }),
    ).rejects.toBeInstanceOf(AppError)
    expect(denied.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ result: 'DENIED', detail: { status: 403, errorCode: 'TENANT_ACCESS_DENIED' } })
    const failed = setup()
    await expect(
      failed.run(() => {
        throw new Error('数据库连接断开')
      }),
    ).rejects.toThrow('数据库连接断开')
    expect(failed.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ result: 'FAILED', detail: { status: 500 } })
  })

  it('幂等相关的拒绝（处理中、内容不一致）不进审计，也不释放别人的记录', async () => {
    const t = setup()
    t.idempotency.begin.mockRejectedValue(appError('IDEMPOTENCY_IN_PROGRESS', '处理中'))
    await expect(t.run()).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' })
    expect(t.audit.recordQuietly).not.toHaveBeenCalled()
    expect(t.idempotency.release).not.toHaveBeenCalled()
  })

  it('领域服务已经写了业务审计：不再补写通用审计；声明 audit:false 同样不补写', async () => {
    const own = setup()
    await own.run(() => {
      own.req.auditRecorded = true
    })
    expect(own.audit.recordQuietly).not.toHaveBeenCalled()
    const manual = setup({ meta: { kind: 'write', action: 'X', resourceType: 'Y', audit: false } })
    await manual.run()
    expect(manual.audit.recordQuietly).not.toHaveBeenCalled()
  })

  it('审计里带上请求体里的原因（reason）', async () => {
    const t = setup({ body: { reason: '客户要求停用' } })
    await t.run()
    expect(t.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ reason: '客户要求停用' })
  })

  it('声明了权限预检：没有权限先于再次验证与幂等处理，直接拒绝并记 DENIED', async () => {
    const t = setup({
      meta: { kind: 'write', action: 'ROLE_CHANGED', resourceType: 'Role', permission: 'role.manage', stepUp: 'role.manage' },
      requirePermission: appError('TENANT_ACCESS_DENIED', '没有权限'),
    })
    await expect(t.run()).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' })
    expect(t.contexts.require).toHaveBeenCalledWith(context, 'role.manage')
    expect(t.stepUp.require).not.toHaveBeenCalled()
    expect(t.idempotency.begin).not.toHaveBeenCalled()
    expect(t.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ result: 'DENIED' })
  })

  it('高风险操作：没有有效的再次验证返回 STEP_UP_REQUIRED，业务不执行；验证过则记录编号进入审计', async () => {
    const meta: WriteMeta = { kind: 'write', action: 'ROLE_CHANGED', resourceType: 'Role', stepUp: 'role.manage' }
    const missing = setup({ meta, stepUpError: appError('STEP_UP_REQUIRED', '需要再次验证', { details: { action: 'role.manage' } }) })
    const handler = vi.fn()
    await expect(missing.run(handler)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'role.manage' } })
    expect(handler).not.toHaveBeenCalled()
    expect(missing.idempotency.begin).not.toHaveBeenCalled()

    const verified = setup({ meta, stepUpId: 'su-77' })
    await verified.run()
    expect(verified.stepUp.require).toHaveBeenCalledWith(context, 'role.manage')
    expect(verified.req.stepUpId).toBe('su-77')
  })

  it('没有声明的写接口按最严格的默认处理：同样要求幂等键并补写审计', async () => {
    const t = setup({ meta: undefined })
    await t.run()
    expect(t.idempotency.begin).toHaveBeenCalled()
    expect(t.audit.recordQuietly.mock.calls[0][1]).toMatchObject({ action: 'POST_/api/v1/demo/:id', resourceType: 'Demo' })
    const noKey = setup({ meta: undefined, headers: { 'idempotency-key': '' } })
    await expect(noKey.run()).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })

  it('响应发出前才保存结果：失败响应（状态码 ≥ 300）释放记录而不是保存', async () => {
    const t = setup()
    await t.run(() => {
      t.res.statusCode = 409
      t.res.json({ success: false })
    })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    expect(t.idempotency.complete).not.toHaveBeenCalled()
    expect(t.idempotency.release).toHaveBeenCalledWith('rec-1')
  })

  it('保存结果失败不影响响应发出', async () => {
    const t = setup()
    t.idempotency.complete.mockRejectedValue(new Error('库不可用'))
    await t.run(() => {
      t.res.json({ data: 1 })
    })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
  })

  it('没有登录态的未声明写接口不参与幂等（由登录守卫负责拒绝）', async () => {
    const t = setup({ user: false })
    expect(await t.run()).toEqual({ data: 'ok' })
    expect(t.idempotency.begin).not.toHaveBeenCalled()
  })

  it('抛出的错误原样传给异常过滤器', async () => {
    const t = setup()
    const boom = new AppError(409, 'CONFLICT', '对象已被他人修改')
    await expect(
      t.run(() => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })
})
