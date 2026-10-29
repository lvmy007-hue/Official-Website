import { QUOTA_KEYS, QUOTA_LABELS, type QuotaKey } from '@nova/api-contracts'
import { parseOnboardingState } from './onboarding-state'

// 配额占用（P1-19）：配额由平台按报价设置，这里计算实际占用。没有设置某项配额即“不限”。超出只提示，不阻断（12.7）。
export interface QuotaUsageClient {
  sellerAccount: { count(args: { where: { tenantId: string } }): Promise<number> }
  membership: { count(args: { where: { tenantId: string; status: string } }): Promise<number> }
  tenantOnboarding: { findUnique(args: { where: { tenantId: string } }): Promise<{ stepStateJson: unknown } | null> }
  tenantQuota: { findMany(args: { where: { tenantId: string } }): Promise<Array<{ quotaKey: string; limitValue: number }>> }
}

export interface QuotaStatus {
  key: QuotaKey
  label: string
  /** 平台设定的上限；null 表示不限 */
  limit: number | null
  used: number
  exceeded: boolean
}

export async function quotaUsage(client: QuotaUsageClient, tenantId: string): Promise<QuotaStatus[]> {
  const [stores, members, onboarding, quotas] = await Promise.all([
    client.sellerAccount.count({ where: { tenantId } }),
    client.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
    client.tenantOnboarding.findUnique({ where: { tenantId } }),
    client.tenantQuota.findMany({ where: { tenantId } }),
  ])
  const syncScope = parseOnboardingState(onboarding?.stepStateJson).steps.SYNC_SCOPE.data as { backfillDays?: number } | undefined
  const used: Record<QuotaKey, number> = { stores, members, backfillDays: syncScope?.backfillDays ?? 0 }
  const limits = new Map(quotas.map(row => [row.quotaKey, row.limitValue]))
  return QUOTA_KEYS.map(key => {
    const limit = limits.get(key) ?? null
    return { key, label: QUOTA_LABELS[key], limit, used: used[key], exceeded: limit !== null && used[key] > limit }
  })
}
