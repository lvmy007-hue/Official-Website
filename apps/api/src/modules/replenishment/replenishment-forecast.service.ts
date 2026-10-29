import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  describeForecastOverride,
  forecastPeriodsOverlap,
  forecastStatusOf,
  ForecastCreateBodySchema,
  ForecastListQuerySchema,
  ForecastUpdateBodySchema,
  FORECAST_ACTIONS,
  FORECAST_ACTIVE_LIMIT,
  FORECAST_BLOCKED_NO_PERMISSION,
  FORECAST_PRIORITY_NOTE,
  FORECAST_READ,
  FORECAST_SCOPE_LABEL,
  FORECAST_WRITE,
  type ForecastListQuery,
  type ForecastMode,
  type ForecastOverrideListResponse,
  type ForecastOverrideRow,
  type ForecastScopeType,
} from '@nova/api-contracts'
import type { ForecastOverride, Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { assertUnrestricted, ContextService } from '../auth'
import { InventoryPolicyService } from '../inventory'

const LABEL = '人工预测规则'
const dateText = (value: Date) => value.toISOString().slice(0, 10)
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const num = (value: { toString(): string }) => Number(value.toString())

const auditView = (row: ForecastOverride) => ({
  scope: `${FORECAST_SCOPE_LABEL[row.scopeType as ForecastScopeType]} ${row.scopeId}`,
  rule: describeForecastOverride({ from: dateText(row.fromDate), to: dateText(row.toDate), mode: row.mode as ForecastMode, value: num(row.value) }),
  note: row.note,
})

// 人工预测规则（P6-09，16 章第 4 节；freeze/api.md `/replenishment/forecast-overrides*`）。
// 规则：
//   - 读取要 replenishment.read；新增、修改、删除要 replenishment.policy.write，并且数据范围必须是“全部店铺”（规则对所有店铺的同名 SKU / 同品类生效）；
//   - 对象（SKU 或品类）必须是企业里已有的商品（卖家 SKU 或商品类型），写错的名字不会悄悄保存成一条永远不生效的规则；
//   - 同一对象的时间段不能重叠（409，并说明冲突的是哪一条）；未结束的规则最多 300 条；结束日期早于今天的不能新增（已经没有意义）；
//   - 修改带乐观锁版本号；删除、修改、新增都写审计；
//   - 规则只影响之后重新计算的批次：批次在生成时把用到的规则冻结进每条建议的计算链，之后修改或删除规则不会改变已有批次。
@Injectable()
export class ReplenishmentForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  private rowsOf(rows: ForecastOverride[], today: string, names: ReadonlyMap<string, string>): ForecastOverrideRow[] {
    return rows.map(row => {
      const from = dateText(row.fromDate)
      const to = dateText(row.toDate)
      const mode = row.mode as ForecastMode
      const value = num(row.value)
      return {
        id: row.id,
        scopeType: row.scopeType as ForecastScopeType,
        scopeId: row.scopeId,
        from,
        to,
        mode,
        value,
        note: row.note,
        version: row.version,
        status: forecastStatusOf(from, to, today),
        createdBy: nameOrFormer(names, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        summary: describeForecastOverride({ from, to, mode, value }),
      }
    })
  }

  private statusWhere(status: ForecastListQuery['status'], today: string): Prisma.ForecastOverrideWhereInput {
    const day = asDate(today)
    if (status === 'UPCOMING') return { fromDate: { gt: day } }
    if (status === 'ACTIVE') return { fromDate: { lte: day }, toDate: { gte: day } }
    if (status === 'EXPIRED') return { toDate: { lt: day } }
    return {}
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ForecastOverrideListResponse> {
    const context = await this.context.authorize(req, FORECAST_READ)
    const query = ForecastListQuerySchema.parse(rawQuery)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const base = { tenantId: context.tenantId }
    const where: Prisma.ForecastOverrideWhereInput = {
      ...base,
      ...(query.scopeType ? { scopeType: query.scopeType } : {}),
      ...(query.q ? { scopeId: { contains: query.q, mode: 'insensitive' } } : {}),
      ...this.statusWhere(query.status, today),
    }
    const field: Record<string, 'fromDate' | 'toDate' | 'scopeId' | 'updatedAt'> = { from: 'fromDate', to: 'toDate', scopeId: 'scopeId', updatedAt: 'updatedAt' }
    const order: Prisma.ForecastOverrideOrderByWithRelationInput[] = [{ [field[query.sort.field] ?? 'fromDate']: query.sort.dir }, { id: 'asc' }]
    const [rows, total, activeCount] = await Promise.all([
      this.prisma.forecastOverride.findMany({ where, orderBy: order, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.forecastOverride.count({ where }),
      this.prisma.forecastOverride.count({ where: { ...base, toDate: { gte: asDate(today) } } }),
    ])
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.createdBy),
    )
    const canManage = hasPermission(context.permissions, FORECAST_WRITE)
    return {
      items: this.rowsOf(rows, today, names),
      page: query.page,
      pageSize: query.pageSize,
      total,
      today,
      activeCount,
      activeLimit: FORECAST_ACTIVE_LIMIT,
      canManage,
      manageBlockedReason: canManage ? null : FORECAST_BLOCKED_NO_PERMISSION,
      priorityNote: FORECAST_PRIORITY_NOTE,
    }
  }

  /** 对象必须是企业里已有的商品：卖家 SKU 或商品类型。 */
  private async assertTarget(tenantId: string, scopeType: ForecastScopeType, scopeId: string) {
    const found = await this.prisma.fbaProduct.findFirst({
      where: { tenantId, ...(scopeType === 'SKU' ? { sellerSku: scopeId } : { productType: scopeId }) },
      select: { id: true },
    })
    if (!found) throw appError('RESOURCE_NOT_FOUND', scopeType === 'SKU' ? `没有找到卖家 SKU “${scopeId}”，请核对拼写（区分大小写）` : `没有找到商品类型 “${scopeId}”，请核对拼写`)
  }

  /** 同一对象不允许时间段重叠（排除自己）；冲突时指出是哪一条。 */
  private async assertNoOverlap(tx: Pick<Prisma.TransactionClient, 'forecastOverride'>, tenantId: string, rule: { scopeType: string; scopeId: string; from: string; to: string }, exceptId?: string) {
    const near = await tx.forecastOverride.findMany({
      where: { tenantId, scopeType: rule.scopeType, scopeId: rule.scopeId, fromDate: { lte: asDate(rule.to) }, toDate: { gte: asDate(rule.from) }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      orderBy: [{ fromDate: 'asc' }, { id: 'asc' }],
      take: 5,
    })
    const clash = near.find(row => forecastPeriodsOverlap({ from: dateText(row.fromDate), to: dateText(row.toDate) }, rule))
    if (clash) {
      const text = describeForecastOverride({ from: dateText(clash.fromDate), to: dateText(clash.toDate), mode: clash.mode as ForecastMode, value: num(clash.value) })
      throw appError('CONFLICT', `时间段与已有规则重叠：${text}。请先修改或删除那条，或调整时间段`, { details: { conflictId: clash.id } })
    }
  }

  private async load(tenantId: string, id: string): Promise<ForecastOverride> {
    const row = await this.prisma.forecastOverride.findFirst({ where: { id, tenantId } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    return row
  }

  private async one(tenantId: string, row: ForecastOverride, today: string): Promise<ForecastOverrideRow> {
    const names = await memberNames(this.prisma, tenantId, [row.createdBy])
    return this.rowsOf([row], today, names)[0]!
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<ForecastOverrideRow> {
    const { context, scope } = await this.context.authorizeScoped(req, FORECAST_WRITE, {})
    assertUnrestricted(scope)
    const body = ForecastCreateBodySchema.parse(rawBody)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    if (body.to < today) throw appError('VALIDATION_FAILED', '结束日期已经过去，这条规则不会影响任何计算', { fieldErrors: { to: ['结束日期不能早于今天'] } })
    await this.assertTarget(context.tenantId, body.scopeType, body.scopeId)
    const row = await this.prisma.$transaction(async tx => {
      const active = await tx.forecastOverride.count({ where: { tenantId: context.tenantId, toDate: { gte: asDate(today) } } })
      if (active >= FORECAST_ACTIVE_LIMIT) throw appError('CONFLICT', `未结束的人工预测规则最多 ${FORECAST_ACTIVE_LIMIT} 条，请先删除不用的`)
      await this.assertNoOverlap(tx, context.tenantId, body)
      const created = await tx.forecastOverride.create({
        data: {
          tenantId: context.tenantId,
          scopeType: body.scopeType,
          scopeId: body.scopeId,
          fromDate: asDate(body.from),
          toDate: asDate(body.to),
          mode: body.mode,
          value: body.value,
          note: body.note,
          createdBy: context.userId,
        },
      })
      await this.audit.record(req, { action: FORECAST_ACTIONS.created, resourceType: 'ForecastOverride', resourceId: created.id, after: auditView(created) }, { client: tx })
      return created
    })
    return this.one(context.tenantId, row, today)
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<ForecastOverrideRow> {
    const { context, scope } = await this.context.authorizeScoped(req, FORECAST_WRITE, {})
    assertUnrestricted(scope)
    const body = ForecastUpdateBodySchema.parse(rawBody)
    const { version, from, to, mode, value, note } = body
    const current = await this.load(context.tenantId, id)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    if (dateText(current.toDate) < today) throw appError('CONFLICT', '这条规则已经结束，不能再修改；如需沿用请新建一条')
    const next = {
      from: from ?? dateText(current.fromDate),
      to: to ?? dateText(current.toDate),
      mode: mode ?? (current.mode as ForecastMode),
      value: value ?? num(current.value),
    }
    // 只改了一端日期或模式时，合并后的整体也要符合“同期系数大于 0、时间段不超过 366 天”等约束
    const merged = ForecastCreateBodySchema.safeParse({ scopeType: current.scopeType, scopeId: current.scopeId, ...next, note: null })
    if (!merged.success) throw appError('VALIDATION_FAILED', merged.error.issues[0]?.message ?? '规则内容不正确')
    if (next.to < today) throw appError('VALIDATION_FAILED', '结束日期已经过去，这条规则不会影响任何计算', { fieldErrors: { to: ['结束日期不能早于今天'] } })
    const data: Prisma.ForecastOverrideUncheckedUpdateManyInput = {
      ...(from !== undefined ? { fromDate: asDate(from) } : {}),
      ...(to !== undefined ? { toDate: asDate(to) } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(note !== undefined ? { note: note || null } : {}),
    }
    if (Object.keys(data).length === 0) throw appError('VALIDATION_FAILED', '没有需要保存的修改')
    const row = await this.prisma.$transaction(async tx => {
      await this.assertNoOverlap(tx, context.tenantId, { scopeType: current.scopeType, scopeId: current.scopeId, from: next.from, to: next.to }, current.id)
      const saved = await updateWithVersion(tx.forecastOverride, { id: current.id, tenantId: context.tenantId }, version, data as Record<string, unknown>, { label: LABEL })
      await this.audit.record(req, { action: FORECAST_ACTIONS.updated, resourceType: 'ForecastOverride', resourceId: current.id, before: auditView(current), after: auditView(saved) }, { client: tx })
      return saved
    })
    return this.one(context.tenantId, row, today)
  }

  async remove(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const { context, scope } = await this.context.authorizeScoped(req, FORECAST_WRITE, {})
    assertUnrestricted(scope)
    const current = await this.load(context.tenantId, id)
    await this.prisma.$transaction(async tx => {
      await tx.forecastOverride.deleteMany({ where: { id: current.id, tenantId: context.tenantId } })
      await this.audit.record(req, { action: FORECAST_ACTIONS.deleted, resourceType: 'ForecastOverride', resourceId: current.id, before: auditView(current) }, { client: tx })
    })
    return { id: current.id }
  }
}
