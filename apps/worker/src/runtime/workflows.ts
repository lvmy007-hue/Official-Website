import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, RetryableError, WORKFLOW_KINDS, type DistributedLockManager, type WorkflowDefinition, type WorkflowEngine, type WriteRunIntent } from '@nova/workflow'
import { BA_NO_BRAND, BA_SQP_ASIN_LIMIT, isBrandReportType } from '@nova/api-contracts'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { brandReportRequest } from '../connectors/brand-report-options'
import type { RequestGuard } from '../connectors/http-error'
import { isRoleMissing } from '../connectors/support-api'
import type { TokenOpener } from '../crypto/secrets'
import { withEvent } from '../reports/job-state'
import { createAdsWriteWorkflow } from './ads-write-workflow'
import { createAplusWorkflow } from './aplus-workflow'
import { createAwdWorkflow } from './awd-workflow'
import { createInboundWorkflow } from './inbound-workflow'
import { createListingWriteWorkflow } from './listing-write-workflow'
import { createSolicitationWorkflow } from './solicitation-workflow'

// 亚马逊写操作的流程定义（12.3）：先记录意图 → 调用 → 记录结果；崩溃或超时后先向亚马逊对账，查到就沿用，查不到才重新调用。
// 目前有两个会在亚马逊创建对象的操作：创建入库计划、创建报表。
// 对账依据：入库计划按“名称 + 本次请求发出之后创建”匹配；报表按“类型 + 站点 + 本次请求发出之后创建”匹配。
// 对账只会命中本次请求发出之后创建的对象（留 60 秒时钟误差），不会把更早的同名对象误当成本次结果。

const CLOCK_SKEW_MS = 60_000

export const INBOUND_PLAN_CREATE = WORKFLOW_KINDS.INBOUND_PLAN_CREATE
export const REPORT_CREATE = WORKFLOW_KINDS.REPORT_CREATE

export interface WriteWorkflowDeps {
  prisma: PrismaClient
  guardFor(tenantId: string, connectionId: string): RequestGuard
  secrets: TokenOpener
  /** 对象存储：A+ 上传图片要从这里读出文件（P4-14）；不提供时上传任务永久失败。 */
  storage?: ObjectStorage
}

type Intent = WriteRunIntent

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})
const unwrap = (payload: Record<string, unknown>) => asRecord(payload.payload ?? payload)

export function createWriteWorkflows(deps: WriteWorkflowDeps): {
  inboundPlanCreate: WorkflowDefinition<Intent>
  reportCreate: WorkflowDefinition<Intent>
  awdOrderWrite: WorkflowDefinition<Intent>
  inboundPlanOp: WorkflowDefinition<Intent>
  adsWrite: WorkflowDefinition<Intent>
  listingWrite: WorkflowDefinition<Intent>
  solicitationSend: WorkflowDefinition<Intent>
  aplusWrite: WorkflowDefinition<Intent>
} {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)

  /** 搜索查询表现报告要带 ASIN：有品牌的商品优先，一次最多 200 个。 */
  const brandAsins = (tenantId: string, sellerAccountId: string | null | undefined): Promise<string[]> =>
    sellerAccountId
      ? inTenant(tenantId, () =>
          deps.prisma.fbaProduct.findMany({
            where: { sellerAccountId },
            distinct: ['asin'],
            orderBy: [{ brand: { sort: 'asc', nulls: 'last' } }, { asin: 'asc' }],
            select: { asin: true },
            take: BA_SQP_ASIN_LIMIT,
          }),
        ).then(rows => rows.map(row => row.asin))
      : Promise.resolve([])

  async function clientFor(intent: Intent) {
    return inTenant(intent.tenantId, async () => {
      const connection = await deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } })
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      return new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId))
    })
  }

  const inboundPlanCreate: WorkflowDefinition<Intent> = {
    kind: INBOUND_PLAN_CREATE,
    steps: [
      {
        name: '向亚马逊提交入库计划',
        buildRequest: async ctx => {
          const plan = await inTenant(ctx.tenantId, () => deps.prisma.fbaInboundPlan.findUnique({ where: { id: ctx.intent.fbaPlanId } }))
          if (!plan) throw new NonRetryableError('FBA_PLAN_NOT_FOUND', '入库计划不存在')
          return { fbaPlanId: plan.id, name: plan.name, requestedAt: new Date().toISOString() }
        },
        run: async ctx => {
          const plan = await inTenant(ctx.tenantId, () => deps.prisma.fbaInboundPlan.findUnique({ where: { id: ctx.intent.fbaPlanId } }))
          if (!plan || !Array.isArray(plan.items)) throw new NonRetryableError('FBA_PLAN_ITEMS_MISSING', '入库计划没有商品明细')
          if (plan.externalPlanId) return { externalPlanId: plan.externalPlanId } // 已经提交过：直接沿用，不再调用
          const client = await clientFor(ctx.intent)
          const response = await client.createInboundPlan({
            name: plan.name,
            sourceAddress: plan.sourceAddress,
            items: plan.items as Array<{ sellerSku: string; asin: string; quantity: number }>,
          })
          const externalPlanId = typeof response.inboundPlanId === 'string' ? response.inboundPlanId : typeof response.planId === 'string' ? response.planId : undefined
          if (!externalPlanId) throw new NonRetryableError('FBA_INBOUND_PLAN_ID_NOT_RETURNED', '亚马逊没有返回入库计划编号')
          return { externalPlanId }
        },
        reconcile: async ctx => {
          const client = await clientFor(ctx.intent)
          const listed = asRecord(unwrap(await client.listInboundPlans()))
          const plans = Array.isArray(listed.inboundPlans) ? (listed.inboundPlans as Array<Record<string, unknown>>) : []
          const since = Date.parse(String(asRecord(ctx.request).requestedAt)) - CLOCK_SKEW_MS
          const hit = plans.find(plan => plan.name === asRecord(ctx.request).name && Date.parse(String(plan.createdAt)) >= since && typeof plan.inboundPlanId === 'string')
          return hit ? { found: true, response: { externalPlanId: hit.inboundPlanId } } : { found: false }
        },
      },
      {
        name: '回写亚马逊入库计划编号',
        run: async ctx => {
          const { externalPlanId } = asRecord(ctx.responseOf(0)) as { externalPlanId: string }
          await inTenant(ctx.tenantId, () => deps.prisma.fbaInboundPlan.update({ where: { id: ctx.intent.fbaPlanId }, data: { externalPlanId, status: 'CREATED', sourceUpdatedAt: new Date() } }))
          return { externalPlanId }
        },
      },
    ],
  }

  const reportCreate: WorkflowDefinition<Intent> = {
    kind: REPORT_CREATE,
    steps: [
      {
        name: '向亚马逊申请报表',
        buildRequest: ctx => ({ reportJobId: ctx.intent.reportJobId, reportType: ctx.intent.reportType, marketplaceId: ctx.intent.marketplaceId, requestedAt: new Date().toISOString() }),
        run: async ctx => {
          const job = await inTenant(ctx.tenantId, () => deps.prisma.fbaReportJob.findUnique({ where: { id: ctx.intent.reportJobId } }))
          if (!job) throw new NonRetryableError('REPORT_JOB_NOT_FOUND', '报表任务不存在')
          if (job.externalReportId) return { reportId: job.externalReportId }
          const client = await clientFor(ctx.intent)
          const reportType = ctx.intent.reportType!
          // 品牌分析：申请参数来自周期与店铺商品；没有品牌分析角色时亚马逊返回 403，记成“没有品牌”而不是授权失败（页面写明原因，不报警）
          const brand = isBrandReportType(reportType) ? brandReportRequest(reportType, job.fromDate, job.toDate, await brandAsins(ctx.tenantId, job.sellerAccountId)) : null
          const created = await client.createReport(reportType, job.marketplaceId || ctx.intent.marketplaceId!, { from: job.fromDate, to: job.toDate }, brand).catch((error: unknown) => {
            throw brand && isRoleMissing(error) ? new NonRetryableError(BA_NO_BRAND, '店铺没有品牌备案或没有品牌分析角色') : error
          })
          const report = unwrap(created)
          const reportId = typeof report.reportId === 'string' ? report.reportId : undefined
          if (!reportId) throw new NonRetryableError('REPORT_ID_NOT_RETURNED', '亚马逊没有返回报表编号')
          return { reportId }
        },
        reconcile: async ctx => {
          const client = await clientFor(ctx.intent)
          const listed = unwrap(await client.listReports(ctx.intent.reportType!, new Date(Date.parse(String(asRecord(ctx.request).requestedAt)) - CLOCK_SKEW_MS), ctx.intent.marketplaceId!))
          const reports = Array.isArray(listed.reports) ? (listed.reports as Array<Record<string, unknown>>) : []
          const since = Date.parse(String(asRecord(ctx.request).requestedAt)) - CLOCK_SKEW_MS
          const hit = reports
            .filter(report => report.reportType === ctx.intent.reportType && Date.parse(String(report.createdTime)) >= since && typeof report.reportId === 'string')
            .sort((a, b) => Date.parse(String(a.createdTime)) - Date.parse(String(b.createdTime)))[0]
          return hit ? { found: true, response: { reportId: hit.reportId } } : { found: false }
        },
      },
      {
        name: '回写亚马逊报表编号',
        run: async ctx => {
          const { reportId } = asRecord(ctx.responseOf(0)) as { reportId: string }
          await inTenant(ctx.tenantId, async () => {
            const current = await deps.prisma.fbaReportJob.findUnique({ where: { id: ctx.intent.reportJobId }, select: { status: true, timelineJson: true } })
            // 申请期间用户在报表中心取消了任务：只记下亚马逊报告编号，不把状态改回“生成中”
            if (current?.status === 'CANCELLED') return deps.prisma.fbaReportJob.update({ where: { id: ctx.intent.reportJobId }, data: { externalReportId: reportId } })
            return deps.prisma.fbaReportJob.update({
              where: { id: ctx.intent.reportJobId },
              data: { status: 'GENERATING', externalReportId: reportId, startedAt: new Date(), timelineJson: withEvent(current?.timelineJson, 'SUBMITTED', `亚马逊报告编号 ${reportId}`) },
            })
          })
          return { reportId }
        },
      },
    ],
  }

  return {
    inboundPlanCreate,
    reportCreate,
    awdOrderWrite: createAwdWorkflow(deps),
    inboundPlanOp: createInboundWorkflow(deps),
    adsWrite: createAdsWriteWorkflow(deps),
    listingWrite: createListingWriteWorkflow(deps),
    solicitationSend: createSolicitationWorkflow(deps),
    aplusWrite: createAplusWorkflow(deps),
  }
}

/** 流程自己的锁键：同一个流程同一时刻只允许一个进程执行（队列任务与恢复扫描互斥）。 */
export const workflowLockKey = (runId: string) => `wf:${runId}`

/**
 * 启动或续上一个写操作流程，并在持有“流程锁”的状态下执行。
 * 接口服务受理用户操作时可能已经按同一个去重键登记了流程，这里直接续上。
 * 终态为失败时抛出不可重试错误，让任务进入死信。
 */
export async function runWriteWorkflow(
  engine: WorkflowEngine,
  locks: DistributedLockManager,
  definition: WorkflowDefinition<Intent>,
  input: { tenantId: string; dedupeKey: string; intent: Intent; syncJobId: string; priority: number; lease: { assertHeld(): void } | null; isLastAttempt: boolean; owner: string },
): Promise<unknown> {
  const { run } = await engine.start({ tenantId: input.tenantId, kind: definition.kind, dedupeKey: input.dedupeKey, intent: input.intent, syncJobId: input.syncJobId, priority: input.priority })
  const own = await locks.tryAcquire(input.tenantId, workflowLockKey(run.id), input.owner)
  if (!own) throw new RetryableError('WORKFLOW_BUSY', `流程 ${run.id} 正由其他进程执行，稍后再试`, 5_000)
  try {
    const lease = {
      assertHeld: () => {
        input.lease?.assertHeld()
        own.assertHeld()
      },
    }
    const done = await engine.execute(input.tenantId, run.id, definition, { lease, isLastAttempt: input.isLastAttempt })
    if (done.status !== 'SUCCEEDED') throw new NonRetryableError(done.errorCode ?? 'WORKFLOW_FAILED', `流程 ${done.id} 未成功（${done.status}）`)
    return done.result
  } finally {
    await own.release().catch(() => undefined)
  }
}
