import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  CUSTOM_REPORT_MAX,
  CustomReportBodySchema,
  EXPORT_MAX_ACTIVE_PER_USER,
  REPORT_EXPORT_ROW_MAX,
  REPORT_EXPORT_TIMEOUT_MS,
  REPORTS_CUSTOM_SHARE,
  REPORTS_CUSTOM_WRITE,
  rangeTooLong,
  REPORTS_READ,
  ReportListQuerySchema,
  ReportRunSchema,
  sourceByCode,
  type ReportQueryResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService, ScopeService } from '../auth'
import { ReportQueryService } from './report-query.service'

// 我的报表（P6-32）：自己的和共享的都能看。共享后按调用人的权限取数。
// 超过一页的结果不在接口里摊开，写入导出任务；导出行是接口已经按权限取好的快照。

const viewOf = (
  row: {
    id: string
    name: string
    source: string
    shared: boolean
    config: unknown
    schedule: unknown
    starredBy: string[]
    ownerId: string
    version: number
    updatedAt: Date
  },
  userId: string,
) => ({
  id: row.id,
  name: row.name,
  source: row.source,
  shared: row.shared,
  config: row.config,
  schedule: row.schedule,
  starred: row.starredBy.includes(userId),
  ownerId: row.ownerId,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
})

@Injectable()
export class CustomReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly scopes: ScopeService,
    private readonly queue: QueueService,
    private readonly query: ReportQueryService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>) {
    const context = await this.context.authorize(req, REPORTS_READ)
    const query = ReportListQuerySchema.parse(rawQuery)
    const where = {
      tenantId: context.tenantId,
      AND: [{ OR: [{ ownerId: context.userId }, { shared: true }] }, ...(query.q ? [{ name: { contains: query.q, mode: 'insensitive' as const } }] : [])],
    }
    const [total, rows] = await Promise.all([
      this.prisma.customReport.count({ where }),
      this.prisma.customReport.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ])
    return { items: rows.map(row => viewOf(row, context.userId)), total, page: query.page, pageSize: query.pageSize }
  }

  async create(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    if (raw && typeof raw === 'object' && (raw as { shared?: unknown }).shared === true) await this.context.authorize(req, REPORTS_CUSTOM_SHARE)
    const body = CustomReportBodySchema.parse(raw)
    await this.assertConfig(context.tenantId, body.source, body.config)
    this.assertSchedule(body.schedule)
    const count = await this.prisma.customReport.count({ where: { tenantId: context.tenantId } })
    if (count >= CUSTOM_REPORT_MAX) throw appError('QUOTA_EXCEEDED', `每个企业最多 ${CUSTOM_REPORT_MAX} 张我的报表`)
    const row = await this.prisma.customReport.create({
      data: {
        tenantId: context.tenantId,
        ownerId: context.userId,
        name: body.name,
        source: body.source,
        shared: body.shared === true,
        config: body.config as Prisma.InputJsonValue,
        schedule: body.schedule ? (body.schedule as Prisma.InputJsonValue) : Prisma.DbNull,
        starredBy: body.starred ? [context.userId] : [],
        version: 1,
      },
    })
    if (req.params) req.params.id = row.id
    return viewOf(row, context.userId)
  }

  async update(req: RequestWithContext, id: string, raw: unknown) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    const body = CustomReportBodySchema.parse(raw)
    if (!body.version) throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
    const current = await this.prisma.customReport.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!current || (current.ownerId !== context.userId && !current.shared)) throw appError('RESOURCE_NOT_FOUND', '报表不存在')
    const starredBy = this.starred(current.starredBy, context.userId, body.starred)
    if (current.ownerId === context.userId && body.shared === true && !current.shared) await this.context.authorize(req, REPORTS_CUSTOM_SHARE)
    if (current.ownerId !== context.userId) {
      const row = await updateWithVersion(this.prisma.customReport, { id, tenantId: context.tenantId }, body.version, { starredBy }, { label: '报表' })
      return viewOf(row, context.userId)
    }
    await this.assertConfig(context.tenantId, body.source, body.config)
    this.assertSchedule(body.schedule)
    const row = await updateWithVersion(
      this.prisma.customReport,
      { id, tenantId: context.tenantId },
      body.version,
      {
        name: body.name,
        source: body.source,
        shared: body.shared === undefined ? current.shared : body.shared,
        config: body.config as Prisma.InputJsonValue,
        schedule: body.schedule === undefined ? (current.schedule ?? Prisma.DbNull) : body.schedule ? body.schedule : Prisma.DbNull,
        starredBy,
      },
      { label: '报表' },
    )
    return viewOf(row, context.userId)
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, REPORTS_CUSTOM_WRITE)
    const result = await this.prisma.customReport.deleteMany({ where: { id, tenantId: context.tenantId, ownerId: context.userId } })
    if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '报表不存在')
    return { id }
  }

  async run(req: RequestWithContext, id: string, rawQuery: Record<string, string>, raw: unknown, options: { forceExport?: boolean } = {}) {
    const context = await this.context.authorize(req, REPORTS_READ)
    const report = await this.prisma.customReport.findFirst({ where: { id, tenantId: context.tenantId, OR: [{ ownerId: context.userId }, { shared: true }] } })
    if (!report) throw appError('RESOURCE_NOT_FOUND', '报表不存在')
    const extra = ReportRunSchema.parse(raw ?? {})
    const config = report.config as { dimension: string; metrics: string[]; from?: string; to?: string; q?: string }
    const first = await this.query.query(req, report.source, rawQuery, { ...config, cursor: extra.cursor, pageSize: extra.pageSize })
    // 翻页浏览（带游标）只返回这一页；定时生成则不管多大都进导出中心。
    if (!options.forceExport && (extra.cursor || !first.pageInfo.hasMore)) return { mode: 'INLINE' as const, reportId: report.id, ...first }
    await this.context.authorize(req, 'export.create')
    const rows = [first]
    let cursor = first.pageInfo.nextCursor
    const deadline = Date.now() + REPORT_EXPORT_TIMEOUT_MS
    let truncated = first.truncated
    while (cursor && rows.reduce((sum, page) => sum + page.rows.length, 0) < REPORT_EXPORT_ROW_MAX && Date.now() < deadline) {
      const page = await this.query.query(req, report.source, rawQuery, { ...config, cursor, pageSize: REPORT_PAGE_SIZE })
      rows.push(page)
      truncated = truncated || page.truncated || (!page.pageInfo.nextCursor && page.pageInfo.hasMore)
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null
      if (!page.pageInfo.hasMore) break
    }
    if (cursor) truncated = true
    const flat = rows.flatMap(page => page.rows).slice(0, REPORT_EXPORT_ROW_MAX)
    const jobId = await this.enqueue(req, context.tenantId, context.userId, rawQuery, report.name, flat, truncated)
    return { mode: 'EXPORT' as const, reportId: report.id, exportJobId: jobId, rowCount: flat.length, truncated }
  }

  private starred(current: string[], userId: string, starred: boolean | undefined) {
    if (starred === true) return current.includes(userId) ? current : [...current, userId]
    if (starred === false) return current.filter(id => id !== userId)
    return current
  }

  private async assertConfig(tenantId: string, sourceCode: string, config: { dimension: string; metrics: string[]; from?: string; to?: string }) {
    const source = sourceByCode(sourceCode)
    if (!source) throw appError('VALIDATION_FAILED', '没有这个数据源', { fieldErrors: { source: ['没有这个数据源'] } })
    if (!source.dimensions.some(item => item.code === config.dimension)) throw appError('VALIDATION_FAILED', '维度不适用于这个数据源', { fieldErrors: { dimension: ['维度不适用于这个数据源'] } })
    if (rangeTooLong(config.from, config.to)) throw appError('VALIDATION_FAILED', '日期范围最长 366 天，且开始不能晚于结束', { fieldErrors: { to: ['日期范围最长 366 天，且开始不能晚于结束'] } })
    const own = new Set(source.columns.map(column => column.key))
    const extra = config.metrics.filter(key => !own.has(key))
    if (extra.length) {
      const found = new Set((await this.prisma.customMetric.findMany({ where: { tenantId, key: { in: extra } }, select: { key: true } })).map(row => row.key))
      const unknown = extra.filter(key => !found.has(key))
      if (unknown.length) throw appError('VALIDATION_FAILED', '有指标不在这个数据源或自定义指标里', { fieldErrors: { metrics: unknown } })
    }
  }

  private assertSchedule(schedule: { frequency: 'DAILY' | 'WEEKLY'; weekday?: number } | null | undefined) {
    if (schedule?.frequency === 'WEEKLY' && schedule.weekday === undefined) throw appError('VALIDATION_FAILED', '每周定时要选择星期', { fieldErrors: { schedule: ['每周定时要选择星期'] } })
  }

  private async enqueue(req: RequestWithContext, tenantId: string, userId: string, rawQuery: Record<string, string>, name: string, rows: ReportQueryResult['rows'], truncated: boolean) {
    const active = await this.prisma.exportJob.count({ where: { tenantId, requestedBy: userId, status: { in: ['QUEUED', 'RUNNING'] } } })
    if (active >= EXPORT_MAX_ACTIVE_PER_USER) throw appError('QUOTA_EXCEEDED', `你已有 ${active} 个导出任务在排队或生成中，请等其中一个完成后再发起`)
    const scope = await this.scopes.resolve(await this.context.authorize(req, 'export.create'), rawQuery)
    const job = await this.prisma.exportJob.create({
      data: {
        tenantId,
        kind: 'custom-report',
        sourcePage: '/app/reports/custom',
        filterSummary: truncated ? `${name}（已截断）` : name,
        filterJson: { rows: rows.map(row => ({ id: row.id, label: row.label, valuesJson: JSON.stringify(row.values) })) },
        format: 'CSV',
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        requestedBy: userId,
        fieldPolicySnapshot: { columns: ['id', 'label', 'valuesJson'], scope: { unrestricted: scope.unrestricted, storeIds: scope.sellerAccountIds } },
      },
    })
    try {
      await this.queue.add('exports', { tenantId, exportJobId: job.id }, `export:${job.id}`)
    } catch {
      await this.prisma.exportJob.updateMany({ where: { id: job.id, tenantId }, data: { status: 'FAILED', errorCode: 'EXPORT_QUEUE_UNAVAILABLE', finishedAt: new Date() } })
      throw appError('DEPENDENCY_UNAVAILABLE', '导出队列暂时不可用，请稍后重试')
    }
    return job.id
  }
}

const REPORT_PAGE_SIZE = 200
