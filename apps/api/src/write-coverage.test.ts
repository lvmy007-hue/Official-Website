import 'reflect-metadata'
import { ModulesContainer } from '@nestjs/core'
import { STEP_UP_ACTIONS } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WRITE_META, type WriteMeta } from './platform/write'
import { createTestApp } from './testing/harness'

// 写接口覆盖检查（P1-14 验收：所有写接口都经过拦截器）。
// 拦截器是全局注册的，POST/PUT/PATCH/DELETE 一定会经过；这里进一步保证每个写接口都做了显式声明
// （审计动作与对象类型，或写明理由的豁免），不会出现“忘了声明、靠默认值蒙混”的接口。

// 允许豁免幂等与通用审计的写接口：只能是没有登录态的公开接口、登录刷新、第三方回调，以及不改动业务数据的前端性能埋点。新增必须在此登记。
const ALLOWED_EXEMPT = new Set([
  'POST telemetry/web-vitals',
  'POST auth/login',
  'POST auth/refresh',
  'POST contact-requests',
  'POST commerce/orders',
  'POST commerce/orders/:orderNo/pay',
  'POST commerce/orders/:orderNo/refunds',
  'POST payments/alipay/notify',
  'PUT storage/local/:token',
  // P1-19：邀请与平台账号接口（平台守卫鉴权，不经企业幂等与通用审计，服务内写企业审计）
  'POST auth/invitations/:token/accept',
  'POST platform/auth/login',
  'POST platform/auth/mfa/verify',
  'POST platform/auth/logout',
  'POST platform/tenants',
  'POST platform/tenants/:id/invite',
  'POST platform/tenants/:id/suspend',
  'POST platform/tenants/:id/resume',
  'POST platform/tenants/:id/deactivate',
  'POST platform/tenants/:id/close',
  'PUT platform/tenants/:id/quota',
  'POST platform/support-access',
])

const METHODS: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH', 5: 'ALL', 6: 'OPTIONS', 7: 'HEAD' }
const joinPath = (...parts: string[]) =>
  parts
    .map(part => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')

interface RouteInfo {
  method: string
  path: string
  meta: WriteMeta | undefined
}

function writeRoutes(modules: ModulesContainer): RouteInfo[] {
  const routes: RouteInfo[] = []
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null
      if (!controller) continue
      const base = Reflect.getMetadata('path', controller) as string | undefined
      const prototype = controller.prototype
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name]
        if (typeof handler !== 'function' || name === 'constructor') continue
        const methodCode = Reflect.getMetadata('method', handler) as number | undefined
        if (methodCode === undefined) continue
        const method = METHODS[methodCode]
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) continue
        const path = joinPath(typeof base === 'string' ? base : '', String(Reflect.getMetadata('path', handler) ?? ''))
        const meta = (Reflect.getMetadata(WRITE_META, handler) ?? Reflect.getMetadata(WRITE_META, controller)) as WriteMeta | undefined
        routes.push({ method, path, meta })
      }
    }
  }
  return routes
}

describe('写接口覆盖（P1-14）', () => {
  let harness: Awaited<ReturnType<typeof createTestApp>>
  let routes: RouteInfo[]

  beforeAll(async () => {
    harness = await createTestApp({})
    routes = writeRoutes(harness.app.get(ModulesContainer, { strict: false }))
  })
  afterAll(async () => {
    await harness.close()
  })

  it('确实扫描到了写接口', () => {
    expect(routes.length).toBeGreaterThanOrEqual(20)
  })

  it('每个写接口都显式声明了：审计动作与对象类型，或写明理由的豁免', () => {
    const undeclared = routes.filter(route => !route.meta).map(route => `${route.method} ${route.path}`)
    expect(undeclared).toEqual([])
  })

  it('审计动作名全大写下划线；对象类型不为空；再次验证的操作必须是登记过的', () => {
    const problems: string[] = []
    for (const route of routes) {
      const meta = route.meta
      if (meta?.kind !== 'write') continue
      if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(meta.action)) problems.push(`${route.method} ${route.path}：动作名 ${meta.action} 不规范`)
      if (!meta.resourceType.trim()) problems.push(`${route.method} ${route.path}：缺少对象类型`)
      if (meta.stepUp && !(meta.stepUp in STEP_UP_ACTIONS)) problems.push(`${route.method} ${route.path}：未登记的再次验证操作 ${meta.stepUp}`)
    }
    expect(problems).toEqual([])
  })

  it('豁免的写接口只限登记过的公开接口、登录刷新与第三方回调，且写明了理由', () => {
    const exempt = routes.filter(route => route.meta?.kind === 'exempt')
    const unexpected = exempt.filter(route => !ALLOWED_EXEMPT.has(`${route.method} ${route.path}`)).map(route => `${route.method} ${route.path}`)
    expect(unexpected).toEqual([])
    const noReason = exempt.filter(route => route.meta?.kind === 'exempt' && route.meta.reason.trim().length < 8).map(route => `${route.method} ${route.path}`)
    expect(noReason).toEqual([])
    // 登记项都真实存在，避免登记表里留着已删除的接口
    const present = new Set(exempt.map(route => `${route.method} ${route.path}`))
    expect([...ALLOWED_EXEMPT].filter(item => !present.has(item))).toEqual([])
  })
})
