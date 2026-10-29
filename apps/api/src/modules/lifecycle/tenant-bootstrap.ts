import type { Prisma } from '@prisma/client'
import { DEFAULT_QUOTAS, QUOTA_KEYS } from '@nova/api-contracts'
import { initialOnboardingState } from './onboarding-state'

// 新建企业的统一起点（P1-19）：数据口径时区为美国太平洋时区、显示币种为美元、企业本地时区另设；
// 同时建好默认配额与初始化向导记录。平台开通与官网支付激活两条路径都应经过这里，避免默认值各写一份。
export async function createTenantWithDefaults(tx: Prisma.TransactionClient, input: { name: string; slug: string; status?: 'TRIAL' | 'ACTIVE'; localTimezone?: string }) {
  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug: input.slug,
      mode: 'LIVE',
      timezone: 'America/Los_Angeles',
      localTimezone: input.localTimezone ?? 'Asia/Shanghai',
      defaultCurrency: 'USD',
      lifecycleStatus: input.status ?? 'ACTIVE',
    },
  })
  await tx.tenantQuota.createMany({ data: QUOTA_KEYS.map(quotaKey => ({ tenantId: tenant.id, quotaKey, limitValue: DEFAULT_QUOTAS[quotaKey] })) })
  await tx.tenantOnboarding.create({ data: { tenantId: tenant.id, step: 'PROFILE', stepStateJson: initialOnboardingState() as unknown as Prisma.InputJsonValue } })
  return tenant
}
