import { Injectable } from '@nestjs/common'
import { applySwitchOutcome, parseSwitchStats, switchSpecOf } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { AlertService } from '../../platform/observability'

export interface SwitchOutcome {
  success: boolean
  /** 失败时的错误码（只用于变更记录与告警说明，不含令牌与个人信息） */
  errorCode?: string
  /** 亚马逊明确返回授权失效或被拒绝（401/403）：立刻关闭，不等连续失败次数 */
  authInvalid?: boolean
}

// 写调用结果的登记（P1-28-1）：接口侧的写入流程（入仓、刊登、改价、广告等）每次调用亚马逊写接口后登记结果。
// 近 7 天调用与失败次数用于开关页展示；连续失败 5 次、或授权失效时，自动关闭对应开关并告警（WRITE_SWITCH_AUTO_CLOSED）。
// 注意：只统计“亚马逊写入调用”，预览、校验和本地计算不计入。
@Injectable()
export class SwitchOutcomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async record(tenantId: string, switchKey: string, outcome: SwitchOutcome, now: Date = new Date()): Promise<{ autoClosed: string[] }> {
    const spec = switchSpecOf(switchKey)
    if (!spec) return { autoClosed: [] }
    const closed: string[] = []
    await this.prisma.$transaction(async tx => {
      const row = await tx.integrationSwitch.findFirst({ where: { tenantId, switchKey, sellerAccountId: null, enabled: true } })
      if (!row) return
      const next = applySwitchOutcome(parseSwitchStats(row.statsJson), row.consecutiveFailures, outcome.success, now)
      const close = next.shouldAutoClose || (!outcome.success && outcome.authInvalid === true)
      const reason = outcome.authInvalid ? '亚马逊返回授权失效或权限不足' : `连续失败 ${next.consecutiveFailures} 次${outcome.errorCode ? `（${outcome.errorCode}）` : ''}`
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
      // 授权失效时，同一提供方的其他已开启开关也不可能成功，一并关闭
      if (outcome.authInvalid) {
        const siblings = await tx.integrationSwitch.findMany({ where: { tenantId, sellerAccountId: null, enabled: true, NOT: { switchKey } }, take: 100 })
        for (const sibling of siblings.filter(item => switchSpecOf(item.switchKey)?.provider === spec.provider)) {
          await tx.integrationSwitch.update({ where: { id: sibling.id }, data: { enabled: false, autoDisabledReason: reason, version: { increment: 1 } } })
          await tx.integrationSwitchLog.create({
            data: { tenantId, switchKey: sibling.switchKey, action: 'AUTO_DISABLED', reason, actorId: null, beforeJson: { enabled: true }, afterJson: { enabled: false } },
          })
          closed.push(sibling.switchKey)
        }
      }
    })
    // 事务提交后再告警：告警接收端会写通知，不应拖住或回滚主流程
    for (const key of closed) {
      await this.alerts.raise({
        code: 'WRITE_SWITCH_AUTO_CLOSED',
        severity: 'critical',
        tenantId,
        dedupeKey: key,
        message: `写入开关“${switchSpecOf(key)?.label ?? key}”已被系统自动关闭：${outcome.authInvalid ? '亚马逊返回授权失效或权限不足' : '写调用连续失败'}。请检查连接后重新开启`,
      })
    }
    return { autoClosed: closed }
  }
}
