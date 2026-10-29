import { hasPermission } from '@nova/authz'
import { ROUTE_MANIFEST } from './manifest.generated'
import type { RouteAccess, RouteSpec } from './types'

export { ROUTE_MANIFEST }
export type { RouteAccess, RouteSpec, Stage } from './types'

// 路由清单的查询与权限判断（P1-03）。清单本身由 routes.md 生成，这里不手工维护任何路由。

/** 导航分组顺序，与 routes.md 第二节小节顺序一致（16 章第 0 节，P6-00）。 */
export const NAV_GROUP_ORDER = ['首页', '统计分析', '商品与 Listing', '库存与补货', 'FBA 发货', '订单与售后', '财务与利润', '广告', '预警', '工具', '数据与报表', '设置'] as const

/** 路由规则（routes.md 第三节）。 */
export const REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '/app', to: '/app/overview' },
  // 官网线索不再是 ERP 页面：路由保留，直接回到经营控制台；后端接口保留
  { from: '/app/contact-requests', to: '/app/overview' },
]
/** 已移除的路径：不保留跳转，直接显示“页面不存在”。 */
export const REMOVED_PATHS: readonly string[] = ['/app/bi']

/** 不进入侧边导航的路由：详情页（带动态段）之外的功能性页面。 */
const HIDDEN_FROM_NAV = new Set(['/app/ad-terms/detail', '/app/login', '/app/onboarding'])

const isDynamic = (path: string) => path.includes(':')
const isTenantApp = (spec: RouteSpec) => spec.path.startsWith('/app/') && spec.path !== '/app/login' && spec.path !== '/app/onboarding'

/** 租户工作区页面（不含登录、初始化向导、平台后台）。 */
export const APP_ROUTES: readonly RouteSpec[] = ROUTE_MANIFEST.filter(isTenantApp)

export const specByPath = new Map(ROUTE_MANIFEST.map(spec => [spec.path, spec]))
export const specByComponent = new Map(ROUTE_MANIFEST.map(spec => [spec.component, spec]))

function toMatcher(pattern: string) {
  const names: string[] = []
  const source = pattern
    .split('/')
    .map(part => {
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^${source}/?$`), names }
}

// 静态段多的优先（`/app/inventory/ledger` 先于 `/app/inventory/:id`）
const matchers = [...ROUTE_MANIFEST].sort((a, b) => Number(isDynamic(a.path)) - Number(isDynamic(b.path)) || b.path.length - a.path.length).map(spec => ({ spec, ...toMatcher(spec.path) }))

export type MatchedRoute = { spec: RouteSpec; params: Record<string, string> }

/** 把实际地址匹配到清单里的路由；不在清单内返回 null。 */
export function matchManifest(pathname: string): MatchedRoute | null {
  for (const { spec, regex, names } of matchers) {
    const hit = regex.exec(pathname)
    if (hit) return { spec, params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(hit[index + 1])])) }
  }
  return null
}

// ---- 权限 ----

export type AccessSubject = {
  /** 当前成员的有效权限点（所有者为通配）。 */
  permissions: readonly string[]
}

/** 管理员判定：与服务端多因素强制所用的标记权限一致。 */
const ADMIN_MARKERS = ['member.manage', 'role.manage', 'settings.integration.write']
const isAdmin = (permissions: readonly string[]) => ADMIN_MARKERS.some(permission => hasPermission(permissions, permission))

export function canAccess(access: RouteAccess, subject: AccessSubject | null): boolean {
  switch (access.kind) {
    case 'public':
      return true
    case 'base':
      return subject !== null
    case 'owner-admin':
      return subject !== null && isAdmin(subject.permissions)
    case 'permission':
      return subject !== null && hasPermission(subject.permissions, access.permission)
  }
}

/** 无权限页面里要说明的所需权限点。 */
export function requiredPermissionText(access: RouteAccess): string {
  switch (access.kind) {
    case 'permission':
      return access.permission
    case 'owner-admin':
      return '所有者或管理员角色'
    default:
      return ''
  }
}

// ---- 导航 ----

export type NavEntry = { path: string; title: string; component: string }
export type NavGroup = { label: string; items: NavEntry[] }

/**
 * 侧边导航：只含“已上线”且“当前成员有权限”的页面；
 * 未上线页面不进导航（routes.md 第三节），无权限页面的导航项隐藏。
 */
export function buildNav(isLive: (component: string) => boolean, subject: AccessSubject | null): NavGroup[] {
  const groups = new Map<string, NavEntry[]>()
  for (const spec of APP_ROUTES) {
    if (isDynamic(spec.path) || HIDDEN_FROM_NAV.has(spec.path)) continue
    if (!isLive(spec.component) || !canAccess(spec.access, subject)) continue
    const items = groups.get(spec.group) ?? []
    items.push({ path: spec.path, title: spec.title, component: spec.component })
    groups.set(spec.group, items)
  }
  return NAV_GROUP_ORDER.filter(label => groups.has(label)).map(label => ({ label, items: groups.get(label)! }))
}
