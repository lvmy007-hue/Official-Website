// 路由清单的类型（清单本身由 scripts/gen-route-manifest.mjs 从 routes.md 生成）。

export type RouteAccess =
  | { kind: 'permission'; permission: string }
  /** 所有登录成员具备（my.*、profile.manage、metrics.read）。 */
  | { kind: 'base' }
  /** 无需登录（一次性令牌、登录页）。 */
  | { kind: 'public' }
  /** 仅所有者与管理员。 */
  | { kind: 'owner-admin' }

export type Stage = '1' | '2a' | '2b' | '3' | '4' | '5' | '6'

export type RouteSpec = {
  path: string
  title: string
  /** 导航分组（对应 routes.md 第二节小节）。 */
  group: string
  /** 页面组件名，全清单唯一。 */
  component: string
  access: RouteAccess
  /** 正式上线阶段。 */
  stage: Stage
  workPackage: string
}
