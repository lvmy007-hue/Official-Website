import { Injectable } from '@nestjs/common'
import { ALERTS_MANAGE, ALERTS_READ, buildAlertTemplates, type AlertTemplatesResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { readCondition } from './alert-rule-format'

const RULE_LIMIT = 500

// 规则模板（P6-15，16 章第 9 节）：由系统预置规则目录直接生成（库存、广告、销售、流量、店铺五组），一句话写清条件与适用维度；
// 同时统计企业里已经有几条用同一评估逻辑的规则（预置与自定义合计），模板页据此提示“已有 N 条”。模板本身是静态数据，不落库。
@Injectable()
export class AlertTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext): Promise<AlertTemplatesResponse> {
    const context = await this.context.authorize(req, ALERTS_READ)
    const rules = await this.prisma.alertRule.findMany({ where: { tenantId: context.tenantId }, select: { conditionJson: true, enabled: true }, take: RULE_LIMIT })
    const total = new Map<string, number>()
    const enabled = new Map<string, number>()
    for (const rule of rules) {
      const { type } = readCondition(rule.conditionJson)
      total.set(type, (total.get(type) ?? 0) + 1)
      if (rule.enabled) enabled.set(type, (enabled.get(type) ?? 0) + 1)
    }
    const items = buildAlertTemplates().map(item => ({ ...item, ruleCount: total.get(item.type) ?? 0, enabledCount: enabled.get(item.type) ?? 0 }))
    return { state: items.length > 0 ? 'OK' : 'NO_DATA', note: items.length > 0 ? null : '尚无预警规则模板', items, can: { create: hasPermission(context.permissions, ALERTS_MANAGE) } }
  }
}
