import { Injectable } from '@nestjs/common'
import { FX_BASE_CURRENCY, FX_DEFAULT_CURRENCIES, FX_PROVIDERS, FX_ROLES, FxQuerySchema, pickEffectiveRate, type FxProvider, type FxRow } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { SettingsService } from '../settings'

const DAY_MS = 86_400_000
const dateText = (value: Date) => value.toISOString().slice(0, 10)

type RateRow = { rateDate: Date; rate: { toString(): string }; source: string; isFallback: boolean; isManualOverride: boolean }
const toRow = (row: RateRow): FxRow => ({ rateDate: dateText(row.rateDate), rate: Number(row.rate.toString()), source: row.source, isFallback: row.isFallback, isManualOverride: row.isManualOverride })

/** 汇率页需要的币种：人民币加企业设置的附加币种。 */
export async function configuredCurrencies(settings: SettingsService, tenantId: string) {
  const extra = (await settings.get(tenantId, 'fx.extraCurrencies')).value
  return [...new Set([...FX_DEFAULT_CURRENCIES, ...extra])]
}

// 汇率读取（P1-28-2）：每个币种的最新汇率、选定币种的曲线、来源与最近获取状态、手工覆盖记录。
@Injectable()
export class FxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly settings: SettingsService,
  ) {}

  async overview(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.authorize(req, 'settings.read')
    const query = FxQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const currencies = await configuredCurrencies(this.settings, tenantId)
    const quote = query.quote ?? currencies[0]
    if (!currencies.includes(quote)) throw appError('VALIDATION_FAILED', '该币种还没有加入汇率币种，请先添加', { fieldErrors: { quote: ['该币种还没有加入汇率币种'] } })
    const since = new Date(Date.now() - query.days * DAY_MS)
    const [curveRows, latest, sources, overrides] = await Promise.all([
      this.prisma.fxRate.findMany({ where: { tenantId, baseCurrency: FX_BASE_CURRENCY, quoteCurrency: quote, rateDate: { gte: since } }, orderBy: { rateDate: 'asc' }, take: 5000 }),
      Promise.all(
        currencies.map(async currency => ({
          currency,
          rows: await this.prisma.fxRate.findMany({ where: { tenantId, baseCurrency: FX_BASE_CURRENCY, quoteCurrency: currency }, orderBy: { rateDate: 'desc' }, take: 6 }),
        })),
      ),
      this.prisma.fxSourceConfig.findMany({ where: { tenantId }, take: 10 }),
      this.prisma.fxRate.findMany({ where: { tenantId, baseCurrency: FX_BASE_CURRENCY, isManualOverride: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ])
    const byDate = new Map<string, FxRow[]>()
    for (const row of curveRows.map(toRow)) byDate.set(row.rateDate, [...(byDate.get(row.rateDate) ?? []), row])
    const curve = [...byDate.entries()].map(([date, rows]) => {
      const row = pickEffectiveRate(rows) as FxRow
      return { date, rate: row.rate, source: row.source, isFallback: row.isFallback, isManualOverride: row.isManualOverride }
    })
    const userIds = [...new Set(overrides.map(row => row.overriddenBy).filter((id): id is string => Boolean(id)))]
    const members = userIds.length
      ? await this.prisma.membership.findMany({ where: { tenantId, userId: { in: userIds } }, select: { userId: true, user: { select: { displayName: true, email: true } } }, take: 200 })
      : []
    const nameOf = new Map(members.map(member => [member.userId, member.user.displayName || member.user.email]))
    return {
      baseCurrency: FX_BASE_CURRENCY,
      currencies,
      extraCurrencies: currencies.filter(item => !FX_DEFAULT_CURRENCIES.includes(item)),
      quote,
      days: query.days,
      latest: latest.map(({ currency, rows }) => {
        const newestDate = rows[0] ? dateText(rows[0].rateDate) : null
        const best = newestDate ? pickEffectiveRate(rows.filter(row => dateText(row.rateDate) === newestDate).map(toRow)) : undefined
        return {
          currency,
          rateDate: best?.rateDate ?? null,
          rate: best?.rate ?? null,
          source: best?.source ?? null,
          isFallback: best?.isFallback ?? false,
          isManualOverride: best?.isManualOverride ?? false,
        }
      }),
      curve,
      sources: FX_ROLES.map(role => {
        const row = sources.find(item => item.role === role)
        const provider = (row?.provider ?? (role === 'PRIMARY' ? 'FRANKFURTER_BLENDED' : 'FRANKFURTER_ECB')) as FxProvider
        return {
          role,
          provider,
          providerLabel: FX_PROVIDERS[provider]?.label ?? provider,
          pathTemplate: row?.pathTemplate ?? FX_PROVIDERS[provider]?.template ?? '',
          configured: Boolean(row),
          lastAttemptAt: row?.lastAttemptAt ?? null,
          lastSuccessAt: row?.lastSuccessAt ?? null,
          lastStatus: row?.lastStatus ?? null,
          lastErrorCode: row?.lastErrorCode ?? null,
          consecutiveFailures: row?.consecutiveFailures ?? 0,
        }
      }),
      providers: Object.entries(FX_PROVIDERS).map(([key, value]) => ({ key, label: value.label, template: value.template })),
      overrides: overrides.map(row => ({
        id: row.id,
        quoteCurrency: row.quoteCurrency,
        rateDate: dateText(row.rateDate),
        rate: Number(row.rate.toString()),
        reason: row.overrideReason,
        overriddenBy: row.overriddenBy ? (nameOf.get(row.overriddenBy) ?? '已离开的成员') : null,
        createdAt: row.createdAt,
        locked: row.lockedByPeriodId !== null,
      })),
    }
  }
}
