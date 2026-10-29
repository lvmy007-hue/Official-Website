import { METRIC_KIND_LABEL, METRIC_STATUS_LABEL, isMetricKind, type MetricKind, type MetricStatus, type MetricVersionView } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { dateText } from '../overview'

// 口径版本各服务共用的小工具（P6-31）：版本行的选择列与转换、存放在配置里的审批信息。
// MetricVersion 表没有“原因、摘要、驳回”这些列，随配置存在 `_meta` 里（读取配置的函数只认自己的键，忽略它）：
//  - reason 提交原因；summary 一句话说明改了什么；decision/comment/decidedAt 审批结果。
// 状态只有四种：驳回与撤回的版本记为 RETIRED，由 `_meta.decision` 区分于“被新版本替换”。

export const VERSION_SELECT = {
  id: true,
  kind: true,
  versionNo: true,
  config: true,
  status: true,
  effectiveFrom: true,
  approvedBy: true,
  createdBy: true,
  version: true,
  createdAt: true,
} satisfies Prisma.MetricVersionSelect
export type VersionRecord = Prisma.MetricVersionGetPayload<{ select: typeof VERSION_SELECT }>

export type Db = Prisma.TransactionClient | PrismaService

export interface VersionMeta {
  reason: string | null
  summary: string
  decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | null
  comment: string | null
  decidedAt: string | null
}

const metaOf = (config: unknown): VersionMeta => {
  const raw = typeof config === 'object' && config !== null ? (config as { _meta?: unknown })._meta : undefined
  const meta = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' ? value : null)
  const decision = meta.decision === 'APPROVED' || meta.decision === 'REJECTED' || meta.decision === 'WITHDRAWN' ? meta.decision : null
  return { reason: text(meta.reason), summary: text(meta.summary) ?? '', decision, comment: text(meta.comment), decidedAt: text(meta.decidedAt) }
}

/** 版本配置：干净的配置加上审批信息（写入时用）。 */
export const withMeta = (config: object, meta: Partial<VersionMeta>): Prisma.InputJsonValue => ({ ...config, _meta: { ...meta } }) as Prisma.InputJsonValue

/** 去掉审批信息后的纯配置（读取与比较时用）。 */
export function cleanConfig(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config
  const { _meta: _ignored, ...rest } = config as Record<string, unknown>
  return rest
}

export const isWithdrawn = (row: VersionRecord): boolean => row.status === 'RETIRED' && metaOf(row.config).decision === 'WITHDRAWN'

export function viewOf(row: VersionRecord, names: ReadonlyMap<string, string>, userId: string): MetricVersionView {
  const meta = metaOf(row.config)
  const kind: MetricKind = isMetricKind(row.kind) ? row.kind : 'PROFIT_FORMULA'
  const status = row.status as MetricStatus
  return {
    id: row.id,
    kind,
    kindLabel: METRIC_KIND_LABEL[kind],
    versionNo: row.versionNo,
    status,
    statusLabel: row.status === 'RETIRED' && meta.decision === 'WITHDRAWN' ? '已撤回' : row.status === 'RETIRED' && meta.decision === 'REJECTED' ? '已驳回' : METRIC_STATUS_LABEL[status],
    effectiveFrom: row.effectiveFrom ? dateText(row.effectiveFrom) : null,
    summary: meta.summary,
    reason: meta.reason,
    createdBy: row.createdBy,
    createdByName: row.createdBy ? nameOrFormer(names, row.createdBy) : null,
    createdAt: row.createdAt.toISOString(),
    approvedBy: row.approvedBy,
    approvedByName: row.approvedBy ? nameOrFormer(names, row.approvedBy) : null,
    version: row.version,
    withdrawn: isWithdrawn(row),
    mine: row.createdBy === userId,
    // 字典与分摊规则的配置很大，列表里不带；它们在各自页面里查看
    config: kind === 'PROFIT_FORMULA' || kind === 'BUSINESS_RULES' ? cleanConfig(row.config) : null,
  }
}

export const nameKeysOf = (rows: readonly VersionRecord[]): Array<string | null | undefined> => rows.flatMap(row => [row.createdBy, row.approvedBy])
