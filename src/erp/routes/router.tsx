import { Suspense, lazy, useEffect, type ComponentType } from 'react'
import { createRootRouteWithContext, createRoute, createRouter, createMemoryHistory, isNotFound, lazyRouteComponent, notFound, Outlet, redirect, type RouterHistory } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import type { SearchParser } from '@nova/api-contracts'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { describeError } from '../query/errors'
import { validateScope } from '../scope/params'
import { AppLayout } from '../shell/AppLayout'

import { hasPlatformToken } from '../platform/platform-api'
import { hasPlatformPermission, platformMeQuery } from '../platform/platform-queries'
import { meQueryOptions, useSession } from '../session/session'
import { LIVE_PAGES, type LivePages } from './live-pages'
import { APP_ROUTES, REDIRECTS, buildNav, matchManifest, requiredPermissionText, specByPath, type RouteSpec } from './manifest'
import { parseSearch, stringifySearch } from './search'
import { ForbiddenPage, NotFoundPage, SearchParamErrorPage } from './status-pages'

// 路由树（P1-03）：由路由清单与“已上线页面登记表”生成。
// - 页面按需加载（每个页面一个独立的代码块）；
// - 所有页面共享 /app 布局：登录检查、全局范围参数校验、外壳；
// - 未登记（未上线）的页面不注册，直接访问落到“页面不存在”页；
// - 权限不足的页面保留地址，显示“无权限”并说明所需权限点。

export type RouterContext = { queryClient: QueryClient }

/** 地址栏参数不合法：带中文原因，由错误页展示。 */
export class SearchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchValidationError'
  }
}

const toRouterPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '$$$1')

function makeValidateSearch(page: { search?: SearchParser } | undefined) {
  return (raw: Record<string, unknown>) => {
    if (page?.search) {
      const result = page.search.safeParse(raw)
      if (!result.success) throw new SearchValidationError(result.error.issues[0]?.message ?? '筛选参数不正确')
      return result.data as Record<string, unknown>
    }
    const scope = validateScope(raw)
    if (!scope.ok) throw new SearchValidationError(scope.message)
    return scope.scope
  }
}

function RouteError({ error, reset, resetTo }: { error: unknown; reset: () => void; resetTo: string }) {
  const cause = (error as { cause?: unknown } | null)?.cause
  const validation = error instanceof SearchValidationError ? error : cause instanceof SearchValidationError ? cause : null
  if (validation) return <SearchParamErrorPage message={validation.message} resetTo={resetTo} />
  return <DataState {...stateFromError(describeError(error), { onRetry: reset })} />
}

function PageHost({ spec, Page }: { spec: RouteSpec; Page: ComponentType }) {
  const { can } = useSession()
  useEffect(() => {
    document.title = `${spec.title}｜NOVA ERP`
  }, [spec.title])
  if (!can(spec.access)) return <ForbiddenPage permission={requiredPermissionText(spec.access)} />
  return (
    <Suspense fallback={<DataState kind="skeleton" />}>
      <Page />
    </Suspense>
  )
}

export function createErpRouter(options: { queryClient: QueryClient; pages?: LivePages; history?: RouterHistory }) {
  const pages = options.pages ?? LIVE_PAGES

  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    notFoundComponent: NotFoundPage,
  })

  const loginRoutes = ['/login', '/app/login'].map(path =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      validateSearch: (raw: Record<string, unknown>) => ({ redirect: typeof raw.redirect === 'string' && raw.redirect.startsWith('/app') ? raw.redirect : undefined }),
      // 已经登录的人访问登录页，直接进入工作区
      beforeLoad: async ({ context }) => {
        try {
          await context.queryClient.ensureQueryData(meQueryOptions)
        } catch {
          return
        }
        throw redirect({ to: '/app' })
      },
      // 登录页单独加载：已登录用户进入外壳时不需要表单组件（首屏脚本预算，P1-09）
      component: lazyRouteComponent(() => import('../pages/LoginPage'), 'LoginPage'),
    }),
  )

  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app',
    validateSearch: makeValidateSearch(undefined),
    beforeLoad: async ({ context, location }) => {
      try {
        await context.queryClient.ensureQueryData(meQueryOptions)
      } catch (error) {
        if (describeError(error).kind === 'unauthorized') throw redirect({ to: '/app/login', search: { redirect: location.pathname + location.searchStr } as never })
        throw error
      }
    },
    component: () => <AppLayout pages={pages} />,
    notFoundComponent: NotFoundPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} resetTo="/app/overview" />,
  })

  const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/',
    // 进入工作区：优先经营控制台；当前成员没有它的权限时进入第一个有权限的页面
    beforeLoad: async ({ context }) => {
      const me = await context.queryClient.ensureQueryData(meQueryOptions)
      const subject = { permissions: me.permissions }
      const groups = buildNav(component => component in pages, subject)
      const overviewOk = groups.some(group => group.items.some(item => item.path === '/app/overview'))
      throw redirect({ to: overviewOk ? '/app/overview' : (groups[0]?.items[0]?.path ?? '/app/overview') })
    },
  })

  const redirectRoutes = REDIRECTS.filter(item => item.from !== '/app').map(item =>
    createRoute({
      getParentRoute: () => appRoute,
      path: item.from.replace('/app', ''),
      beforeLoad: () => {
        throw redirect({ to: item.to })
      },
    }),
  )

  const pageRoutes = APP_ROUTES.filter(spec => spec.component in pages).map(spec => {
    const page = pages[spec.component]
    const Page = lazy(page.load)
    const isDetail = spec.path.includes(':')
    const resetTo = isDetail ? '/app/overview' : spec.path
    return createRoute({
      getParentRoute: () => appRoute,
      path: toRouterPath(spec.path.replace('/app', '')),
      // 动态路由会吞掉同级的静态路径（如 /app/inventory/movement 被当成库存编号）：
      // 静态路径对应的页面还没上线时，要和其他未上线页面一样显示“页面不存在”（routes.md 第三节），而不是拿它去查编号
      beforeLoad: isDetail
        ? ({ location }) => {
            try {
              const hit = matchManifest(location.pathname)
              if (hit && hit.spec.path !== spec.path && !(hit.spec.component in pages)) throw notFound()
            } catch (error) {
              // 地址里有不合法的百分号编码时 matchManifest 会抛错：交给页面自己的“找不到”处理，不在这里报错；notFound 要继续往外抛
              if (isNotFound(error)) throw error
            }
          }
        : undefined,
      validateSearch: makeValidateSearch(page),
      component: () => <PageHost spec={spec} Page={Page} />,
      errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} resetTo={resetTo} />,
    })
  })

  // 初始化向导（P1-19）：属于 /app 工作区（需要登录），不进侧边导航；仅所有者与管理员可进入
  const onboardingSpec = specByPath.get('/app/onboarding')!
  const OnboardingPage = lazy(() => import('../onboarding/OnboardingPage'))
  const onboardingRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/onboarding',
    validateSearch: makeValidateSearch(undefined),
    component: () => <PageHost spec={onboardingSpec} Page={OnboardingPage} />,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} resetTo="/app/overview" />,
  })

  // 邀请激活（公开页面，一次性令牌）与平台运营后台（独立入口、独立令牌，不经过 /app 的登录检查）
  const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite/$token', component: lazyRouteComponent(() => import('../pages/InviteAcceptPage'), 'InviteAcceptPage') })
  const platformLoginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/platform/login',
    beforeLoad: () => {
      if (hasPlatformToken()) throw redirect({ to: '/platform/tenants' })
    },
    component: lazyRouteComponent(() => import('../platform/PlatformLoginPage'), 'PlatformLoginPage'),
  })
  const platformRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/platform',
    beforeLoad: async ({ context }) => {
      try {
        await context.queryClient.ensureQueryData(platformMeQuery)
      } catch {
        throw redirect({ to: '/platform/login' })
      }
    },
    component: lazyRouteComponent(() => import('../platform/PlatformLayout'), 'PlatformLayout'),
  })
  const platformIndexRoute = createRoute({
    getParentRoute: () => platformRoute,
    path: '/',
    beforeLoad: async ({ context }) => {
      const admin = await context.queryClient.ensureQueryData(platformMeQuery)
      throw redirect({ to: hasPlatformPermission(admin, 'platform.tenant.read') ? '/platform/tenants' : '/platform/support-access' })
    },
  })
  const platformPages = [
    { path: '/tenants', load: () => import('../platform/PlatformTenantsPage'), name: 'PlatformTenantsPage' },
    { path: '/tenants/$id', load: () => import('../platform/PlatformTenantDetailPage'), name: 'PlatformTenantDetailPage' },
    { path: '/support-access', load: () => import('../platform/PlatformSupportAccessPage'), name: 'PlatformSupportAccessPage' },
  ].map(page => createRoute({ getParentRoute: () => platformRoute, path: page.path, component: lazyRouteComponent(page.load as () => Promise<Record<string, ComponentType>>, page.name) }))

  const routeTree = rootRoute.addChildren([
    ...loginRoutes,
    inviteRoute,
    platformLoginRoute,
    platformRoute.addChildren([platformIndexRoute, ...platformPages]),
    appRoute.addChildren([indexRoute, onboardingRoute, ...redirectRoutes, ...pageRoutes]),
  ])

  return createRouter({
    routeTree,
    context: { queryClient: options.queryClient },
    history: options.history,
    parseSearch,
    stringifySearch,
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFoundPage,
  })
}

export type ErpRouter = ReturnType<typeof createErpRouter>

export { createMemoryHistory }
