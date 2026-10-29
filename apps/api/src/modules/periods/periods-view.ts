import {
  PERIOD_DIFF_LIMIT,
  PROFIT_BASES,
  PROFIT_BASIS_LABEL,
  diffSnapshots,
  previewOf,
  type CostSnapshot,
  type FxSnapshot,
  type PeriodDiffReport,
  type PeriodPreview,
  type PeriodSnapshotSummary,
  type PeriodStatus,
  type ProfitSnapshot,
  type SnapshotBundle,
  type SnapshotDiff,
} from '@nova/api-contracts'
import { nameOrFormer } from '../../platform/people'
import type { Db } from './periods-common'
import type { PeriodTarget } from './periods-evidence'
import { loadBundle, loadProfitSnapshot } from './periods-snapshot-load'

// 关账详情页的展示数据（P2b-13）：预览、快照列表、差异报告。锁定后的数字一律读快照，不读实时数据。

export interface SnapshotRow {
  revision: number
  profitSnapshotJson: unknown
  fxSnapshotJson: unknown
  costVersionSnapshotJson: unknown
  diffJson: unknown
  lockedBy: string
  lockedAt: Date
}

/** 快照只由本模块在锁定时写入，且从不修改，所以按类型直接读出。 */
export const bundleOf = (row: SnapshotRow): SnapshotBundle => ({
  profit: row.profitSnapshotJson as ProfitSnapshot,
  fx: row.fxSnapshotJson as FxSnapshot,
  costs: row.costVersionSnapshotJson as CostSnapshot,
})

export function snapshotSummaries(rows: readonly SnapshotRow[], names: ReadonlyMap<string, string>, canProfit: boolean): PeriodSnapshotSummary[] {
  return rows.map(row => {
    const bundle = bundleOf(row)
    return {
      revision: row.revision,
      lockedAt: row.lockedAt.toISOString(),
      lockedBy: nameOrFormer(names, row.lockedBy),
      bases: canProfit
        ? PROFIT_BASES.map(basis => ({
            basis,
            label: PROFIT_BASIS_LABEL[basis],
            rows: bundle.profit.bases[basis].totals.rows,
            revenue: bundle.profit.bases[basis].totals.revenue,
            netProfit: bundle.profit.bases[basis].totals.profit,
          }))
        : null,
      fxRates: bundle.fx.rates.length,
      costVersions: bundle.costs.versions.length,
      hasDiff: row.diffJson !== null && row.diffJson !== undefined,
    }
  })
}

const RESTRICTED: PeriodPreview = {
  state: 'RESTRICTED',
  source: 'LIVE',
  note: '没有利润字段权限（field.profit），不显示关账报表的金额；完整性检查与审批不受影响',
  bases: [],
  fx: null,
  costVersions: null,
}

/** 关账报表预览：已关账读最近一份快照；其余读实时利润日表。 */
export async function previewFor(db: Db, target: PeriodTarget, status: PeriodStatus, latest: SnapshotRow | undefined, access: { canProfit: boolean; canCost: boolean }): Promise<PeriodPreview> {
  if (!access.canProfit) return RESTRICTED
  if (status === 'CLOSED' && latest) {
    const bundle = bundleOf(latest)
    return previewOf(bundle.profit, access.canCost, 'SNAPSHOT', { currencies: bundle.fx.currencies, rates: bundle.fx.rates.length }, bundle.costs.versions.length)
  }
  return previewOf(await loadProfitSnapshot(db, target), access.canCost, 'LIVE', null, null)
}

const withDiffLimit = (diff: SnapshotDiff): SnapshotDiff => ({
  ...diff,
  bases: diff.bases.map(basis => ({ ...basis, skus: basis.skus.slice(0, PERIOD_DIFF_LIMIT) })),
})

/** 差异报告：重新开账期间是“上一份快照 vs 现在的实时数据”；已关账且是第二次及以后的锁定，是锁定时存下来的“与上一份快照的差异”。 */
export async function diffFor(db: Db, target: PeriodTarget, status: PeriodStatus, rows: readonly SnapshotRow[], canProfit: boolean): Promise<PeriodDiffReport | null> {
  const latest = rows[0]
  if (!canProfit || !latest) return null
  if (status === 'REOPENED') {
    const diff = diffSnapshots(bundleOf(latest), await loadBundle(db, target))
    return { ...withDiffLimit(diff), against: 'LIVE', baseRevision: latest.revision, baseLockedAt: latest.lockedAt.toISOString(), compareRevision: null }
  }
  if (status === 'CLOSED' && latest.diffJson) {
    const base = rows.find(row => row.revision === latest.revision - 1)
    return {
      ...withDiffLimit(latest.diffJson as SnapshotDiff),
      against: 'PREVIOUS_REVISION',
      baseRevision: latest.revision - 1,
      baseLockedAt: (base ?? latest).lockedAt.toISOString(),
      compareRevision: latest.revision,
    }
  }
  return null
}
