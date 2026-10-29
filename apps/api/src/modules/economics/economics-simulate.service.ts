import { Injectable } from '@nestjs/common'
import { ECONOMICS_DATASET_SIMULATION, ECONOMICS_READ, EconomicsSimulateBodySchema, type EconomicsSimulation, type EconomicsSimulationInput, type EconomicsSimulationResult } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { asDate, dateText, todayIn, validZone } from '../overview'

const FAILED_NOTE = '亚马逊数据中心的模拟查询失败，详情见同步中心里对应的任务'
const PENDING_NOTE = '查询已提交给亚马逊数据中心，结果通常需要几分钟到几十分钟，页面会自动刷新'
const EMPTY_NOTE = '查询已完成，但亚马逊没有返回这个商品与动作的经济模拟结果（只返回有资格使用该服务的商品）'
/** 一个企业同时在途的模拟查询上限：每次查询都占用亚马逊数据中心的查询配额。 */
const MAX_ACTIVE = 5

const addDays = (date: string, days: number) => dateText(new Date(asDate(date).getTime() + days * 86_400_000))

interface StoredResult {
  currency?: string | null
  sales?: number | null
  fees?: number | null
  netProceeds?: number | null
  units?: number | null
  rows?: number
}

// 情景模拟（07 章 7.10 第 3 个页签）：向亚马逊数据中心提交 economicsSimulation 查询（原包装发货 SIPP 或发往上游仓储 AWD，可设数量与单价），
// 结果是官方估算值，异步返回：POST 只建记录与任务，页面用 GET /simulations/:id 轮询。官方没有给出对照基线，页面不据此给出“省了多少钱”的结论。
@Injectable()
export class EconomicsSimulateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly queue: QueueService,
  ) {}

  async simulate(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<EconomicsSimulation> {
    // 先权限、再参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ECONOMICS_READ, {})
    const body = EconomicsSimulateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.sellerAccountId)
    const connection = await this.prisma.platformConnection.findFirst({
      where: { tenantId: context.tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', sellerAccountId: body.sellerAccountId, encryptedRefreshToken: { not: null } },
      select: { id: true },
    })
    if (!connection) throw appError('CONFLICT', '这个店铺还没有完成卖家授权，无法向亚马逊数据中心发起模拟查询')
    const active = await this.prisma.syncJob.count({
      where: { tenantId: context.tenantId, type: 'DATA_KIOSK_QUERY', status: { in: ['PENDING', 'RUNNING'] }, context: { path: ['dataset'], equals: ECONOMICS_DATASET_SIMULATION } },
    })
    if (active >= MAX_ACTIVE) throw appError('CONFLICT', `同时进行的模拟查询已有 ${active} 个，请等其中一些完成后再提交`)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const startDate = today
    const endDate = addDays(today, body.endInDays)
    const input: EconomicsSimulationInput = {
      sellerAccountId: body.sellerAccountId,
      sku: body.sku,
      actionType: body.actionType,
      quantity: body.quantity ?? null,
      itemPrice: body.itemPrice ?? null,
      startDate,
      endDate,
    }
    const params: Record<string, string> = { sku: body.sku, actionType: body.actionType, startDate, endDate, sellerAccountId: body.sellerAccountId }
    if (body.quantity !== undefined) params.quantity = String(body.quantity)
    if (body.itemPrice !== undefined) params.price = String(body.itemPrice)
    const { run, job } = await this.prisma.$transaction(async tx => {
      const created = await tx.economicsSimulationRun.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: body.sellerAccountId,
          actionType: body.actionType,
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
          context: { dataset: ECONOMICS_DATASET_SIMULATION, params: { runId: created.id, ...params } },
          ...syncJobMeta(connection.id, 'DATA_KIOSK_QUERY', [created.id]),
        },
      })
      await tx.economicsSimulationRun.update({ where: { id: created.id }, data: { syncJobId: syncJob.id } })
      await this.audit.record(
        req,
        {
          action: 'ECONOMICS_SIMULATED',
          resourceType: 'EconomicsSimulationRun',
          resourceId: created.id,
          detail: { sku: body.sku, actionType: body.actionType, quantity: body.quantity ?? null, itemPrice: body.itemPrice ?? null, startDate, endDate },
        },
        { client: tx },
      )
      return { run: created, job: syncJob }
    })
    await this.queue.add('sync', { tenantId: context.tenantId, syncJobId: job.id, requestId: req.requestId }, job.id, { type: 'DATA_KIOSK_QUERY', priority: job.priority })
    return { runId: run.id, status: 'PENDING', note: PENDING_NOTE, input, result: null }
  }

  /** 轮询一次模拟的运行状态与结果。 */
  async run(req: RequestWithContext, id: string): Promise<EconomicsSimulation> {
    const { context, scope } = await this.context.authorizeScoped(req, ECONOMICS_READ, {})
    const run = await this.prisma.economicsSimulationRun.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!run) throw appError('RESOURCE_NOT_FOUND', '模拟记录不存在')
    assertStoreInScope(scope, run.sellerAccountId)
    const job = run.syncJobId ? await this.prisma.syncJob.findFirst({ where: { id: run.syncJobId, tenantId: context.tenantId }, select: { status: true } }) : null
    const stored = (run.inputJson ?? {}) as Partial<EconomicsSimulationInput>
    const input: EconomicsSimulationInput = {
      sellerAccountId: run.sellerAccountId,
      sku: stored.sku ?? '',
      actionType: run.actionType === 'SIPP' ? 'SIPP' : 'AWD', // 旧的补货页模拟只有 AWD
      quantity: stored.quantity ?? null,
      itemPrice: stored.itemPrice ?? null,
      startDate: stored.startDate ?? dateText(run.startDate),
      endDate: stored.endDate ?? dateText(run.endDate),
    }
    // 后台任务在结果里还存了逐行明细（重试时按行覆盖、避免重复累加），对外只给汇总；净收入含利润信息，没有利润字段权限的不给
    const raw = (run.resultJson ?? null) as StoredResult | null
    const result: EconomicsSimulationResult | null = raw
      ? {
          currency: raw.currency ?? null,
          sales: raw.sales ?? null,
          fees: raw.fees ?? null,
          netProceeds: canSeeField(context.permissions, 'profit') ? (raw.netProceeds ?? null) : null,
          units: raw.units ?? null,
          rows: raw.rows ?? 0,
        }
      : null
    const status: EconomicsSimulation['status'] = job?.status === 'FAILED' ? 'FAILED' : job?.status === 'SUCCEEDED' ? 'DONE' : 'PENDING'
    return {
      runId: run.id,
      status,
      note: status === 'FAILED' ? FAILED_NOTE : status === 'PENDING' ? PENDING_NOTE : result && result.rows > 0 ? null : EMPTY_NOTE,
      input,
      result: status === 'DONE' ? result : null,
    }
  }
}
