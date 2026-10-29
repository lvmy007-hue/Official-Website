import { Injectable } from '@nestjs/common'
import {
  BREAKER_OBSERVE_DAYS,
  PRICING_LIMITS,
  PRICING_PRICE_WRITE,
  PRICING_READ,
  PRICING_RULE_ACTIONS,
  RuleRunDismissBodySchema,
  RuleRunListQuerySchema,
  compareSideOf,
  priceCompareOf,
  type PriceCompare,
  type RuleRunListResponse,
  type RuleRunView,
  type TrafficDay,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { decodeOffset, pageInfoAt } from './pricing-common'
import { num, ymd } from './pricing-load'
import { ruleRunViewOf } from './pricing-rule-view'

const DAY_MS = 86_400_000
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const COMPARE_MAX = 20

/** 规则的执行记录与待确认建议（05 章 5.5）：最新在前，游标翻页；已执行的记录带上改价前后各 7 天的对照（最多给最近 20 条，其余只给结果）。忽略建议只改建议本身的状态。 */
@Injectable()
export class PricingRuleRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async compares(tenantId: string, runs: ReadonlyArray<{ id: string; sellerAccountId: string; asin: string; runAt: Date }>, now: Date): Promise<Map<string, PriceCompare>> {
    const out = new Map<string, PriceCompare>()
    const picked = runs.filter(run => run.asin !== '').slice(0, COMPARE_MAX)
    if (picked.length === 0) return out
    const from = new Date(Math.min(...picked.map(run => run.runAt.getTime())) - PRICING_LIMITS.compareDays * DAY_MS)
    const rows = await this.prisma.salesTrafficAsinDaily.findMany({
      where: {
        tenantId,
        sellerAccountId: { in: [...new Set(picked.map(run => run.sellerAccountId))] },
        asin: { in: [...new Set(picked.map(run => run.asin))] },
        asinGranularity: 'CHILD',
        currency: 'USD',
        date: { gte: new Date(`${ymd(from)}T00:00:00.000Z`) },
      },
      select: { sellerAccountId: true, asin: true, date: true, source: true, units: true, sessions: true, buyBoxPct: true },
      orderBy: [{ date: 'asc' }, { source: 'asc' }],
      take: 20_000,
    })
    for (const run of picked) {
      const days: TrafficDay[] = rows
        .filter(row => row.sellerAccountId === run.sellerAccountId && row.asin === run.asin)
        .map(row => ({ date: ymd(row.date), source: row.source, units: row.units, sessions: row.sessions, buyBoxPct: num(row.buyBoxPct) }))
      const at = run.runAt.getTime()
      const between = (a: number, b: number) => days.filter(day => day.date >= ymd(new Date(a)) && day.date <= ymd(new Date(b)))
      out.set(
        run.id,
        priceCompareOf({
          changedAt: run.runAt,
          now,
          observeDays: BREAKER_OBSERVE_DAYS,
          before: compareSideOf(between(at - PRICING_LIMITS.compareDays * DAY_MS, at - DAY_MS)),
          after: compareSideOf(between(at + DAY_MS, at + PRICING_LIMITS.compareDays * DAY_MS)),
        }),
      )
    }
    return out
  }

  async runs(req: RequestWithContext, ruleId: string, rawQuery: Record<string, string>, now = new Date()): Promise<RuleRunListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_READ, rawQuery)
    const query = RuleRunListQuerySchema.parse(rawQuery)
    if (!ID_PATTERN.test(ruleId)) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    const tenantId = context.tenantId
    const rule = await this.prisma.pricingRule.findFirst({ where: { id: ruleId, tenantId, ...storeWhere(scope) }, select: { id: true, name: true } })
    if (!rule) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    const binding = `pricing-rule-runs:${tenantId}:${ruleId}:${query.outcome ?? ''}`
    const offset = decodeOffset(query.cursor, binding)
    const where = { tenantId, ruleId, ...(query.outcome ? { outcome: query.outcome } : {}) }
    const [total, rows] = await Promise.all([
      this.prisma.pricingRuleRun.count({ where }),
      this.prisma.pricingRuleRun.findMany({ where, orderBy: [{ runAt: 'desc' }, { id: 'asc' }], skip: offset, take: Math.min(query.pageSize, PRICING_LIMITS.runsPageMax) }),
    ])
    const compares = await this.compares(
      tenantId,
      rows.filter(row => row.outcome === 'APPLIED'),
      now,
    )
    const items: RuleRunView[] = rows.map(row => ruleRunViewOf(row, rule.name, compares.get(row.id) ?? null))
    return { items, pageInfo: pageInfoAt(offset, items.length, total, query.pageSize, binding) }
  }

  async dismiss(req: RequestWithContext, id: string, rawBody: unknown): Promise<RuleRunView> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_PRICE_WRITE, {})
    const body = RuleRunDismissBodySchema.parse(rawBody ?? {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '建议不存在')
    const tenantId = context.tenantId
    const run = await this.prisma.pricingRuleRun.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, include: { rule: { select: { name: true } } } })
    if (!run) throw appError('RESOURCE_NOT_FOUND', '建议不存在')
    const updated = await this.prisma.$transaction(async tx => {
      const changed = await tx.pricingRuleRun.updateMany({ where: { id, tenantId, outcome: 'SUGGESTED' }, data: { outcome: 'DISMISSED', message: body.reason ? `已忽略：${body.reason}` : '已忽略' } })
      if (changed.count === 0) throw appError('CONFLICT', '这条建议已被处理，请刷新后再看', { details: { code: 'SUGGESTION_STALE' } })
      await this.audit.record(req, { action: PRICING_RULE_ACTIONS.dismissed, resourceType: 'PricingRuleRun', resourceId: id, after: { sku: run.sku, ruleId: run.ruleId } }, { client: tx })
      return tx.pricingRuleRun.findFirstOrThrow({ where: { id, tenantId } })
    })
    return ruleRunViewOf(updated, run.rule.name, null)
  }
}
