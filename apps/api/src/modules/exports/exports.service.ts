import { Injectable } from '@nestjs/common'
import {
  EXPORT_ERROR_LABEL,
  EXPORT_LINK_TTL_SECONDS,
  EXPORT_MAX_ACTIVE_PER_USER,
  EXPORT_STATUS_LABEL,
  RETENTION_SETTING_KEY,
  ExportCreateBodySchema,
  ExportListQuerySchema,
  exportKindOf,
  isPdfExportKind,
  retentionPolicyOf,
  type ExportPolicySnapshot,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import type { ExportJob, Prisma } from '@prisma/client'
import { appError, ApiContext, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { QueueService } from '../../platform/queue.service'
import { ObjectStorageService } from '../../platform/storage/object-storage.service'
import { AuditWriter, StepUpService } from '../../platform/write'
import { ContextService } from '../auth'

const SORT = { field: 'createdAt', dir: 'desc' } as const
const ACTIVE = ['QUEUED', 'RUNNING']

// 导出中心（P1-28-6，09 章 9.4）：
// - 范围继承发起页面：数据范围按发起人当时的授权解析并保存，worker 生成时再与发起人“当前”的权限取交集；
// - 敏感列（成本、利润、买家）按字段权限过滤，没有权限的列根本不出现；选了敏感列还要再次验证身份；
// - 文件由后台任务流式生成并写入对象存储，下载只发短时签名链接；发起与下载都写审计。
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
    private readonly queue: QueueService,
    private readonly objects: ObjectStorageService,
    private readonly audit: AuditWriter,
    private readonly stepUp: StepUpService,
  ) {}

  /** 状态以“当前时间”为准：文件到期后即使清理任务还没跑，也按已过期显示 */
  private view(row: ExportJob, now = new Date()) {
    const expired = row.status === 'EXPIRED' || (row.status === 'DONE' && row.expiresAt <= now)
    const status = expired ? 'EXPIRED' : (row.status as keyof typeof EXPORT_STATUS_LABEL)
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: exportKindOf(row.kind)?.label ?? row.kind,
      sourcePage: row.sourcePage,
      filterSummary: row.filterSummary,
      format: row.format,
      status,
      statusLabel: EXPORT_STATUS_LABEL[status] ?? status,
      rowCount: row.rowCount,
      fileSize: row.fileSize,
      errorMessage: row.status === 'FAILED' ? (EXPORT_ERROR_LABEL[row.errorCode ?? ''] ?? EXPORT_ERROR_LABEL.EXPORT_FAILED) : null,
      downloadable: status === 'DONE' && Boolean(row.fileKey),
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      expiresAt: row.expiresAt,
    }
  }

  async create(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'export.create')
    const body = ExportCreateBodySchema.parse(rawBody)
    const spec = exportKindOf(body.kind)
    if (!spec) throw appError('VALIDATION_FAILED', '不支持导出这种数据', { fieldErrors: { kind: ['不支持导出这种数据'] } })
    // 标签 PDF 要先整理任务快照，只能从入仓计划“标签”页签发起，不走通用的表格导出
    if (isPdfExportKind(spec.kind)) throw appError('VALIDATION_FAILED', '这类文件需要在入仓计划的“标签”页签里生成', { fieldErrors: { kind: ['请在入仓计划的“标签”页签里生成'] } })
    this.context.require(context, spec.permission)
    const badFilters = Object.keys(body.filters).filter(key => !spec.filterKeys.includes(key))
    if (badFilters.length > 0) throw appError('VALIDATION_FAILED', `不支持的筛选条件：${badFilters.join('、')}`, { fieldErrors: { filters: [`不支持的筛选条件：${badFilters.join('、')}`] } })
    const dates = (['from', 'to'] as const).map(key => [key, body.filters[key]] as const).filter(([, value]) => value !== undefined)
    for (const [key, value] of dates) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
        throw appError('VALIDATION_FAILED', '日期格式应为 YYYY-MM-DD', { fieldErrors: { [`filters.${key}`]: ['日期格式应为 YYYY-MM-DD'] } })
    }
    if (typeof body.filters.from === 'string' && typeof body.filters.to === 'string' && body.filters.from > body.filters.to)
      throw appError('VALIDATION_FAILED', '开始日期不能晚于结束日期', { fieldErrors: { 'filters.from': ['开始日期不能晚于结束日期'] } })
    for (const key of ['fromAt', 'toAt'] as const) {
      const value = body.filters[key]
      if (value !== undefined && (typeof value !== 'string' || Number.isNaN(Date.parse(value))))
        throw appError('VALIDATION_FAILED', '时间格式应为 ISO 时间', { fieldErrors: { [`filters.${key}`]: ['时间格式应为 ISO 时间'] } })
    }
    const storeIds = body.filters.storeIds
    // 不按店铺划分的数据（审计日志）只检查权限，不要求店铺授权；保存的范围记为“不限店铺”，生成文件时也不按店铺过滤
    const scope =
      spec.storeScoped === false
        ? { unrestricted: true, sellerAccountIds: [] as string[] }
        : (await this.context.authorizeScoped(req, spec.permission, { storeIds: Array.isArray(storeIds) ? storeIds.join(',') : storeIds })).scope
    // 列：目录顺序；没有字段权限的敏感列即使被选中也直接去掉
    const unknown = (body.columns ?? []).filter(key => !spec.columns.some(column => column.key === key))
    if (unknown.length > 0) throw appError('VALIDATION_FAILED', `不存在的列：${unknown.join('、')}`, { fieldErrors: { columns: [`不存在的列：${unknown.join('、')}`] } })
    const chosen = spec.columns.filter(column => (!body.columns || body.columns.includes(column.key)) && (!column.sensitive || canSeeField(context.permissions, column.sensitive)))
    if (chosen.length === 0) throw appError('VALIDATION_FAILED', '没有可导出的列', { fieldErrors: { columns: ['没有可导出的列（可能是所选列需要你没有的字段权限）'] } })
    if (chosen.some(column => column.sensitive)) req.stepUpId = await this.stepUp.require(context, 'export.sensitive')

    await this.assertCapacity(context)
    const retention = await this.retention(context.tenantId)
    const snapshot: ExportPolicySnapshot = { columns: chosen.map(column => column.key), scope: { unrestricted: scope.unrestricted, storeIds: scope.sellerAccountIds } }
    const job = await this.prisma.$transaction(async tx => {
      const row = await tx.exportJob.create({
        data: {
          tenantId: context.tenantId,
          kind: spec.kind,
          sourcePage: spec.sourcePage,
          filterSummary: body.filterSummary,
          filterJson: body.filters as Prisma.InputJsonValue,
          format: body.format,
          expiresAt: new Date(Date.now() + retention.exportFileDays * 86_400_000),
          requestedBy: context.userId,
          fieldPolicySnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      })
      await this.audit.record(
        req,
        {
          action: 'EXPORT_REQUESTED',
          resourceType: 'ExportJob',
          resourceId: row.id,
          detail: { kind: spec.kind, format: body.format, columns: snapshot.columns, sensitive: chosen.some(column => column.sensitive), filters: body.filters },
        },
        { client: tx },
      )
      return row
    })
    await this.dispatch(context.tenantId, job.id)
    return this.view(job)
  }

  /** 每人同时排队与生成中的任务数上限（表格与文档类共用）。 */
  private async assertCapacity(context: ApiContext) {
    const active = await this.prisma.exportJob.count({ where: { tenantId: context.tenantId, requestedBy: context.userId, status: { in: ACTIVE } } })
    if (active >= EXPORT_MAX_ACTIVE_PER_USER) throw appError('QUOTA_EXCEEDED', `你已有 ${active} 个导出任务在排队或生成中，请等其中一个完成后再发起`)
  }

  /** 导出文件保留天数取企业设置（P5-10），没有设置用默认的 7 天；只影响这次之后创建的任务。 */
  private async retention(tenantId: string) {
    return retentionPolicyOf((await this.prisma.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: RETENTION_SETTING_KEY }, select: { valueJson: true } }))?.valueJson)
  }

  /** 投递到导出队列；队列不可用时任务标为失败并提示稍后重试。 */
  private async dispatch(tenantId: string, jobId: string) {
    try {
      await this.queue.add('exports', { tenantId, exportJobId: jobId }, `export:${jobId}`)
    } catch {
      await this.prisma.exportJob.updateMany({ where: { id: jobId, tenantId }, data: { status: 'FAILED', errorCode: 'EXPORT_QUEUE_UNAVAILABLE', finishedAt: new Date() } })
      throw appError('DEPENDENCY_UNAVAILABLE', '导出队列暂时不可用，请稍后重试')
    }
  }

  /**
   * 文档类导出（标签 PDF，P6-12）：任务内容由调用方（入仓标签服务）整理成快照存进 filterJson，worker 按快照生成；
   * 调用方已经完成业务校验与数据范围核对，这里再要求导出权限与该类型的查看权限，并受同样的并发上限与保留期限制。
   */
  async enqueueDocument(
    req: RequestWithContext,
    context: ApiContext,
    input: {
      kind: string
      filterSummary: string
      payload: Record<string, unknown>
      scope: { unrestricted: boolean; storeIds: string[] }
      audit: { action: string; resourceType: string; resourceId: string; detail: Record<string, unknown> }
    },
  ) {
    const spec = exportKindOf(input.kind)
    if (!spec || !isPdfExportKind(spec.kind)) throw appError('VALIDATION_FAILED', '不支持这种文档')
    this.context.require(context, 'export.create')
    this.context.require(context, spec.permission)
    await this.assertCapacity(context)
    const retention = await this.retention(context.tenantId)
    const snapshot: ExportPolicySnapshot = { columns: ['pdf'], scope: input.scope }
    const job = await this.prisma.$transaction(async tx => {
      const row = await tx.exportJob.create({
        data: {
          tenantId: context.tenantId,
          kind: spec.kind,
          sourcePage: spec.sourcePage,
          filterSummary: input.filterSummary.slice(0, 300),
          filterJson: input.payload as Prisma.InputJsonValue,
          format: 'PDF',
          expiresAt: new Date(Date.now() + retention.exportFileDays * 86_400_000),
          requestedBy: context.userId,
          fieldPolicySnapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      })
      await this.audit.record(req, { ...input.audit, detail: { ...input.audit.detail, exportId: row.id, kind: spec.kind } }, { client: tx })
      return row
    })
    await this.dispatch(context.tenantId, job.id)
    return this.view(job)
  }

  async list(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = ExportListQuerySchema.parse(rawQuery)
    const binding = bindingOf(context.tenantId, { requestedBy: context.userId })
    const rows = await this.prisma.exportJob.findMany({
      where: { AND: [{ tenantId: context.tenantId, requestedBy: context.userId }, this.cursor.after(query.cursor, SORT, binding) as Prisma.ExportJobWhereInput] },
      orderBy: this.cursor.orderBy(SORT),
      take: query.limit + 1,
    })
    const page = this.cursor.page(rows, { pageSize: query.limit, sort: SORT, binding })
    const now = new Date()
    return { items: page.items.map(row => this.view(row, now)), pageInfo: page.pageInfo }
  }

  /** 只有发起人自己能看自己的导出（管理员也不例外：文件里可能有他无权限看的字段） */
  private async mine(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.exportJob.findFirst({ where: { id, tenantId, requestedBy: userId } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '导出任务不存在')
    return row
  }

  async detail(req: RequestWithContext, id: string) {
    const context = await this.context.resolve(req)
    return this.view(await this.mine(context.tenantId, context.userId, id))
  }

  async download(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, 'export.create')
    const row = await this.mine(context.tenantId, context.userId, id)
    const spec = exportKindOf(row.kind)
    if (spec) this.context.require(context, spec.permission)
    const view = this.view(row)
    if (view.status === 'EXPIRED') throw appError('STORAGE_LINK_EXPIRED', '导出文件已过期被清理，请重新发起导出')
    if (!view.downloadable || !row.fileKey) throw appError('DATA_CONDITION_FAILED', `导出${view.statusLabel}，暂时不能下载`)
    const signed = await this.objects.forTenant(context.tenantId).signDownload(row.fileKey, EXPORT_LINK_TTL_SECONDS)
    await this.audit.record(req, { action: 'EXPORT_DOWNLOAD_LINK_ISSUED', resourceType: 'ExportJob', resourceId: row.id, detail: { kind: row.kind, format: row.format, fileSize: row.fileSize } })
    return { url: signed.url, expiresAt: signed.expiresAt, fileSize: row.fileSize }
  }
}
