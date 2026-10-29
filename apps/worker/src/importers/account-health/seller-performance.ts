import {
  ACCOUNT_RATING_METRIC_KEY,
  ACCOUNT_STATUS_METRIC_KEY,
  classifyHealthMetric,
  judgeHealthMetric,
  type AccountStatus,
  type HealthMetricGroup,
  type HealthMetricStatus,
  type HealthTargetCondition,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { importRows, type RowOutcome } from '../../streaming/batch'
import type { ImportContext } from '../../types'
import type { RowsImporter } from '../inventory/registry'
import { parseSellerPerformance, type ParsedIssue } from './seller-performance-parse'

// 卖家表现报告导入（importers.md R-42，P5-02）：整份报告是一个 JSON 对象，一次事务写完——
//   - 账户状态、账户健康评级、各项指标：按（店铺、快照日期、指标键）覆盖写入当天的快照；报告生成时间不早于已有行才覆盖
//     （同一天里推送先写入的状态不会被更早生成的报告盖掉）；报告没有给的指标不写行，页面显示“尚无记录”；
//   - 政策合规问题：按（店铺、问题编号）写入；仍在报告里 → 更新最后出现时间；再次出现的已解决问题 → 重开并回到“待处理”；
//     报告里有问题条目这一节、而这次没出现的未解决问题 → 写解决时间（没有这一节就不据此解决任何问题，避免报告格式变化时把全部问题误标为已解决）；
//     负责人、处理状态、备注、关联案件是人工处理信息，同步不覆盖。

export interface SellerPerformanceScope {
  tenantId: string
  sellerAccountId: string
  marketplaceId: string
}
export interface SellerPerformanceOptions {
  reportJobId?: string | null
  /** 企业数据口径时区的“今天”（UTC 零点的日期）。 */
  snapshotDate: Date
}

type Db = ImportContext['prisma']
const json = (value: unknown) => value as Prisma.InputJsonValue

interface SnapshotInput {
  metricKey: string
  metricGroup: HealthMetricGroup
  accountStatus?: AccountStatus
  status: HealthMetricStatus
  value: number | null
  target: number | null
  targetCondition: HealthTargetCondition | null
  unit: string | null
  windowDays: number | null
  detail: Record<string, unknown>
}

async function writeSnapshot(db: Db, scope: SellerPerformanceScope, options: SellerPerformanceOptions, now: Date, row: SnapshotInput): Promise<boolean> {
  const where = { tenantId_sellerAccountId_snapshotDate_metricKey: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, snapshotDate: options.snapshotDate, metricKey: row.metricKey } }
  const existing = await db.accountHealthSnapshot.findUnique({ where, select: { sourceUpdatedAt: true } })
  if (existing && existing.sourceUpdatedAt.getTime() > now.getTime()) return false
  const data = {
    marketplaceId: scope.marketplaceId,
    metricGroup: row.metricGroup,
    ...(row.accountStatus ? { accountStatus: row.accountStatus } : {}),
    status: row.status,
    value: row.value,
    target: row.target,
    targetCondition: row.targetCondition,
    unit: row.unit,
    windowDays: row.windowDays,
    detailJson: json(row.detail),
    source: 'REPORT',
    sourceReportJobId: options.reportJobId ?? null,
    sourceUpdatedAt: now,
    syncedAt: now,
  }
  await db.accountHealthSnapshot.upsert({
    where,
    create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, snapshotDate: options.snapshotDate, metricKey: row.metricKey, ...data },
    update: data,
  })
  return true
}

async function writeIssue(db: Db, scope: SellerPerformanceScope, options: SellerPerformanceOptions, now: Date, issue: ParsedIssue): Promise<void> {
  const where = { tenantId_sellerAccountId_issueId: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, issueId: issue.issueId } }
  const fields = {
    kind: issue.kind,
    title: issue.title,
    affectedAsinsJson: json(issue.asins),
    impactText: issue.impactText,
    detailJson: json(issue.detail),
    lastSeenAt: now,
    sourceReportJobId: options.reportJobId ?? null,
    sourceUpdatedAt: now,
    syncedAt: now,
  }
  const before = await db.policyIssue.findUnique({ where, select: { id: true, status: true } })
  if (!before) {
    await db.policyIssue.create({
      data: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: scope.marketplaceId, issueId: issue.issueId, firstSeenAt: issue.firstSeenAt ?? now, ...fields },
    })
  } else if (before.status === 'RESOLVED') {
    await db.policyIssue.update({ where, data: { ...fields, status: 'OPEN', resolvedAt: null, firstSeenAt: now, handlingStatus: 'OPEN', version: { increment: 1 } } })
  } else {
    await db.policyIssue.update({ where, data: fields })
  }
}

/** 卖家表现报告的导入器（一份报告 = 一行 JSON）。 */
export function sellerPerformanceImporter(scope: SellerPerformanceScope, options: SellerPerformanceOptions): RowsImporter {
  return (ctx, rows) =>
    importRows(
      ctx,
      rows,
      async ({ prisma }, row): Promise<RowOutcome> => {
        const report = parseSellerPerformance(row, scope.marketplaceId)
        const now = new Date()
        let written = 0
        if (report.status?.status) {
          const detail = { rawStatus: report.status.raw }
          const ok = await writeSnapshot(prisma, scope, options, now, {
            metricKey: ACCOUNT_STATUS_METRIC_KEY,
            metricGroup: 'STATUS',
            accountStatus: report.status.status,
            status: 'UNKNOWN',
            value: null,
            target: null,
            targetCondition: null,
            unit: null,
            windowDays: null,
            detail,
          })
          if (ok) written += 1
        }
        if (report.rating && (report.rating.score !== null || report.rating.status)) {
          const ok = await writeSnapshot(prisma, scope, options, now, {
            metricKey: ACCOUNT_RATING_METRIC_KEY,
            metricGroup: 'RATING',
            status: 'UNKNOWN',
            value: report.rating.score,
            target: null,
            targetCondition: null,
            unit: null,
            windowDays: null,
            detail: { ratingStatus: report.rating.status },
          })
          if (ok) written += 1
        }
        for (const metric of report.metrics) {
          const ok = await writeSnapshot(prisma, scope, options, now, {
            metricKey: metric.metricKey,
            metricGroup: classifyHealthMetric(metric.metricKey),
            status: judgeHealthMetric(metric.value, metric.target, metric.targetCondition),
            value: metric.value,
            target: metric.target,
            targetCondition: metric.targetCondition,
            unit: metric.unit,
            windowDays: metric.windowDays,
            detail: metric.detail,
          })
          if (ok) written += 1
        }
        for (const issue of report.issues) {
          await writeIssue(prisma, scope, options, now, issue)
          written += 1
        }
        if (report.hasIssueSection) {
          await prisma.policyIssue.updateMany({
            where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, status: 'OPEN', lastSeenAt: { lt: now } },
            data: { status: 'RESOLVED', resolvedAt: now, version: { increment: 1 } },
          })
        }
        return written > 0 ? 'imported' : 'skipped'
      },
      { skippedMessage: 'seller performance report had nothing recognizable to write', logFields: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId } },
    )
}
