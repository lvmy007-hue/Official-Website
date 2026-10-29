import { Injectable } from '@nestjs/common'
import { SimulateBodySchema, US_MARKETPLACE_ID, type AwdEconomics, type AwdSimulation, type SimulationResponse } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { countedInbound, daysBetween, InventoryPolicyService, plusDays } from '../inventory'
import { calculate } from './replenishment-compute.service'
import { ReplenishmentLoaderService } from './replenishment-loader.service'
import { ReplenishmentPolicyService } from './replenishment-policy.service'
import { indexPolicies, pickPolicy } from './replenishment-resolve'
import { simulateTrend } from './replenishment-simulate'

export const ECONOMICS_DATASET = 'dk.economics-simulation'
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (value: Date) => value.toISOString().slice(0, 10)

const FAILED_NOTE = '亚马逊数据中心的模拟查询失败，详情见同步中心里对应的任务'
const PENDING_NOTE = '查询已提交给亚马逊数据中心，结果通常需要几分钟到几十分钟，页面会自动刷新'
const EMPTY_NOTE = '查询已完成，但亚马逊没有返回这个商品与数量的经济模拟结果'

// 模拟：库存走势（实时算，纯函数）与上游仓储经济模拟（亚马逊数据中心 economicsSimulation，异步）。
@Injectable()
export class ReplenishmentSimulateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly queue: QueueService,
    private readonly loader: ReplenishmentLoaderService,
    private readonly policies: ReplenishmentPolicyService,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  async simulate(req: RequestWithContext, rawBody: unknown): Promise<SimulationResponse> {
    const body = SimulateBodySchema.parse(rawBody)
    if (body.kind === 'AWD') return this.startAwd(req, body)
    const { context, scope } = await this.context.authorizeScoped(req, 'replenishment.read', {})
    assertStoreInScope(scope, body.sellerAccountId)
    const record = await this.prisma.fbaInventoryRecord.findFirst({
      where: { tenantId: context.tenantId, sellerAccountId: body.sellerAccountId, sellerSku: body.sku, marketplaceId: US_MARKETPLACE_ID },
      select: { id: true },
    })
    if (!record) throw appError('RESOURCE_NOT_FOUND', '没有找到这个店铺的 SKU 库存记录')
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const { items } = await this.loader.load({ tenantId: context.tenantId, scope, today, ids: [record.id] })
    const item = items[0]
    if (!item) throw appError('RESOURCE_NOT_FOUND', '没有找到这个店铺的 SKU 库存记录')
    const policy = pickPolicy(indexPolicies(await this.policies.effectiveOf(context.tenantId, today)), item.row.sku, item.category)
    const calc = calculate(item, policy, today)
    const q = item.row.quantity
    const inbound = { working: q.inboundWorking, shipped: q.inboundShipped, receiving: q.inboundReceiving }
    // 没有策略时没有“计入哪些在途”的口径，在途全部计入并在假设里写明
    const counted = policy ? countedInbound(policy.inboundCounted, inbound) : inbound.working + inbound.shipped + inbound.receiving
    return simulateTrend({
      today,
      sellable: q.sellable,
      inboundCounted: counted,
      inboundArrivalDays: body.inboundArrivalDays,
      dailyDemand: calc.dailyDemand ?? item.row.demand.mid,
      recommended: calc.state === 'OK' ? calc.shipments.map(shipment => ({ day: Math.max(1, daysBetween(today, shipment.arriveDate)), qty: shipment.qty })) : [],
      recommendedNote: calc.state === 'OK' ? null : (calc.reason ?? '当前没有可执行的补货建议'),
      custom: body.customQty !== undefined && body.customArriveInDays !== undefined && body.customQty > 0 ? { day: body.customArriveInDays, qty: body.customQty } : null,
    })
  }

  private async startAwd(req: RequestWithContext, body: Extract<ReturnType<typeof SimulateBodySchema.parse>, { kind: 'AWD' }>): Promise<AwdSimulation> {
    const { context, scope } = await this.context.authorizeScoped(req, 'replenishment.plan.create', {})
    assertStoreInScope(scope, body.sellerAccountId)
    const connection = await this.prisma.platformConnection.findFirst({
      where: { tenantId: context.tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: body.sellerAccountId, encryptedRefreshToken: { not: null } },
      select: { id: true },
    })
    if (!connection) throw appError('CONFLICT', '这个店铺还没有完成卖家授权，无法向亚马逊数据中心发起模拟查询')
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const startDate = today
    const endDate = plusDays(today, body.endInDays)
    const input = { quantity: body.quantity, startDate, endDate, sku: body.sku }
    const { run, job } = await this.prisma.$transaction(async tx => {
      const created = await tx.economicsSimulationRun.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: body.sellerAccountId,
          actionType: 'AWD',
          startDate: asDate(startDate),
          endDate: asDate(endDate),
          inputJson: input as unknown as Prisma.InputJsonValue,
          createdBy: context.userId,
        },
      })
      const syncJob = await tx.syncJob.create({
        data: {
          tenantId: context.tenantId,
          connectionId: connection.id,
          type: 'DATA_KIOSK_QUERY',
          status: 'PENDING',
          requestId: req.requestId,
          context: { dataset: ECONOMICS_DATASET, params: { runId: created.id, sku: body.sku, quantity: String(body.quantity), startDate, endDate, sellerAccountId: body.sellerAccountId } },
          ...syncJobMeta(connection.id, 'DATA_KIOSK_QUERY', [created.id]),
        },
      })
      await tx.economicsSimulationRun.update({ where: { id: created.id }, data: { syncJobId: syncJob.id } })
      await this.audit.record(
        req,
        { action: 'REPLENISHMENT_AWD_SIMULATED', resourceType: 'EconomicsSimulationRun', resourceId: created.id, detail: { sku: body.sku, quantity: body.quantity, startDate, endDate } },
        { client: tx },
      )
      return { run: created, job: syncJob }
    })
    await this.queue.add('sync', { tenantId: context.tenantId, syncJobId: job.id, requestId: req.requestId }, job.id, { type: 'DATA_KIOSK_QUERY', priority: job.priority })
    return { kind: 'AWD', runId: run.id, status: 'PENDING', note: PENDING_NOTE, input, result: null }
  }

  /** 轮询上游仓储模拟的运行状态与结果。 */
  async awdRun(req: RequestWithContext, id: string): Promise<AwdSimulation> {
    const { context, scope } = await this.context.authorizeScoped(req, 'replenishment.read', {})
    const run = await this.prisma.economicsSimulationRun.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!run) throw appError('RESOURCE_NOT_FOUND', '模拟记录不存在')
    assertStoreInScope(scope, run.sellerAccountId)
    const job = run.syncJobId ? await this.prisma.syncJob.findFirst({ where: { id: run.syncJobId, tenantId: context.tenantId }, select: { status: true } }) : null
    const input = run.inputJson as unknown as AwdSimulation['input']
    // 后台任务在结果里还存了逐行明细（用于重试时按行覆盖、避免重复累加），对外只给汇总
    const stored = (run.resultJson ?? null) as AwdEconomics | null
    const result: AwdEconomics | null = stored
      ? { currency: stored.currency ?? null, sales: stored.sales ?? null, fees: stored.fees ?? null, netProceeds: stored.netProceeds ?? null, rows: stored.rows ?? 0 }
      : null
    const status: AwdSimulation['status'] = job?.status === 'FAILED' ? 'FAILED' : job?.status === 'SUCCEEDED' ? 'DONE' : 'PENDING'
    return {
      kind: 'AWD',
      runId: run.id,
      status,
      note: status === 'FAILED' ? FAILED_NOTE : status === 'PENDING' ? PENDING_NOTE : result && result.rows > 0 ? null : EMPTY_NOTE,
      input: { ...input, startDate: input.startDate ?? dateText(run.startDate), endDate: input.endDate ?? dateText(run.endDate) },
      result: status === 'DONE' ? result : null,
    }
  }
}
