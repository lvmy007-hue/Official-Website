import { Injectable } from '@nestjs/common'
import { SWITCH_CATALOG, SWITCH_GROUP_LABEL, SWITCH_STATS_DAYS, emergencyDisableReason, writeModeOf } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { checkPrerequisites, loadConnectionFacts, prerequisitesPassed } from './switch-prerequisites'

const HISTORY_PER_SWITCH = 5

// 接口与写入开关的读取（P1-28-1）：总览页要的全部信息一次返回；顶栏的写入状态用 summary。
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 企业级开关的当前状态（无记录视为关闭）。 */
  private async enabledKeys(tenantId: string): Promise<Set<string>> {
    const rows = await this.prisma.integrationSwitch.findMany({ where: { tenantId, sellerAccountId: null, enabled: true }, select: { switchKey: true }, take: 100 })
    return new Set(rows.map(row => row.switchKey).filter(key => !emergencyDisableReason(key, process.env)))
  }

  /** 顶栏用：登录成员都能看到当前是“只读 / 部分写入 / 全部写入”，不含任何敏感信息。 */
  async summary(req: RequestWithContext) {
    const context = await this.context.resolve(req)
    const enabled = await this.enabledKeys(context.tenantId)
    const total = SWITCH_CATALOG.length
    return {
      mode: writeModeOf(enabled.size, total),
      enabledCount: enabled.size,
      total,
      emergencyForced: emergencyDisableReason('all', process.env) !== null,
    }
  }

  async overview(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.read')
    const tenantId = context.tenantId
    const [rows, logs, facts] = await Promise.all([
      this.prisma.integrationSwitch.findMany({ where: { tenantId, sellerAccountId: null }, take: 100 }),
      this.prisma.integrationSwitchLog.findMany({ where: { tenantId, sellerAccountId: null }, orderBy: { createdAt: 'desc' }, take: 300 }),
      loadConnectionFacts(this.prisma, tenantId),
    ])
    const userIds = [...new Set([...rows.map(row => row.enabledBy), ...logs.map(log => log.actorId)].filter((id): id is string => Boolean(id)))]
    const members = userIds.length
      ? await this.prisma.membership.findMany({ where: { tenantId, userId: { in: userIds } }, select: { userId: true, user: { select: { displayName: true, email: true } } }, take: 200 })
      : []
    const nameOf = new Map(members.map(member => [member.userId, member.user.displayName || member.user.email]))
    const byKey = new Map(rows.map(row => [row.switchKey, row]))
    const items = SWITCH_CATALOG.map(spec => {
      const row = byKey.get(spec.key)
      const forced = emergencyDisableReason(spec.key, process.env)
      const checks = checkPrerequisites(spec, facts, process.env)
      const history = logs
        .filter(log => log.switchKey === spec.key)
        .slice(0, HISTORY_PER_SWITCH)
        .map(log => ({ id: log.id, action: log.action, reason: log.reason, actor: log.actorId ? (nameOf.get(log.actorId) ?? '已离开的成员') : '系统', at: log.createdAt }))
      return {
        key: spec.key,
        label: spec.label,
        group: spec.group,
        groupLabel: SWITCH_GROUP_LABEL[spec.group],
        permission: spec.permission,
        provider: spec.provider,
        enabled: Boolean(row?.enabled) && !forced,
        forcedOffReason: forced,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ? (nameOf.get(row.enabledBy) ?? '已离开的成员') : null,
        reason: row?.reason ?? null,
        autoDisabledReason: row?.autoDisabledReason ?? null,
        calls7d: row?.calls7d ?? 0,
        failures7d: row?.failures7d ?? 0,
        consecutiveFailures: row?.consecutiveFailures ?? 0,
        version: row?.version ?? 0,
        prerequisites: checks,
        canEnable: !forced && prerequisitesPassed(checks),
        history,
      }
    })
    const enabledCount = items.filter(item => item.enabled).length
    return {
      mode: writeModeOf(enabledCount, items.length),
      enabledCount,
      total: items.length,
      statsDays: SWITCH_STATS_DAYS,
      emergencyForced: emergencyDisableReason('all', process.env) !== null,
      items,
    }
  }
}
