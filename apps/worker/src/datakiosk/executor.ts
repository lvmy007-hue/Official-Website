import { NonRetryableError, RetryableError } from '@nova/workflow'
import type { DataKiosk } from '../connectors/datakiosk'
import { DATA_KIOSK_RETENTION_DAYS } from '../connectors/datakiosk'
import { UpstreamHttpError } from '../connectors/http-error'
import { importRows } from '../streaming/batch'
import { drain } from '../streaming/download'
import type { RawFileOpener } from '../streaming/raw-files'
import { decodeUtf8, jsonRows } from '../streaming/rows'
import type { ImportContext } from '../types'
import { dataKioskDatasetFor, type KioskScope } from './registry'

// 数据中心查询执行器（importers.md S3：数据中心查询）。
// 一个同步任务对应一个数据集的一次查询；查询在亚马逊侧排队运行可能很久，所以拆成多次短调用：
//   第 1 次：提交查询并把查询编号记进任务断点 → 返回“进行中”，监听器 30 秒后再次调用；
//   之后每次：查询状态 → 仍在运行则继续等；完成则流式取结果（逐行 JSON，每 1000 行一个事务入库，原始文件同时进对象存储）；
//   结果有下一页时，把分页令牌记进断点，再提交下一页的查询。全部页完成后清掉断点并返回汇总。
// 失败：查询失败（FATAL）读取错误文档并以不可重试错误结束（同样的查询重试不会成功）；被取消、超过 6 小时未完成按可重试处理（重新提交）。

/** 单个查询最长等待时间：超过后放弃并重新提交。 */
export const KIOSK_MAX_WAIT_MS = 6 * 3_600_000
const ERROR_DOCUMENT_CHARS = 2000

export type KioskCheckpoint = {
  /** 当前页已提交的查询编号；没有说明下一次调用要提交。 */
  queryId?: string
  /** 下一页的分页令牌（只有第 2 页起才有）。 */
  paginationToken?: string
  page: number
  imported: number
  read: number
  /** 当前查询的提交时间，用来判断是否等待过久。 */
  submittedAt?: string
}

export type KioskCheckpointStore = { read(): KioskCheckpoint | null; write(value: KioskCheckpoint | null): Promise<void> }
export type KioskTask = { dataset: string; params: Record<string, string>; syncJobId: string }

export type KioskResult = { pending: true; page: number } | { done: true; imported: number; read: number; pages: number; retentionDays: number; retentionExpiresAt: string; retentionWarning: string }

type KioskApi = Pick<DataKiosk, 'createQuery' | 'getQuery' | 'openDocument'>

async function readText(stream: AsyncIterable<Buffer | string>, limit: number): Promise<string> {
  let out = ''
  for await (const chunk of decodeUtf8(stream)) {
    out += chunk
    if (out.length >= limit) return out.slice(0, limit)
  }
  return out
}

export function retentionNotice(days: number = DATA_KIOSK_RETENTION_DAYS) {
  return `数据中心的查询结果在亚马逊侧只保留 ${days} 天：已入库的数据不受影响，但过期后同一次查询的结果无法重新下载，需要重新发起查询。`
}

export async function runDataKioskQuery(
  deps: ImportContext & { openRawFile?: RawFileOpener },
  kiosk: KioskApi,
  scope: KioskScope,
  task: KioskTask,
  checkpoint: KioskCheckpointStore,
  now: () => Date = () => new Date(),
): Promise<KioskResult> {
  const dataset = dataKioskDatasetFor(task.dataset)
  if (!dataset) throw new NonRetryableError('DATA_KIOSK_DATASET_NOT_REGISTERED', `数据中心数据集 ${task.dataset} 没有注册导入器`)
  let state: KioskCheckpoint = checkpoint.read() ?? { page: 1, imported: 0, read: 0 }

  if (!state.queryId) {
    const query = dataset.buildQuery(task.params)
    const queryId = await kiosk.createQuery(query, state.paginationToken).catch(error => {
      // 缺少所需角色（403）：数据集声明了专属失败码就用它（不可重试，授权没变重试没有意义）
      if (dataset.roleMissing && error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403)
        throw new NonRetryableError(dataset.roleMissing.code, dataset.roleMissing.message)
      throw error
    })
    state = { ...state, queryId, submittedAt: now().toISOString() }
    await checkpoint.write(state)
    return { pending: true, page: state.page }
  }

  const status = await kiosk.getQuery(state.queryId)
  if (status.processingStatus === 'IN_QUEUE' || status.processingStatus === 'IN_PROGRESS') {
    if (state.submittedAt && now().getTime() - new Date(state.submittedAt).getTime() > KIOSK_MAX_WAIT_MS) {
      await checkpoint.write({ ...state, queryId: undefined, submittedAt: undefined })
      throw new RetryableError('DATA_KIOSK_QUERY_TIMEOUT', `数据中心查询超过 ${KIOSK_MAX_WAIT_MS / 3_600_000} 小时仍未完成，已放弃并将重新提交`)
    }
    return { pending: true, page: state.page }
  }
  if (status.processingStatus === 'CANCELLED') {
    await checkpoint.write({ ...state, queryId: undefined, submittedAt: undefined })
    throw new RetryableError('DATA_KIOSK_QUERY_CANCELLED', '数据中心查询在开始前被取消，将重新提交')
  }
  if (status.processingStatus === 'FATAL') {
    let detail = ''
    if (status.errorDocumentId) detail = await readText(await kiosk.openDocument(status.errorDocumentId), ERROR_DOCUMENT_CHARS).catch(() => '')
    await checkpoint.write(null)
    throw new NonRetryableError('DATA_KIOSK_QUERY_FATAL', `数据中心查询失败：${detail || '亚马逊没有返回错误详情'}`)
  }
  if (status.processingStatus !== 'DONE') throw new NonRetryableError('DATA_KIOSK_STATUS_UNKNOWN', `数据中心返回了未知的查询状态：${status.processingStatus}`)

  // DONE：没有 dataDocumentId 表示该页没有数据（时间范围内确实无数据），不是错误
  let pageImported = 0
  let pageRead = 0
  if (status.dataDocumentId) {
    const raw = deps.openRawFile?.({ tenantId: scope.tenantId, domain: 'datakiosk', name: `${dataset.id}-${state.queryId}.raw` })
    try {
      const stream = await kiosk.openDocument(status.dataDocumentId, { sink: raw?.sink })
      const result = await importRows(deps, jsonRows(decodeUtf8(stream)), (inner, row) => dataset.handle(inner, row, scope, task.params), {
        skippedMessage: 'data kiosk rows skipped: missing key fields',
        logFields: { dataset: dataset.id, ...scope },
      })
      await drain(stream)
      if (result.read > 0 && result.imported === 0) throw new NonRetryableError('DATA_KIOSK_ROWS_NOT_IMPORTED', '数据中心返回了数据，但没有一行被导入：字段与导入器预期不符')
      await raw?.complete({
        storeKey: scope.sellerAccountId,
        sellerAccountId: scope.sellerAccountId,
        sourceKey: `datakiosk:${task.syncJobId}:${state.page}`,
        reportType: dataset.reportType,
        reportId: state.queryId,
        rowCount: result.read,
        periodStart: task.params.startDate ? new Date(task.params.startDate) : null,
        periodEnd: task.params.endDate ? new Date(task.params.endDate) : null,
      })
      pageImported = result.imported
      pageRead = result.read
    } catch (error) {
      await raw?.discard()
      throw error
    }
  }
  const total = { imported: state.imported + pageImported, read: state.read + pageRead }
  if (status.nextToken) {
    await checkpoint.write({ page: state.page + 1, paginationToken: status.nextToken, ...total })
    return { pending: true, page: state.page + 1 }
  }
  await checkpoint.write(null)
  return {
    done: true,
    ...total,
    pages: state.page,
    retentionDays: DATA_KIOSK_RETENTION_DAYS,
    retentionExpiresAt: new Date(now().getTime() + DATA_KIOSK_RETENTION_DAYS * 86_400_000).toISOString(),
    retentionWarning: retentionNotice(),
  }
}
