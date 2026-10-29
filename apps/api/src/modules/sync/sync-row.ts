import type { Prisma } from '@prisma/client'
import {
  SYNC_JOB_TYPE_LABEL,
  SYNC_MAX_ATTEMPTS,
  SYNC_DOMAIN_LABEL,
  SYNC_TIMELINE_LABEL,
  isWriteSyncType,
  reportTypesOfDomain,
  syncDataDomainOf,
  syncEventText,
  syncEventsOf,
  syncFailureText,
  syncJobTypeLabel,
  syncPriorityLabel,
  syncRetryBlockReason,
  syncStateOf,
  type SyncDataDomain,
  type SyncJobRow,
  type SyncState,
} from '@nova/api-contracts'

// 同步任务行的读取与翻译（P5-06）：列表与详情共用，任务类型 → 数据域、状态机状态、失败原因、日志摘要都在这里算。

/** 列表与详情都要读的列；不含 context 里的内部编号以外的东西，也不含断点内容。 */
export const SYNC_ROW_SELECT = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  priority: true,
  progressCurrent: true,
  progressTotal: true,
  requestId: true,
  failureCode: true,
  deadLettered: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  context: true,
  timelineJson: true,
  connection: { select: { provider: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.SyncJobSelect
export type SyncRowRecord = Prisma.SyncJobGetPayload<{ select: typeof SYNC_ROW_SELECT }>

const REPORT_TYPES = ['FBA_REPORT_CREATE', 'FBA_REPORT_POLL']
const ACCOUNT_HEALTH_REPORT = 'GET_V2_SELLER_PERFORMANCE_REPORT'
const BRAND_PREFIX = 'GET_BRAND_ANALYTICS'
const reportTypeIs = (value: { equals: string } | { string_starts_with: string }): Prisma.SyncJobWhereInput => ({ context: { path: ['reportType'], ...value } })

/** 数据域筛选条件：普通类型按类型列表，报告任务按上下文里的报告类型再分。数据库里认不出的类型归“连接与系统任务”。 */
export function domainWhere(domain: SyncDataDomain): Prisma.SyncJobWhereInput {
  const known = Object.keys(SYNC_JOB_TYPE_LABEL).filter(type => !REPORT_TYPES.includes(type))
  const own = known.filter(type => syncDataDomainOf(type) === domain)
  const or: Prisma.SyncJobWhereInput[] = own.length > 0 ? [{ type: { in: own } }] : []
  const reports: Prisma.SyncJobWhereInput = { type: { in: REPORT_TYPES } }
  const finance = reportTypesOfDomain('FINANCE')
  if (domain === 'ACCOUNT_HEALTH') or.push({ AND: [reports, reportTypeIs({ equals: ACCOUNT_HEALTH_REPORT })] })
  if (domain === 'BRAND') or.push({ AND: [reports, reportTypeIs({ string_starts_with: BRAND_PREFIX })] })
  if (domain === 'FINANCE' && finance.length > 0) or.push({ AND: [reports, { OR: finance.map(type => reportTypeIs({ equals: type })) }] })
  if (domain === 'REPORTS') {
    or.push({ AND: [reports, { NOT: [reportTypeIs({ equals: ACCOUNT_HEALTH_REPORT }), reportTypeIs({ string_starts_with: BRAND_PREFIX }), ...finance.map(type => reportTypeIs({ equals: type }))] }] })
  }
  if (domain === 'SYSTEM') {
    const nonSystem = Object.keys(SYNC_JOB_TYPE_LABEL).filter(type => syncDataDomainOf(type) !== 'SYSTEM')
    or.push({ type: { notIn: nonSystem } })
  }
  if (or.length === 0) return { id: { in: [] } } // 没有同步器的数据域（营销数据流）：没有任何任务
  return or.length === 1 ? or[0]! : { OR: or }
}

/** 页面状态筛选条件（与 syncStateOf 一一对应）。 */
export function stateWhere(state: SyncState): Prisma.SyncJobWhereInput {
  switch (state) {
    case 'RUNNING':
      return { status: 'RUNNING' }
    case 'SUCCEEDED':
      return { status: 'SUCCEEDED' }
    case 'QUEUED':
      return { status: 'PENDING', attempts: 0, failureCode: null }
    case 'RETRY_WAIT':
      return { status: 'PENDING', failureCode: { not: null } }
    case 'POLL_WAIT':
      return { status: 'PENDING', attempts: { gt: 0 }, failureCode: null }
    default:
      return { status: { notIn: ['PENDING', 'RUNNING', 'SUCCEEDED'] } }
  }
}

/** 搜索词：匹配请求编号、任务编号、任务类型编号与类型中文名。 */
export function searchWhere(q: string): Prisma.SyncJobWhereInput {
  const labelled = Object.entries(SYNC_JOB_TYPE_LABEL)
    .filter(([, label]) => label.includes(q))
    .map(([type]) => type)
  return { OR: [{ requestId: { contains: q, mode: 'insensitive' } }, { id: q }, { type: { contains: q, mode: 'insensitive' } }, ...(labelled.length > 0 ? [{ type: { in: labelled } }] : [])] }
}

const apiLabelOf = (provider: string | undefined) => (provider === 'AMAZON_ADS_API' ? 'Amazon Ads API' : provider === 'AMAZON_SP_API' ? 'Amazon SP-API' : null)

/** 日志摘要：最近一条过程事件（旧任务没有记录时为 null）。 */
function logSummaryOf(timelineJson: unknown): string | null {
  const last = syncEventsOf(timelineJson).at(-1)
  if (!last) return null
  const text = syncEventText(last.stage, last.text)
  return text ? `${SYNC_TIMELINE_LABEL[last.stage]}：${text}` : SYNC_TIMELINE_LABEL[last.stage]
}

export function syncRowOf(job: SyncRowRecord): SyncJobRow {
  const domain = syncDataDomainOf(job.type, job.context)
  const blocked = syncRetryBlockReason(job)
  return {
    id: job.id,
    type: job.type,
    typeLabel: syncJobTypeLabel(job.type),
    domain,
    domainLabel: SYNC_DOMAIN_LABEL[domain],
    apiLabel: apiLabelOf(job.connection?.provider),
    storeName: job.connection?.sellerAccount?.displayName ?? null,
    state: syncStateOf(job),
    status: job.status,
    attempts: job.attempts,
    maxAttempts: SYNC_MAX_ATTEMPTS,
    priority: job.priority,
    priorityLabel: syncPriorityLabel(job.priority),
    progressCurrent: job.progressCurrent,
    progressTotal: job.progressTotal,
    requestId: job.requestId,
    failureCode: job.failureCode,
    failureText: syncFailureText(job.failureCode),
    logSummary: logSummaryOf(job.timelineJson),
    deadLettered: job.deadLettered,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    canRetry: blocked === null,
    retryBlockedReason: blocked,
    writeType: isWriteSyncType(job.type),
  }
}
