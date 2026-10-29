import { Injectable } from '@nestjs/common'
import {
  FX_BASE_CURRENCY,
  FX_CURVE_MAX_DAYS,
  FX_MANUAL_SOURCE,
  FX_PROVIDERS,
  FxCurrenciesBodySchema,
  FxWriteBodySchema,
  fxTemplateProblem,
  pickEffectiveRate,
  type FxProvider,
  type FxRole,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { SettingsService } from '../settings'
import { configuredCurrencies } from './fx.service'

const PERMISSION = 'settings.fx.write'
const DAY_MS = 86_400_000
const LOCKED_MESSAGE = '该日汇率已被已关账的期间锁定，不能修改；如确需调整，请先由财务重新开账'
const asDate = (value: string) => new Date(`${value}T00:00:00Z`)
const dateText = (value: Date) => value.toISOString().slice(0, 10)

// 汇率写入（P1-28-2）：手工覆盖、选择来源、附加币种、立即获取。覆盖与改来源要求再次验证身份并写审计（含原因）。
@Injectable()
export class FxWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  /** POST /settings/fx：按 kind 区分手工覆盖与选择来源。 */
  async write(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, PERMISSION)
    const body = FxWriteBodySchema.parse(rawBody)
    return body.kind === 'override' ? this.override(req, context, body) : this.changeSources(req, context, body)
  }

  private async override(req: RequestWithContext, context: { tenantId: string; userId: string }, body: Extract<ReturnType<typeof FxWriteBodySchema.parse>, { kind: 'override' }>) {
    const tenantId = context.tenantId
    const currencies = await configuredCurrencies(this.settings, tenantId)
    if (!currencies.includes(body.quoteCurrency)) throw appError('VALIDATION_FAILED', '该币种还没有加入汇率币种，请先添加', { fieldErrors: { quoteCurrency: ['该币种还没有加入汇率币种'] } })
    const today = dateText(new Date())
    if (body.rateDate > today) throw appError('VALIDATION_FAILED', '覆盖日期不能晚于今天', { fieldErrors: { rateDate: ['不能晚于今天'] } })
    if (body.rateDate < dateText(new Date(Date.now() - FX_CURVE_MAX_DAYS * DAY_MS)))
      throw appError('VALIDATION_FAILED', `只能覆盖最近 ${FX_CURVE_MAX_DAYS} 天内的汇率`, { fieldErrors: { rateDate: ['日期过早'] } })
    return this.prisma.$transaction(async tx => {
      const rows = await tx.fxRate.findMany({ where: { tenantId, baseCurrency: FX_BASE_CURRENCY, quoteCurrency: body.quoteCurrency, rateDate: asDate(body.rateDate) }, take: 10 })
      if (rows.some(row => row.lockedByPeriodId)) throw appError('DATA_CONDITION_FAILED', LOCKED_MESSAGE)
      const toFx = (row: (typeof rows)[number]) => ({
        rateDate: body.rateDate,
        rate: Number(row.rate.toString()),
        source: row.source,
        isFallback: row.isFallback,
        isManualOverride: row.isManualOverride,
      })
      const before = pickEffectiveRate(rows.map(toFx))
      const manual = rows.find(row => row.source === FX_MANUAL_SOURCE)
      const data = { rate: body.rate.toFixed(8), overrideReason: body.reason, overriddenBy: context.userId, isManualOverride: true, isFallback: false, fetchedAt: new Date() }
      const saved = manual
        ? await tx.fxRate.update({ where: { id: manual.id }, data })
        : await tx.fxRate.create({ data: { tenantId, baseCurrency: FX_BASE_CURRENCY, quoteCurrency: body.quoteCurrency, rateDate: asDate(body.rateDate), source: FX_MANUAL_SOURCE, ...data } })
      await this.audit.record(
        req,
        {
          action: 'FX_RATE_OVERRIDDEN',
          resourceType: 'FxRate',
          resourceId: saved.id,
          before: before ? { rate: before.rate, source: before.source } : null,
          after: { rate: body.rate, source: FX_MANUAL_SOURCE },
          reason: body.reason,
          detail: { baseCurrency: FX_BASE_CURRENCY, quoteCurrency: body.quoteCurrency, rateDate: body.rateDate },
        },
        { client: tx },
      )
      return { id: saved.id, quoteCurrency: body.quoteCurrency, rateDate: body.rateDate, rate: body.rate }
    })
  }

  private async changeSources(req: RequestWithContext, context: { tenantId: string; userId: string }, body: Extract<ReturnType<typeof FxWriteBodySchema.parse>, { kind: 'source' }>) {
    const tenantId = context.tenantId
    const wanted: Array<{ role: FxRole; provider: FxProvider; pathTemplate: string }> = (
      [
        ['PRIMARY', body.primary],
        ['BACKUP', body.backup],
      ] as const
    ).map(([role, pick]) => ({ role, provider: pick.provider, pathTemplate: pick.pathTemplate ?? FX_PROVIDERS[pick.provider].template }))
    const fieldErrors: Record<string, string[]> = {}
    for (const item of wanted) {
      const problem = fxTemplateProblem(item.pathTemplate)
      if (problem) fieldErrors[item.role === 'PRIMARY' ? 'primary' : 'backup'] = [problem]
    }
    if (Object.keys(fieldErrors).length > 0) throw appError('VALIDATION_FAILED', '来源地址不符合要求', { fieldErrors })
    return this.prisma.$transaction(async tx => {
      const existing = await tx.fxSourceConfig.findMany({ where: { tenantId }, take: 10 })
      for (const item of wanted) {
        const row = existing.find(entry => entry.role === item.role)
        // 换了来源，历史的失败计数与状态就不再适用，清零后重新计
        const reset = { lastStatus: null, lastErrorCode: null, consecutiveFailures: 0 }
        if (row)
          await tx.fxSourceConfig.update({
            where: { id: row.id },
            data: {
              provider: item.provider,
              pathTemplate: item.pathTemplate,
              updatedBy: context.userId,
              ...(row.provider !== item.provider || row.pathTemplate !== item.pathTemplate ? reset : {}),
              version: { increment: 1 },
            },
          })
        else
          await tx.fxSourceConfig.create({
            data: { tenantId, role: item.role, provider: item.provider, pathTemplate: item.pathTemplate, priority: item.role === 'PRIMARY' ? 1 : 2, updatedBy: context.userId },
          })
      }
      const snapshot = (rows: Array<{ role: string; provider: string; pathTemplate: string }>) =>
        Object.fromEntries(rows.map(row => [row.role, { provider: row.provider, pathTemplate: row.pathTemplate }]))
      await this.audit.record(
        req,
        { action: 'FX_SOURCE_CHANGED', resourceType: 'FxSourceConfig', resourceId: tenantId, before: snapshot(existing), after: snapshot(wanted), reason: body.reason },
        { client: tx },
      )
      return { primary: wanted[0].provider, backup: wanted[1].provider }
    })
  }

  /** POST /settings/fx/currencies：设置附加币种。 */
  async setCurrencies(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, PERMISSION)
    const body = FxCurrenciesBodySchema.parse(rawBody)
    return this.prisma.$transaction(async tx => {
      const before = await this.settings.get(context.tenantId, 'fx.extraCurrencies', tx)
      const saved = await this.settings.set(tx, context.tenantId, context.userId, 'fx.extraCurrencies', [...new Set(body.currencies)], before.version)
      await this.audit.record(
        req,
        {
          action: 'FX_CURRENCIES_CHANGED',
          resourceType: 'TenantSetting',
          resourceId: 'fx.extraCurrencies',
          before: { currencies: before.value },
          after: { currencies: saved.value },
          reason: body.reason,
        },
        { client: tx },
      )
      return { currencies: saved.value }
    })
  }

  /** DELETE /settings/fx/overrides/:id：撤销一条手工覆盖，该日恢复为获取到的汇率。已被关账锁定的不能撤销。 */
  async removeOverride(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, PERMISSION)
    return this.prisma.$transaction(async tx => {
      const row = await tx.fxRate.findFirst({ where: { id, tenantId: context.tenantId, isManualOverride: true } })
      if (!row) throw appError('RESOURCE_NOT_FOUND', '覆盖记录不存在')
      if (row.lockedByPeriodId) throw appError('DATA_CONDITION_FAILED', LOCKED_MESSAGE)
      await tx.fxRate.delete({ where: { id } })
      await this.audit.record(
        req,
        {
          action: 'FX_OVERRIDE_REMOVED',
          resourceType: 'FxRate',
          resourceId: id,
          before: { rate: Number(row.rate.toString()), source: row.source },
          detail: { quoteCurrency: row.quoteCurrency, rateDate: dateText(row.rateDate) },
        },
        { client: tx },
      )
      return { id, removed: true }
    })
  }

  /** POST /settings/fx/refresh：立即获取一次（交给后台任务）；每天同一时刻只入队一次，避免重复点击刷屏。 */
  async refresh(req: RequestWithContext) {
    const context = await this.context.authorize(req, PERMISSION)
    const minute = Math.floor(Date.now() / 60_000)
    await this.queue.add('notifications', { tenantId: context.tenantId, kind: 'fx-fetch', requestedBy: context.userId }, `fx-fetch:${context.tenantId}:${minute}`)
    return { queued: true }
  }

  /** 期间关账时调用：把期间内的汇率锁定（数据库禁止再改）。返回锁定行数。 */
  async lockForPeriod(tx: Pick<Prisma.TransactionClient, 'fxRate'>, tenantId: string, periodId: string, from: string, to: string) {
    const result = await tx.fxRate.updateMany({ where: { tenantId, lockedByPeriodId: null, rateDate: { gte: asDate(from), lte: asDate(to) } }, data: { lockedByPeriodId: periodId } })
    return result.count
  }

  /** 期间重新开账时调用：解除该期间的汇率锁定（数据库只放行“解除锁定”这一种修改）。 */
  async unlockForPeriod(tx: Pick<Prisma.TransactionClient, 'fxRate'>, tenantId: string, periodId: string) {
    const result = await tx.fxRate.updateMany({ where: { tenantId, lockedByPeriodId: periodId }, data: { lockedByPeriodId: null } })
    return result.count
  }
}
