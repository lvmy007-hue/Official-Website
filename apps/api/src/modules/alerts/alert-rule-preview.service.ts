import { Injectable } from '@nestjs/common'
import {
  ALERTS_MANAGE,
  ALERT_PREVIEW_DAYS,
  ALERT_PREVIEW_MAX_STORES,
  AlertRulePreviewBodySchema,
  addDays,
  conditionValuesOf,
  evaluateConditions,
  loadStoreMetricData,
  localDateOf,
  unsupportedRuleMetrics,
  type AlertRulePreviewResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { checkConditionGroups } from './alert-rule-conditions'
import { prismaRuleMetricReader } from './alert-rule-metric-reader'

export const PREVIEW_TIMEOUT_MS = 8_000
const SAMPLE_LIMIT = 10

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(appError('QUERY_TIMEOUT', `试算超过 ${Math.round(ms / 1000)} 秒，请缩小店铺范围或简化条件后重试`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

// 规则试算（P6-16，POST /alerts/rules/preview）：用最近 7 天的数据，把这份条件按每天的“今天”各判断一遍，告诉你会触发多少个店铺。
// 只读，不改任何数据、不写审计；店铺最多判断 100 个（超出标注 truncated）；取数超过 8 秒返回超时错误；判断用的是 worker 评估时同一份代码与取数层。
@Injectable()
export class AlertRulePreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async preview(req: RequestWithContext, rawBody: unknown): Promise<AlertRulePreviewResponse> {
    const context = await this.context.authorize(req, ALERTS_MANAGE)
    const body = AlertRulePreviewBodySchema.parse(rawBody)
    const groups = checkConditionGroups(body.conditionGroups)
    const tenantId = context.tenantId
    const storeIds = body.scope?.sellerAccountIds ?? []
    const entityIds = body.scope?.legalEntityIds ?? []
    const limited = storeIds.length > 0 || entityIds.length > 0
    const rows = await this.prisma.sellerAccount.findMany({
      where: { tenantId, ...(limited ? { OR: [...(storeIds.length > 0 ? [{ id: { in: storeIds } }] : []), ...(entityIds.length > 0 ? [{ legalEntityId: { in: entityIds } }] : [])] } : {}) },
      select: { id: true, displayName: true },
      orderBy: { id: 'asc' },
      take: ALERT_PREVIEW_MAX_STORES + 1,
    })
    const truncated = rows.length > ALERT_PREVIEW_MAX_STORES
    const stores = rows.slice(0, ALERT_PREVIEW_MAX_STORES)
    const zone = (await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }))?.timezone ?? null
    const today = localDateOf(new Date(), zone)
    const todays = Array.from({ length: ALERT_PREVIEW_DAYS }, (_, index) => addDays(today, -(ALERT_PREVIEW_DAYS - 1 - index)))
    const data = await withTimeout(
      loadStoreMetricData(
        prismaRuleMetricReader(this.prisma),
        tenantId,
        stores.map(store => store.id),
        groups,
        todays,
      ),
      PREVIEW_TIMEOUT_MS,
    )
    const perDay = new Map(todays.map(date => [date, 0]))
    const hitDays = new Map<string, number>()
    let noDataStores = 0
    for (const store of stores) {
      const metricData = data.get(store.id)
      if (!metricData) continue
      let anyData = false
      for (const date of todays) {
        const evaluation = evaluateConditions(groups, conditionValuesOf(metricData, date))
        if (evaluation.groups.some(group => group.conditions.some(item => item.missing === null))) anyData = true
        if (!evaluation.triggered) continue
        perDay.set(date, (perDay.get(date) ?? 0) + 1)
        hitDays.set(store.id, (hitDays.get(store.id) ?? 0) + 1)
      }
      if (!anyData) noDataStores += 1
    }
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    return {
      days: ALERT_PREVIEW_DAYS,
      evaluatedStores: stores.length,
      truncated,
      triggeredStores: hitDays.size,
      perDay: todays.map(date => ({ date, triggered: perDay.get(date) ?? 0 })),
      samples: [...hitDays]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, SAMPLE_LIMIT)
        .map(([storeId, days]) => ({ storeId, storeName: names.get(storeId) ?? storeId, days })),
      unsupportedMetrics: unsupportedRuleMetrics(groups),
      noDataStores,
    }
  }
}
