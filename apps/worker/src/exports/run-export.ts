import {
  EXPORT_CONTENT_TYPE,
  ExportPolicySnapshotSchema,
  XLSX_MAX_ROWS,
  exportFileName,
  exportKindOf,
  isPdfExportKind,
  type ExportFormat,
  type ExportKindSpec,
  type ExportPolicySnapshot,
} from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import { NonRetryableError } from '@nova/workflow'
import type { Prisma, PrismaClient, ExportJob } from '@prisma/client'
import { intersectScope, loadActor } from './actor'
import { notificationRows } from '../platform/notify'
import { writeCsv, type Cell } from './csv'
import { EXPORT_MAX_FILE_BYTES, ExportFailure } from './failure'
import { renderLabelExport } from './label-export'
import { METRIC_VERSION_HEADER, METRIC_VERSIONED_KINDS, metricVersionLabel } from './metric-version'
import { EXPORT_SOURCES, type ExportSource } from './sources'
import { XlsxRowLimitError, writeXlsx } from './xlsx-writer'

// 导出任务执行（P1-28-6）：校验发起人此刻的权限与范围 → 流式读取 → 流式写入对象存储（CSV 或 XLSX）→ 回写任务状态、审计与站内通知。
// 文档类导出（PDF，P6-12 的自定义箱标签与商品标签）走同一套前后流程，只是中间一步换成按任务快照排版生成 PDF。
// 失败一律落到任务上（状态 FAILED + 失败码），界面显示中文原因；内部错误细节只进日志与死信，不给用户。

export { EXPORT_MAX_FILE_BYTES, ExportFailure }

export interface ExportDeps {
  /** 租户连接：必须在 runWithTenant 内调用 */
  db: PrismaClient
  storage: ObjectStorage
  now?: () => Date
  /** 标签用的字体文件路径（环境变量 LABEL_FONT_PATH）：标签文字含中文时才需要。 */
  labelFontPath?: string
}

export type ExportOutcome = { status: 'DONE'; rows: number; bytes: number } | { status: 'FAILED'; code: string } | { status: 'SKIPPED' }

interface Written {
  rows: number
  bytes: number
  key: string
  /** 文档类导出成功后随状态一起写入的生成记录。 */
  log?: Prisma.LabelPrintLogUncheckedCreateInput
}

type Actor = NonNullable<Awaited<ReturnType<typeof loadActor>>>

export async function runExport(deps: ExportDeps, tenantId: string, exportJobId: string): Promise<ExportOutcome> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const job = await db.exportJob.findFirst({ where: { id: exportJobId, tenantId } })
  if (!job) throw new NonRetryableError('EXPORT_JOB_MISSING', `导出任务 ${exportJobId} 不存在`)
  // 重复投递（重试、重放）时，已经有结论的任务不再处理
  if (!['QUEUED', 'RUNNING'].includes(job.status)) return { status: 'SKIPPED' }
  await db.exportJob.updateMany({ where: { id: job.id, tenantId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING', startedAt: now } })

  try {
    const spec = exportKindOf(job.kind)
    const document = isPdfExportKind(job.kind)
    const source = EXPORT_SOURCES[job.kind]
    if (!spec || (!document && !source)) throw new ExportFailure('EXPORT_KIND_UNKNOWN', `未知的导出类型 ${job.kind}`)
    const actor = await loadActor(db, tenantId, job.requestedBy)
    if (!actor) throw new ExportFailure('EXPORT_ACTOR_INACTIVE', '发起人已不在企业内')
    if (!hasPermission(actor.permissions, 'export.create') || !hasPermission(actor.permissions, spec.permission)) throw new ExportFailure('EXPORT_PERMISSION_REVOKED', '发起人已没有导出权限')
    const snapshot = ExportPolicySnapshotSchema.parse(job.fieldPolicySnapshot)
    const storeIds = intersectScope(snapshot.scope, actor.storeIds)
    if (spec.storeScoped !== false && storeIds !== null && storeIds.length === 0) throw new ExportFailure('EXPORT_SCOPE_EMPTY', '发起人当前没有可导出的店铺')

    const written = document ? await writeDocument(deps, tenantId, job, storeIds, now) : await writeTable(deps, tenantId, job, spec, source!, actor, snapshot, storeIds, now)
    const unit = document ? '张' : '行'
    // 通知按发起人的个人偏好生成（可能不接收，或在免打扰时段内只留在消息中心）
    const doneRows = await notificationRows(db, tenantId, [job.requestedBy], {
      kind: 'EXPORT_DONE',
      title: `导出已完成：${spec.label}`,
      // 保留天数由企业设置决定（创建任务时已算好到期时间），不能写死 7 天
      body: `共 ${written.rows} ${unit}，文件保留 ${Math.max(1, Math.round((job.expiresAt.getTime() - job.createdAt.getTime()) / 86_400_000))} 天，请及时下载`,
      link: '/app/my/exports',
      severity: 'INFO',
      dedupKey: `export:${job.id}`,
    })
    await db.$transaction([
      db.exportJob.updateMany({ where: { id: job.id, tenantId }, data: { status: 'DONE', rowCount: written.rows, fileKey: written.key, fileSize: written.bytes, finishedAt: now, errorCode: null } }),
      db.notification.createMany({ data: doneRows, skipDuplicates: true }),
      db.auditEvent.create({ data: audit(tenantId, job.id, job.requestedBy, 'EXPORT_COMPLETED', 'SUCCEEDED', { kind: job.kind, format: job.format, rows: written.rows, fileSize: written.bytes }) }),
      ...(written.log
        ? [
            db.labelPrintLog.create({ data: written.log }),
            db.auditEvent.create({
              data: audit(tenantId, job.id, job.requestedBy, 'LABEL_PDF_GENERATED', 'SUCCEEDED', {
                kind: job.kind,
                labelCount: written.log.labelCount,
                planId: written.log.planId,
                shipmentId: written.log.shipmentId ?? null,
              }),
            }),
          ]
        : []),
    ])
    return { status: 'DONE', rows: written.rows, bytes: written.bytes }
  } catch (error) {
    const code = error instanceof ExportFailure ? error.code : 'EXPORT_FAILED'
    const failedRows = await notificationRows(db, tenantId, [job.requestedBy], {
      kind: 'EXPORT_FAILED',
      title: '导出失败',
      body: '导出未能生成，请到导出中心查看原因后重新发起',
      link: '/app/my/exports',
      severity: 'WARNING',
      dedupKey: `export:${job.id}`,
    })
    await db.$transaction([
      db.exportJob.updateMany({ where: { id: job.id, tenantId }, data: { status: 'FAILED', errorCode: code, finishedAt: new Date(), fileKey: null, fileSize: null } }),
      db.notification.createMany({ data: failedRows, skipDuplicates: true }),
      db.auditEvent.create({ data: audit(tenantId, job.id, job.requestedBy, 'EXPORT_FAILED', 'FAILED', { kind: job.kind, errorCode: code }) }),
    ])
    // 已知的业务原因（权限收回、行数超限……）已经如实落到任务上，不再重试；未知错误交给死信保留现场供排查
    if (error instanceof ExportFailure) return { status: 'FAILED', code }
    throw new NonRetryableError(code, error instanceof Error ? error.message : String(error))
  }
}

/** 文档类导出：按任务快照生成 PDF（标签）。 */
async function writeDocument(deps: ExportDeps, tenantId: string, job: ExportJob, storeIds: string[] | null, now: Date): Promise<Written> {
  const store = new TenantObjectStore(deps.storage, tenantId, () => now)
  return renderLabelExport({ db: deps.db, store, tenantId, job, storeIds, now, fontPath: deps.labelFontPath })
}

/** 表格类导出：发起时选定的列 ∩ 发起人此刻有权看的列，流式写成 CSV 或 XLSX。 */
async function writeTable(
  deps: ExportDeps,
  tenantId: string,
  job: ExportJob,
  spec: ExportKindSpec,
  source: ExportSource,
  actor: Actor,
  snapshot: ExportPolicySnapshot,
  storeIds: string[] | null,
  now: Date,
): Promise<Written> {
  // 没有字段权限的列根本不出现
  const columns = spec.columns.filter(column => snapshot.columns.includes(column.key) && (!column.sensitive || canSeeField(actor.permissions, column.sensitive)))
  if (columns.length === 0) throw new ExportFailure('EXPORT_PERMISSION_REVOKED', '发起人已没有所选列的权限')
  const format = job.format as ExportFormat
  const fileName = exportFileName(spec.label, format, now)
  const store = new TenantObjectStore(deps.storage, tenantId, () => now)
  const { key, writer } = store.openWriter(
    { domain: 'exports', name: format === 'XLSX' ? 'export.xlsx' : 'export.csv', date: now },
    { contentType: EXPORT_CONTENT_TYPE[format], contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`, maxBytes: EXPORT_MAX_FILE_BYTES },
  )
  const versioned = METRIC_VERSIONED_KINDS.has(job.kind)
  const versionLabel = versioned ? await metricVersionLabel(deps.db, tenantId) : null
  const rows = (async function* (): AsyncGenerator<Cell[]> {
    for await (const row of source({ db: deps.db, tenantId, filters: (job.filterJson ?? {}) as Record<string, unknown>, storeIds })) {
      const cells: Cell[] = columns.map(column => row[column.key])
      yield versionLabel === null ? cells : [...cells, versionLabel]
    }
  })()
  const header = [...columns.map(column => column.label), ...(versioned ? [METRIC_VERSION_HEADER] : [])]
  try {
    const count = format === 'XLSX' ? await writeXlsx(writer.stream, { sheetName: spec.label, header, rows, maxRows: XLSX_MAX_ROWS - 1, now }) : await writeCsv(writer.stream, header, rows)
    writer.stream.end()
    const stored = await writer.done
    return { rows: count, bytes: stored.sizeBytes, key }
  } catch (error) {
    writer.stream.destroy()
    await writer.abort()
    throw error instanceof XlsxRowLimitError ? new ExportFailure('EXPORT_ROWS_EXCEEDED', error.message) : error
  }
}

function audit(tenantId: string, jobId: string, actorId: string, action: string, result: string, detail: Record<string, unknown>): Prisma.AuditEventUncheckedCreateInput {
  return { tenantId, actorId, action, resourceType: 'ExportJob', resourceId: jobId, requestId: `export-${jobId}`, result, source: 'SYSTEM', detail: detail as Prisma.InputJsonValue }
}
