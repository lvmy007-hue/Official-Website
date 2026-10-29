import { Injectable } from '@nestjs/common'
import { ADS_READ, ADS_RULE_DRY_RUN_CAVEATS, ADS_RULE_LIMITS, AdsRuleDryRunBodySchema, defaultAsOf, evaluateRule, type AdsRuleDryRunResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, ContextService } from '../auth'
import { localDate, validZone } from '../overview'
import { levelOf, RULE_ID_PATTERN, RULE_SELECT, specOf } from './ads-rules-common'
import { latestDataDate, loadRuleSubjects } from './ads-rules-load'

const NOTE_NO_DATA_AT_ALL = '这个广告账户还没有同步到任何日指标（需要广告报表同步），无法评估'
const NOTE_NO_SUBJECTS = '范围内没有可评估的对象（对象还没有同步，或所选活动下没有）'

// 规则试运行（P3-13）：按当前的规则内容与最近的日指标评估一次，给出会命中哪些对象、动作前后的值、被跳过的对象与原因。
// 只读：不改规则、不生成待办、不写执行记录、不调亚马逊。用 POST 是冻结里的约定（可带评估截止日）；不写审计，但仍要幂等键，和其他 POST 一致。
@Injectable()
export class AdsRulesDryRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async dryRun(req: RequestWithContext, id: string, rawBody: unknown, now: Date = new Date()): Promise<AdsRuleDryRunResponse> {
    // 权限先于参数校验：无权限的人先拿 403
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    const body = AdsRuleDryRunBodySchema.parse(rawBody ?? {})
    if (!RULE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const tenantId = context.tenantId
    const record = await this.prisma.adsAutomationRule.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: RULE_SELECT })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '自动规则不存在')
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const latest = defaultAsOf(localDate(now, validZone(tenant?.timezone)))
    const asOf = body.asOf ?? latest
    if (asOf > latest) throw appError('VALIDATION_FAILED', `评估截止日最晚是昨天（${latest}），今天的指标还不完整`, { fieldErrors: { asOf: [`不能晚于 ${latest}`] } })

    const spec = specOf(record)
    const [loaded, dataThrough] = await Promise.all([
      loadRuleSubjects(this.prisma, { tenantId, adsProfileId: record.adsProfileId, level: levelOf(record.level), campaignIds: spec.campaignIds, asOf }),
      latestDataDate(this.prisma, tenantId, record.adsProfileId),
    ])
    const evaluation = evaluateRule(spec, loaded.subjects, asOf)
    const base = {
      asOf,
      dataThrough,
      evaluated: evaluation.evaluated,
      matched: evaluation.matched,
      dailyLimit: spec.guardrails.dailyLimit,
      incomplete: loaded.incomplete,
      caveats: ADS_RULE_DRY_RUN_CAVEATS,
    }
    const hits = evaluation.hits.slice(0, ADS_RULE_LIMITS.dryRunHitMax)
    const skipped = evaluation.skipped.slice(0, ADS_RULE_LIMITS.dryRunSkipMax)
    const truncated = hits.length < evaluation.hits.length || skipped.length < evaluation.skipped.length

    if (dataThrough === null) return { ...base, state: 'NOT_CONNECTED', note: NOTE_NO_DATA_AT_ALL, hits: [], skipped: [], truncated: false }
    if (loaded.subjects.length === 0) return { ...base, state: 'NO_DATA', note: NOTE_NO_SUBJECTS, hits: [], skipped: [], truncated: false }
    const notes = [
      dataThrough < asOf ? `这个账户最新的日指标只到 ${dataThrough}，晚于它的日期没有数据` : null,
      evaluation.evaluated === 0 ? '所有对象都被文本过滤排除了' : null,
      loaded.incomplete ? `对象或指标行超过读取上限（${ADS_RULE_LIMITS.subjectMax} 个对象、${ADS_RULE_LIMITS.dayRowMax} 行），评估可能不完整` : null,
    ].filter((note): note is string => note !== null)
    return { ...base, state: 'OK', note: notes.length > 0 ? notes.join('；') : null, hits, skipped, truncated }
  }
}
