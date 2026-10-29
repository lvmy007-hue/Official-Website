import { permissionDeniedMessage } from '@nova/api-contracts'

// 动作守卫的判断逻辑（03 章 3.2“动作守卫”）：权限 → 连接状态 → 写入开关 → 数据条件 → 预览确认。
// 按顺序判断，第一个不满足的就是不可用的原因；有权限处理的人才给出“前往处理”入口。

export type GuardStep = 'permission' | 'connection' | 'write-switch' | 'condition'

export type GuardFix = { label: string; href: string; /** 谁能去处理；缺省表示任何人都可以进入该页面。 */ requires?: string }

export type GuardInput = {
  /** 执行动作需要的权限点。 */
  permission?: string
  connection?: { ok: boolean; reason?: string; fix?: GuardFix }
  /** 亚马逊写操作必须开启写入开关。 */
  writeSwitch?: { enabled: boolean; fix?: GuardFix }
  /** 业务数据条件，例如“只有未发货的计划才能取消”。 */
  condition?: { ok: boolean; reason?: string; fix?: GuardFix }
}

export type GuardVerdict = { allowed: true } | { allowed: false; step: GuardStep; reason: string; fix?: { label: string; href: string } }

export const GUARD_ORDER: readonly GuardStep[] = ['permission', 'connection', 'write-switch', 'condition']

export function evaluateGuard(input: GuardInput, has: (permission: string) => boolean): GuardVerdict {
  const fixFor = (fix: GuardFix | undefined) => (fix && (!fix.requires || has(fix.requires)) ? { label: fix.label, href: fix.href } : undefined)

  if (input.permission && !has(input.permission)) {
    return { allowed: false, step: 'permission', reason: permissionDeniedMessage(input.permission) }
  }
  if (input.connection && !input.connection.ok) {
    return { allowed: false, step: 'connection', reason: input.connection.reason ?? '亚马逊连接不可用，暂时无法执行', fix: fixFor(input.connection.fix) }
  }
  if (input.writeSwitch && !input.writeSwitch.enabled) {
    return { allowed: false, step: 'write-switch', reason: '写入开关未开启：对亚马逊的修改默认不会发出', fix: fixFor(input.writeSwitch.fix) }
  }
  if (input.condition && !input.condition.ok) {
    return { allowed: false, step: 'condition', reason: input.condition.reason ?? '当前数据不满足执行条件', fix: fixFor(input.condition.fix) }
  }
  return { allowed: true }
}
