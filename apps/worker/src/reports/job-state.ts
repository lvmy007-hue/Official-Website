import { AMAZON_PROCESSING_STAGE, REPORT_COLUMNS_MAX, appendReportEvent, columnWarnings, reportEventsOf, type ReportTimelineStage, type ReportWarning } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Row } from '../streaming/rows'

// 报表中心的任务状态（P5-03）：FbaReportJob 上的导入统计、字段变化警告与状态时间线。
// 时间线只存“过程”事件（申请、亚马逊侧处理状态变化、开始下载解析）；已创建、完成、失败、取消由接口按状态与时间列补出，失败路径不需要先读后写。

/** 时间线的读取与追加在契约包里（接口与后台任务共用）；这里只是换成能直接写进 JSON 列的类型。 */
export const eventsOf = reportEventsOf

export const withEvent = (current: unknown, stage: ReportTimelineStage, text?: string, now: Date = new Date()): Prisma.InputJsonValue =>
  appendReportEvent(current, stage, text, now) as unknown as Prisma.InputJsonValue

/** 解析警告写进 JSON 列。 */
export const warningsJson = (warnings: readonly ReportWarning[]): Prisma.InputJsonValue => warnings as unknown as Prisma.InputJsonValue

/** 亚马逊 getReport 的处理状态 → 时间线阶段；认不出的状态（FATAL、CANCELLED 等）由失败路径处理，这里返回 null。 */
export const amazonStageOf = (processingStatus: string): ReportTimelineStage | null => AMAZON_PROCESSING_STAGE[processingStatus.toUpperCase()] ?? null

/** 导入结果之外要写进任务的字段。 */
export interface ImportedOutcome {
  read: number
  imported: number
  skipped?: number
  columns?: string[]
}

/** 导入完成时要写的统计字段（不含状态与时间线）；没有给出 skipped 的导入器写空，不写 0。 */
export function statsData(outcome: ImportedOutcome): Pick<Prisma.FbaReportJobUncheckedUpdateInput, 'readRows' | 'importedRows' | 'skippedRows' | 'columnsJson'> {
  return {
    readRows: outcome.read,
    importedRows: outcome.imported,
    skippedRows: outcome.skipped ?? null,
    columnsJson: (outcome.columns ?? []).slice(0, REPORT_COLUMNS_MAX),
  }
}

/** 与同一店铺、同一类型上一份成功的报告对比字段：新出现与消失的字段。上一份没有留存字段名（旧任务）时不产生警告。 */
export async function importWarnings(
  prisma: PrismaClient,
  job: { id: string; tenantId: string; sellerAccountId: string | null; reportType: string },
  columns: readonly string[],
): Promise<ReportWarning[]> {
  if (columns.length === 0) return []
  const previous = await prisma.fbaReportJob.findMany({
    where: { tenantId: job.tenantId, sellerAccountId: job.sellerAccountId, reportType: job.reportType, status: 'READY', id: { not: job.id } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { columnsJson: true },
  })
  const hit = previous.map(item => item.columnsJson).find((value): value is string[] => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string'))
  return columnWarnings(columns, hit ?? null)
}

/** 包一层迭代器：读到第一行时把它的字段名交给回调（报告文件的字段名就是第一行的键）。 */
export async function* capturingColumns(rows: AsyncIterable<Row>, onColumns: (columns: string[]) => void): AsyncGenerator<Row> {
  let first = true
  for await (const row of rows) {
    if (first) {
      first = false
      onColumns(Object.keys(row).slice(0, REPORT_COLUMNS_MAX))
    }
    yield row
  }
}

/** 失败时写的字段：状态、失败码、中文说明、结束时间。 */
export function failedData(code: string, message?: string, now: Date = new Date()): Prisma.FbaReportJobUncheckedUpdateInput {
  return { status: 'FAILED', failureCode: code.slice(0, 120), ...(message ? { failureMessage: message.slice(0, 500) } : {}), finishedAt: now }
}
