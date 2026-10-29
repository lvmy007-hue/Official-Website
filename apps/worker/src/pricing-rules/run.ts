import {
  PRICING_STRATEGY_LABEL,
  describeMatrix,
  describeStrategy,
  evaluatePricingRule,
  guardrailResultText,
  normalizeMatrix,
  priceText,
  scopeIncludes,
  type PricingParams,
  type PricingRuleSpec,
  type PricingStrategy,
  type PricingTargetScope,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { holdersOf, notifyUsers } from '../platform/notify'
import type { QueueRegistry } from '../runtime/queues'
import { breakerOf, evaluateBreaker } from './breaker'
import { offSwitches, submitAutoPrice } from './execute'
import { loadFacts, type StoreFact } from './load'

// 定价规则的定时评估（P4-11，05 章 5.5）：每小时扫描一次，对启用中的规则先做熔断核对，再按适用范围逐个 SKU 评估：策略求价 → 单次调幅收窄 → 最低价、最高价、最低利润率检查。
// 手动规则：命中的 SKU 生成“待确认的建议”（执行记录 + 待办 + 站内通知），由人在页面确认后走校验预览与改价流程。
// 自动规则：两个写入开关（sw.pricing.update 与 sw.pricing.rule.auto）都打开才真正提交改价；任何一项不满足都降级为生成建议并写明原因，不静默丢弃。
// 约束：每个 SKU 每天最多处理“每日次数上限”次（含建议与已提交）；已有待确认建议的 SKU 不重复生成；被护栏拦截的结果每个 SKU 每天只记一次；
// 没有命中（价格已合适、算不出）不写记录——不用“没有记录”冒充“检查过且没问题”，规则的“最近评估时间”才是检查过的证据。
// 单条规则出错不拖垮其他规则，也不更新它的评估时间（下一轮重试）。

export const PRICING_RULE_SCAN_INTERVAL_MS = 60 * 60 * 1000
const RULE_LIMIT = 200
const DAY_MS = 86_400_000
const SUGGEST_REPEAT_DAYS = 7
const WORK_DUE_HOURS = 72
const MESSAGE_MAX = 500

export interface PricingScan {
  rules: number
  suggested: number
  queued: number
  blocked: number
  capped: number
  tripped: number
  /** 评估的商品数超过单次上限（5000），只评估了前面的部分的规则数。 */
  truncated: number
  errors: string[]
}
type Queues = Pick<QueueRegistry, 'addSync'>
interface RuleRecord {
  id: string
  tenantId: string
  sellerAccountId: string
  name: string
  mode: string
  strategy: string
  paramsJson: unknown
  targetScopeJson: unknown
  scenarioMatrix?: unknown
  maxChangePct: { toString(): string }
  dailyLimit: number
  breakerFailures: number
  breakerConversionDrop: { toString(): string } | null
  breakerMinMargin: { toString(): string } | null
  version: number
  createdBy: string
}

function specOf(rule: RuleRecord): PricingRuleSpec {
  const scope = (rule.targetScopeJson ?? {}) as Partial<PricingTargetScope>
  return {
    id: rule.id,
    name: rule.name,
    mode: rule.mode === 'AUTO' ? 'AUTO' : 'MANUAL',
    strategy: rule.strategy as PricingStrategy,
    params: (rule.paramsJson ?? {}) as PricingParams,
    scope: { all: scope.all === true, skus: Array.isArray(scope.skus) ? scope.skus : [], asins: Array.isArray(scope.asins) ? scope.asins : [] },
    maxChangePct: Number(rule.maxChangePct.toString()),
    dailyLimit: rule.dailyLimit,
    breaker: breakerOf(rule),
    matrix: normalizeMatrix(rule.scenarioMatrix),
  }
}

/** 待办负责人：规则的创建人（须仍在职且有定价写权限），否则第一位有定价写权限的在职成员。 */
async function chooseOwner(db: PrismaClient, tenantId: string, createdBy: string): Promise<string | null> {
  const holders = await holdersOf(db, tenantId, 'pricing.rule.write')
  return holders.includes(createdBy) ? createdBy : (holders[0] ?? null)
}

interface Context {
  db: PrismaClient
  rule: RuleRecord
  spec: PricingRuleSpec
  now: Date
  ownerId: string | null
  autoReady: boolean
  queues?: Queues
  result: PricingScan
}

async function suggest(ctx: Context, fact: StoreFact, evaluation: { rawPrice: number | null; suggestedPrice: number | null; text: string }, note: string | null) {
  const { db, rule, spec, now } = ctx
  const price = evaluation.suggestedPrice as number
  await db.$transaction(async tx => {
    const work = ctx.ownerId
      ? await tx.workItem.create({
          data: {
            tenantId: rule.tenantId,
            sellerAccountId: rule.sellerAccountId,
            title: `定价规则“${rule.name}”建议：${fact.sku} 改价到 ${priceText(price)}`.slice(0, 200),
            kind: 'PRICING',
            source: 'SYSTEM',
            severity: 'INFO',
            priority: 'NORMAL',
            dueAt: new Date(now.getTime() + WORK_DUE_HOURS * 3_600_000),
            entityType: 'SKU',
            entityId: fact.sku,
            entityLabel: fact.sku.slice(0, 200),
            suggestedAction: `当前价 ${priceText(fact.currentPrice)} → ${priceText(price)}`.slice(0, 500),
            detail:
              `${spec.matrix ? `情形 × 动作矩阵：${describeMatrix(spec.matrix)}` : describeStrategy(spec.strategy, spec.params)}。${evaluation.text}${note ? `。${note}` : ''}。到定价页确认后先做校验预览再提交；关闭待办不会改价。`.slice(
                0,
                2000,
              ),
            ownerId: ctx.ownerId,
            createdBy: ctx.ownerId,
          },
          select: { id: true },
        })
      : null
    await tx.pricingRuleRun.create({
      data: {
        tenantId: rule.tenantId,
        sellerAccountId: rule.sellerAccountId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        sku: fact.sku,
        asin: fact.asin,
        currentPrice: fact.currentPrice,
        rawPrice: evaluation.rawPrice,
        suggestedPrice: price,
        guardrailResult: 'PASS',
        outcome: work ? 'SUGGESTED' : 'SKIPPED',
        message: (work ? note : '没有拥有“定价规则”权限的在职成员可指派待办，本次没有生成建议')?.slice(0, MESSAGE_MAX) ?? null,
        workItemId: work?.id ?? null,
        runAt: now,
      },
    })
  })
  ctx.result.suggested += 1
}

async function execute(ctx: Context, fact: StoreFact, evaluation: { rawPrice: number | null; suggestedPrice: number | null; text: string }) {
  const { db, rule, now } = ctx
  const ruleRunId = randomUUID()
  const price = evaluation.suggestedPrice as number
  const created = await db.pricingRuleRun.create({
    data: {
      id: ruleRunId,
      tenantId: rule.tenantId,
      sellerAccountId: rule.sellerAccountId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      sku: fact.sku,
      asin: fact.asin,
      currentPrice: fact.currentPrice,
      rawPrice: evaluation.rawPrice,
      suggestedPrice: price,
      guardrailResult: 'PASS',
      outcome: 'QUEUED',
      message: '已提交改价，等待亚马逊确认',
      runAt: now,
    },
    select: { id: true },
  })
  const done = await submitAutoPrice(
    { db, queues: ctx.queues as Queues },
    {
      tenantId: rule.tenantId,
      sellerAccountId: rule.sellerAccountId,
      sku: fact.sku,
      asin: fact.asin,
      productType: fact.productType,
      price,
      currency: fact.currency,
      previousPrice: fact.currentPrice as number,
      ruleRunId: created.id,
      requestId: `pricing-rule:${rule.id}:${now.toISOString()}`,
    },
  )
  if (done.status === 'QUEUED') {
    await db.pricingRuleRun.updateMany({ where: { id: created.id, tenantId: rule.tenantId }, data: { writeRunId: done.runId } })
    ctx.result.queued += 1
    return
  }
  if (done.status === 'FAILED') {
    await db.pricingRuleRun.updateMany({ where: { id: created.id, tenantId: rule.tenantId }, data: { outcome: 'FAILED', message: done.reason.slice(0, MESSAGE_MAX), writeRunId: done.runId } })
    return
  }
  // 提交不了：这条记录转成建议，原因写进去（开关、授权、商品类型缺失等）
  await db.pricingRuleRun.deleteMany({ where: { id: created.id, tenantId: rule.tenantId } })
  await suggest(ctx, fact, evaluation, `自动执行没有提交：${done.reason}`)
}

async function scanRule(db: PrismaClient, rule: RuleRecord, now: Date, result: PricingScan, queues?: Queues): Promise<void> {
  const spec = specOf(rule)
  const verdict = await evaluateBreaker(db, rule, now)
  if (verdict.trip) {
    await db.pricingRule.updateMany({
      where: { id: rule.id, tenantId: rule.tenantId, status: 'ACTIVE' },
      data: { status: 'BREAKER', breakerReason: (verdict.reason ?? '').slice(0, MESSAGE_MAX), breakerAt: now },
    })
    const owner = await chooseOwner(db, rule.tenantId, rule.createdBy)
    if (owner) {
      await notifyUsers(db, rule.tenantId, [owner], {
        kind: 'PRICING',
        title: `定价规则“${rule.name}”已熔断`.slice(0, 200),
        body: `${verdict.reason ?? ''}。规则已暂停评估与执行，请核对后在定价页恢复。`,
        link: '/app/pricing',
        severity: 'WARNING',
        dedupKey: `pricing-breaker:${rule.id}:${now.toISOString().slice(0, 10)}`,
      }).catch(() => 0)
    }
    result.tripped += 1
    return
  }
  const { facts, truncated } = await loadFacts(db, { tenantId: rule.tenantId, sellerAccountId: rule.sellerAccountId, scope: spec.scope }, now)
  const dayAgo = new Date(now.getTime() - DAY_MS)
  const recent = await db.pricingRuleRun.findMany({
    where: { tenantId: rule.tenantId, ruleId: rule.id, runAt: { gte: new Date(now.getTime() - SUGGEST_REPEAT_DAYS * DAY_MS) } },
    select: { sku: true, outcome: true, guardrailResult: true, runAt: true, suggestedPrice: true },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: 20_000,
  })
  const used = new Map<string, number>()
  const pending = new Set<string>()
  const blockedToday = new Set<string>()
  // 被人忽略的建议：7 天内同一个 SKU 算出同样的建议价不再重复提示（价格变了或超过 7 天才会重新建议）
  const dismissed = new Map<string, Set<number>>()
  for (const row of recent) {
    if (row.outcome === 'DISMISSED' && row.suggestedPrice !== null) dismissed.set(row.sku, (dismissed.get(row.sku) ?? new Set<number>()).add(Number(row.suggestedPrice.toString())))
    if (row.outcome === 'SUGGESTED') pending.add(row.sku)
    if (row.runAt >= dayAgo && ['SUGGESTED', 'QUEUED', 'APPLIED'].includes(row.outcome)) used.set(row.sku, (used.get(row.sku) ?? 0) + 1)
    if (row.runAt >= dayAgo && row.outcome === 'BLOCKED') blockedToday.add(row.sku)
  }
  const ownerId = await chooseOwner(db, rule.tenantId, rule.createdBy)
  const autoReady = rule.mode === 'AUTO' && queues !== undefined && (await offSwitches(db, rule.tenantId)).length === 0
  const ctx: Context = { db, rule, spec, now, ownerId, autoReady, queues, result }
  let hits = 0
  for (const fact of facts) {
    if (!scopeIncludes(spec.scope, fact.sku, fact.asin)) continue
    const evaluation = evaluatePricingRule(spec, fact)
    if (!evaluation.hit) continue
    if (evaluation.blocked) {
      if (!blockedToday.has(fact.sku)) {
        await db.pricingRuleRun.create({
          data: {
            tenantId: rule.tenantId,
            sellerAccountId: rule.sellerAccountId,
            ruleId: rule.id,
            ruleVersion: rule.version,
            sku: fact.sku,
            asin: fact.asin,
            currentPrice: fact.currentPrice,
            rawPrice: evaluation.rawPrice,
            suggestedPrice: evaluation.suggestedPrice,
            guardrailResult: evaluation.result,
            outcome: 'BLOCKED',
            message: `${guardrailResultText(evaluation.result)}：${evaluation.text}`.slice(0, MESSAGE_MAX),
            runAt: now,
          },
        })
        result.blocked += 1
      }
      continue
    }
    if (pending.has(fact.sku)) continue
    if (dismissed.get(fact.sku)?.has(evaluation.suggestedPrice as number)) continue
    if ((used.get(fact.sku) ?? 0) >= spec.dailyLimit) {
      result.capped += 1
      continue
    }
    hits += 1
    if (autoReady) await execute(ctx, fact, evaluation)
    else await suggest(ctx, fact, evaluation, rule.mode === 'AUTO' ? '自动规则未满足执行条件（见规则页的开关说明），本次只生成建议' : null)
  }
  // 评估统计只在评估成功之后更新；updatedAt 保持不变（它表示“上次有人改规则”，不是“上次评估”）
  const current = await db.pricingRule.findFirst({ where: { id: rule.id, tenantId: rule.tenantId }, select: { updatedAt: true } })
  await db.pricingRule.updateMany({ where: { id: rule.id, tenantId: rule.tenantId }, data: { lastEvaluatedAt: now, ...(current ? { updatedAt: current.updatedAt } : {}) } })
  result.rules += 1
  if (truncated) result.truncated += 1
  if (hits > 0 && ownerId) {
    await notifyUsers(db, rule.tenantId, [ownerId], {
      kind: 'PRICING',
      title: `定价规则“${rule.name}”命中 ${hits} 个商品`.slice(0, 200),
      body: `${spec.matrix ? '情形 × 动作矩阵' : PRICING_STRATEGY_LABEL[spec.strategy]}；${rule.mode === 'AUTO' && autoReady ? '已按规则提交改价，亚马逊确认后记为已执行。' : '已生成待办与待确认的建议，请到定价页处理。'}`,
      link: '/app/pricing',
      dedupKey: `pricing-rule:${rule.id}:${now.toISOString()}`,
    }).catch(() => 0)
  }
}

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function scanTenantPricing(db: PrismaClient, tenantId: string, now: Date = new Date(), queues?: Queues): Promise<PricingScan> {
  const result: PricingScan = { rules: 0, suggested: 0, queued: 0, blocked: 0, capped: 0, tripped: 0, truncated: 0, errors: [] }
  const rules = await db.pricingRule.findMany({ where: { tenantId, status: 'ACTIVE' }, orderBy: [{ id: 'asc' }], take: RULE_LIMIT })
  for (const rule of rules) {
    try {
      await scanRule(db, rule, now, result, queues)
    } catch (error) {
      result.errors.push(`${rule.id}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
    }
  }
  return result
}

export interface ScanAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  queues?: Queues
  logger: { warn(fields: Record<string, unknown>, message: string): void }
  now?: () => Date
}

export async function scanAllTenants(deps: ScanAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let suggested = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => scanTenantPricing(deps.db, tenant.id, deps.now?.() ?? new Date(), deps.queues))
      suggested += result.suggested
      if (result.errors.length > 0) deps.logger.warn({ event: 'pricing_rule_scan_errors', errors: result.errors }, 'some pricing rules failed')
    } catch (error) {
      deps.logger.warn({ event: 'pricing_rule_scan_failed', error: error instanceof Error ? error.message : String(error) }, 'pricing rule scan failed for a tenant')
    }
  }
  return { tenants: tenants.length, suggested }
}
