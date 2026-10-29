import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from './testing/harness'
import { AUTHENTICATED_ONLY, PUBLIC_ROUTES } from './testing/route-registry'

// 越权测试套件（P1-29，11.4 / 12.6）：按“已注册的全部接口”逐条检查，新增接口不登记就过不了。
// 1. 除公开接口外，没有登录凭证一律 401；
// 2. 已登录但角色不含任何权限点，除“仅需登录”的接口外一律 403；
// 3. 在检查期间，数据库替身只提供会话与成员关系，任何接口一旦越过权限检查去读写数据，替身会直接报错，测试失败。

// 平台运营接口（P1-19）：使用独立的平台令牌与平台权限点，由平台守卫鉴权；成员令牌不能访问（401）。登录两步已列在公开接口里。
const isPlatformRoute = (route: string) => route.split(' ')[1].startsWith('/api/v1/platform/')

function collectRoutes(app: { getHttpAdapter(): { getInstance(): any } }): string[] {
  const stack: any[] = app.getHttpAdapter().getInstance()._router.stack
  const routes: string[] = []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${layer.route.path}`)
  }
  return routes
}

const concretePath = (route: string) =>
  route
    .split(' ')[1]
    .replace('/api/v1', '')
    .replace(':level', 'campaigns')
    .replace(/:[A-Za-z]+/g, 'x')

describe('越权测试套件', () => {
  let anonymous: Awaited<ReturnType<typeof createTestApp>>
  let noPermission: Awaited<ReturnType<typeof createTestApp>>
  let routes: string[]

  beforeAll(async () => {
    anonymous = await createTestApp({})
    routes = collectRoutes(anonymous.app)
    noPermission = await createTestApp({ ...sessionStub([]) })
  })
  afterAll(async () => {
    await anonymous.close()
    await noPermission.close()
  })

  it('公开与仅需登录的登记项都对应真实存在的接口', () => {
    const known = new Set(routes)
    expect(Object.keys(PUBLIC_ROUTES).filter(route => !known.has(route))).toEqual([])
    expect(Object.keys(AUTHENTICATED_ONLY).filter(route => !known.has(route))).toEqual([])
  })

  it('没有登录凭证时，非公开接口一律 401', async () => {
    const failures: string[] = []
    for (const route of routes) {
      if (route in PUBLIC_ROUTES) continue
      const [method] = route.split(' ')
      const res = await anonymous.call(method, concretePath(route), { auth: false, body: method === 'GET' ? undefined : {} })
      if (res.status !== 401) failures.push(`${route} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  })

  it('已登录但没有任何权限点时，需要权限的接口一律 403', async () => {
    const failures: string[] = []
    for (const route of routes) {
      if (route in PUBLIC_ROUTES || route in AUTHENTICATED_ONLY || isPlatformRoute(route)) continue
      const [method] = route.split(' ')
      // 故意带上不合法的参数：权限检查必须先于参数校验，无权限的人看不到校验细节
      const res = await noPermission.call(method, `${concretePath(route)}${method === 'GET' ? '?page=-1&pageSize=9999&dateFrom=bad' : ''}`, {
        body: method === 'GET' ? undefined : { invalid: true, items: 'bad', amount: 'bad' },
      })
      if (res.status !== 403) failures.push(`${route} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  })

  it('平台接口：企业成员的令牌不能访问（401），平台权限不来自企业角色', async () => {
    const failures: string[] = []
    for (const route of routes) {
      if (!isPlatformRoute(route) || route in PUBLIC_ROUTES) continue
      const [method] = route.split(' ')
      const res = await noPermission.call(method, concretePath(route), { body: method === 'GET' ? undefined : {} })
      if (res.status !== 401) failures.push(`${route} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  })
})
