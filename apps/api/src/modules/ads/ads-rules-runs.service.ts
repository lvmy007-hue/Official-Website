import { Injectable } from '@nestjs/common'
import { ADS_READ, AdsRuleRunsQuerySchema, type AdsRuleRunsResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService } from '../auth'
import { decodeOffset, pageInfoAt } from './ads-page'
import { RULE_ID_PATTERN, RUN_SELECT, runRowOf } from './ads-rules-common'

// 规则的执行记录（P3-13）：最新在前，游标翻页（游标绑定租户与规则，换了规则即失效）。记录由定时评估写入，这里只读。
@Injectable()
export class AdsRulesRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async runs(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsRuleRunsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsRuleRunsQuerySchema.parse(rawQuery)
    if (!RULE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const tenantId = context.tenantId
    const rule = await this.prisma.adsAutomationRule.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: { id: true } })
    if (!rule) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const binding = `ads-rule-runs:${tenantId}:${id}`
    const offset = decodeOffset(query.cursor, binding)
    const where = { tenantId, ruleId: id }
    const [total, rows] = await Promise.all([
      this.prisma.adsAutomationRun.count({ where }),
      this.prisma.adsAutomationRun.findMany({ where, select: RUN_SELECT, orderBy: [{ runAt: 'desc' }, { id: 'asc' }], skip: offset, take: query.pageSize }),
    ])
    const items = rows.map(runRowOf)
    return {
      state: total > 0 ? 'OK' : 'NO_DATA',
      note: total > 0 ? null : '这条规则还没有执行记录：启用后按执行频率自动评估，命中的对象会在这里留下记录',
      items,
      pageInfo: pageInfoAt(offset, items.length, total, query.pageSize, binding),
    }
  }
}
