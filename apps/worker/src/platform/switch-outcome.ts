import { applySwitchOutcome, parseSwitchStats, switchSpecOf } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import { notifyHolders } from './notify'

// 写调用结果登记（P1-28-1，后台任务侧）：后台任务每次调用亚马逊写接口（入仓、刊登、改价、广告等）后登记结果，
// 规则与接口侧 SwitchOutcomeService 完全一致：记近 7 天调用与失败次数；连续失败 5 次，或亚马逊返回授权失效（401/403）时自动关闭对应开关，
// 授权失效时同一提供方的其他已开启开关一并关闭；关闭后写变更记录并通知有“预警管理”权限的成员。
// 只统计“亚马逊写入调用”，预览、校验与本地计算不计入。

export interface SwitchOutcome {
  success: boolean
  /** 失败时的错误码（只用于变更记录与告警说明，不含令牌与个人信息） */
  errorCode?: string
  /** 亚马逊明确返回授权失效或被拒绝：立刻关闭，不等连续失败次数 */
  authInvalid?: boolean
}

export async function recordSwitchOutcome(db: PrismaClient, tenantId: string, switchKey: string, outcome: SwitchOutcome, now: Date = new Date()): Promise<{ autoClosed: string[] }> {
  const spec = switchSpecOf(switchKey)
  if (!spec) return { autoClosed: [] }
  const closed: string[] = []
  const authInvalid = !outcome.success && outcome.authInvalid === true
  await db.$transaction(async tx => {
    const row = await tx.integrationSwitch.findFirst({ where: { tenantId, switchKey, sellerAccountId: null, enabled: true } })
    if (!row) return
    const next = applySwitchOutcome(parseSwitchStats(row.statsJson), row.consecutiveFailures, outcome.success, now)
    const close = next.shouldAutoClose || authInvalid
    const reason = authInvalid ? '亚马逊返回授权失效或权限不足' : `连续失败 ${next.consecutiveFailures} 次${outcome.errorCode ? `（${outcome.errorCode}）` : ''}`
    await tx.integrationSwitch.update({
      where: { id: row.id },
      data: {
        statsJson: next.stats as unknown as Prisma.InputJsonValue,
        calls7d: next.calls7d,
        failures7d: next.failures7d,
        consecutiveFailures: next.consecutiveFailures,
        ...(close ? { enabled: false, autoDisabledReason: reason } : {}),
        version: { increment: 1 },
      },
    })
    if (!close) return
    closed.push(switchKey)
    await tx.integrationSwitchLog.create({ data: { tenantId, switchKey, action: 'AUTO_DISABLED', reason, actorId: null, beforeJson: { enabled: true }, afterJson: { enabled: false } } })
    if (!authInvalid) return
    const siblings = await tx.integrationSwitch.findMany({ where: { tenantId, sellerAccountId: null, enabled: true, NOT: { switchKey } }, take: 100 })
    for (const sibling of siblings.filter(item => switchSpecOf(item.switchKey)?.provider === spec.provider)) {
      await tx.integrationSwitch.update({ where: { id: sibling.id }, data: { enabled: false, autoDisabledReason: reason, version: { increment: 1 } } })
      await tx.integrationSwitchLog.create({
        data: { tenantId, switchKey: sibling.switchKey, action: 'AUTO_DISABLED', reason, actorId: null, beforeJson: { enabled: true }, afterJson: { enabled: false } },
      })
      closed.push(sibling.switchKey)
    }
  })
  // 事务提交后再通知：通知失败不应回滚开关的关闭
  const day = now.toISOString().slice(0, 10)
  for (const key of closed) {
    await notifyHolders(db, tenantId, 'alerts.manage', {
      kind: 'ALERT_WRITE_SWITCH_AUTO_CLOSED',
      title: '写入开关已被自动关闭',
      body: `写入开关“${switchSpecOf(key)?.label ?? key}”已被系统自动关闭：${authInvalid ? '亚马逊返回授权失效或权限不足' : '写调用连续失败'}。请检查连接后重新开启`,
      link: '/app/settings/integrations',
      severity: 'CRITICAL',
      dedupKey: `alert:WRITE_SWITCH_AUTO_CLOSED:${key}:${day}`,
    }).catch(() => 0)
  }
  return { autoClosed: closed }
}
