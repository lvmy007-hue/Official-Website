import { queryOptions } from '@tanstack/react-query'
import type { CloseState, OnboardingStepKey, QuotaKey, TenantLifecycleStatus } from '@nova/api-contracts'
import { platformFetch } from './platform-api'

// 平台运营后台的数据类型与查询（P1-19）。字段与服务端 platform-admin 模块的返回一致。

export type PlatformAdmin = { id: string; email: string; name: string; role: string; permissions: string[] }

export const platformMeQuery = queryOptions({
  queryKey: ['platform', 'me'],
  queryFn: () => platformFetch<PlatformAdmin>('/platform/auth/me'),
  staleTime: 5 * 60_000,
  retry: false,
})

/** 配额占用：limit 为空表示平台未设上限（不限）；超出只提示不阻断 */
export type QuotaStatus = { key: QuotaKey; label: string; limit: number | null; used: number; exceeded: boolean }
export type QuotaUsage = QuotaStatus[]

export type TenantListItem = {
  id: string
  name: string
  slug: string
  status: TenantLifecycleStatus
  statusLabel: string
  statusChangedAt: string | null
  createdAt: string
  stores: number
  members: number
  onboardingCompleted: boolean
}
export type TenantListPage = { items: TenantListItem[]; pageInfo: { nextCursor: string | null; hasMore: boolean } }

export type TenantListParams = { q?: string; status?: TenantLifecycleStatus }

export function tenantListPath(params: TenantListParams, cursor?: string | null) {
  const search = new URLSearchParams({ pageSize: '20' })
  if (params.q) search.set('q', params.q)
  if (params.status) search.set('status', params.status)
  if (cursor) search.set('cursor', cursor)
  return `/platform/tenants?${search.toString()}`
}

export type InvitationDelivery = { email: string; expiresAt: string; emailed: boolean; link: string | null }

export type TenantDetail = {
  id: string
  name: string
  slug: string
  status: TenantLifecycleStatus
  statusLabel: string
  statusChangedAt: string | null
  timezone: string
  localTimezone: string
  defaultCurrency: string
  retentionDays: number
  retentionUntil: string | null
  createdAt: string
  closedAt: string | null
  closeProgress: CloseState | null
  onboarding: {
    completed: boolean
    currentStep: OnboardingStepKey | 'DONE'
    steps: Array<{ key: OnboardingStepKey; no: number; title: string; required: boolean; state: 'PENDING' | 'COMPLETED' | 'SKIPPED' }>
    firstSync: { startedAt: string; jobs: number; segments: number } | null
  } | null
  quotas: QuotaUsage
  invitations: Array<{ id: string; email: string; status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'; expiresAt: string; createdAt: string }>
  events: Array<{ id: string; from: TenantLifecycleStatus; to: TenantLifecycleStatus; reason: string | null; at: string }>
  supportAccesses: Array<{ id: string; reason: string; expiresAt: string; claimed: boolean; revoked: boolean }>
}

export type TenantUsage = { quotas: QuotaUsage; connections: number; syncJobs24h: number; syncFailed24h: number; lastSyncAt: string | null; orders: number }

export const tenantDetailQuery = (id: string) =>
  queryOptions({ queryKey: ['platform', 'tenant', id], queryFn: () => platformFetch<TenantDetail>(`/platform/tenants/${encodeURIComponent(id)}`), retry: false })
export const tenantUsageQuery = (id: string) =>
  queryOptions({ queryKey: ['platform', 'tenant', id, 'usage'], queryFn: () => platformFetch<TenantUsage>(`/platform/tenants/${encodeURIComponent(id)}/usage`), retry: false })

export type SupportAccessItem = {
  id: string
  tenant: { id: string; name: string; slug: string }
  reason: string
  startsAt: string
  expiresAt: string
  claimedByMe: boolean
}
export const supportAccessQuery = queryOptions({
  queryKey: ['platform', 'support-access'],
  queryFn: () => platformFetch<{ items: SupportAccessItem[] }>('/platform/support-access'),
  retry: false,
})

export const hasPlatformPermission = (admin: PlatformAdmin | undefined, permission: string) => Boolean(admin?.permissions.includes(permission))
