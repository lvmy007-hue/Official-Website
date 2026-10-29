import { DATASET_FRESHNESS_SOURCES, FRESHNESS_SOURCES, JOB_FRESHNESS_SOURCES, REPORT_FRESHNESS_SOURCES, freshnessErrorMessage } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, optionalNumberParam, scopeFilter } from './params'

// 系统与账户类预警评估器（P2a-15，09 章 9.1）：数据同步失败、亚马逊授权失效或即将失效。
// 数据来自同步监听器在任务终态写下的 DataFreshness 与连接表；预警只看“店铺有一条在用的亚马逊授权”的店铺，
// 已解除授权的店铺不会永远报警；店铺重新授权之后、下一次同步成功之前，旧的失败不再触发预警。

const READ_LIMIT = 5000
const DAY = 86_400_000
const AUTH_EXPIRED = 'AUTH_EXPIRED'
/** 支持案件的“卖家支持”、销售税的“税务汇缴”受限角色没批，以及销售与流量要求的品牌备案（DK_NO_BRAND）：多数店铺都会长期处于这个状态（页面上有申请说明），不当作同步故障去打扰人。 */
const EXPECTED_UNAUTHORIZED = ['SUP_ROLE_PENDING', 'TAX_ROLE_PENDING', 'DK_NO_BRAND', 'FBK_NO_BRAND_ACCESS', 'APL_ROLE_MISSING', 'FEES_ROLE_PENDING']

export interface FreshnessFailure {
  sellerAccountId: string | null
  storeName: string | null
  sourceKey: string
  status: string
  lastErrorCode: string | null
  lastAttemptAt: Date
  lastSuccessAt: Date | null
}

export interface LiveConnection {
  sellerAccountId: string
  /** 最近一次授权（换发刷新令牌）的时间 */
  authorizedAt: Date | null
}

const SOURCE_LABELS = new Map([...FRESHNESS_SOURCES, ...REPORT_FRESHNESS_SOURCES, ...JOB_FRESHNESS_SOURCES, ...DATASET_FRESHNESS_SOURCES].map(spec => [spec.key, spec.label]))
export const sourceLabelOf = (sourceKey: string) => SOURCE_LABELS.get(sourceKey) ?? sourceKey

/** 失败记录是否仍然有效：店铺有在用授权，且没有在失败之后重新授权。没有店铺的来源（企业级）不需要授权。 */
const stillFailing = (row: FreshnessFailure, live: ReadonlyMap<string, LiveConnection>) => {
  if (row.sellerAccountId === null) return true
  const connection = live.get(row.sellerAccountId)
  return Boolean(connection) && !(connection?.authorizedAt && connection.authorizedAt.getTime() > row.lastAttemptAt.getTime())
}

/** 同步失败：来源最近一次以失败收场（授权失效另有预警；限流与上游暂时不可用记为延迟，不在此列）。 */
export function buildSyncFailedHits(rows: readonly FreshnessFailure[], live: ReadonlyMap<string, LiveConnection>, now: Date): AlertHit[] {
  return rows
    .filter(row => row.lastErrorCode !== AUTH_EXPIRED && !EXPECTED_UNAUTHORIZED.includes(row.lastErrorCode ?? '') && stillFailing(row, live))
    .sort((a, b) => a.lastAttemptAt.getTime() - b.lastAttemptAt.getTime())
    .map(row => {
      const label = sourceLabelOf(row.sourceKey)
      const reason = freshnessErrorMessage(row.lastErrorCode) ?? '同步失败，请稍后重试或查看同步中心'
      const store = row.storeName ?? '企业级'
      return {
        entityType: 'DATA_SOURCE',
        entityId: `${row.sellerAccountId ?? 'ALL'}:${row.sourceKey}`,
        sellerAccountId: row.sellerAccountId,
        entityLabel: `${store} · ${label}`,
        title: `${store}「${label}」同步失败`,
        suggestedAction: `${reason}。到同步中心查看失败原因，处理后重新同步`,
        evidence: {
          storeName: row.storeName,
          sourceKey: row.sourceKey,
          sourceLabel: label,
          status: row.status,
          errorCode: row.lastErrorCode,
          errorMessage: reason,
          lastAttemptAt: row.lastAttemptAt.toISOString(),
          lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
          hoursSinceSuccess: row.lastSuccessAt ? Math.round((now.getTime() - row.lastSuccessAt.getTime()) / 3_600_000) : null,
        },
      }
    })
}

export interface AuthParams {
  /** 授权最长年龄（天）；null 表示不按年龄推算（亚马逊没有公布固定有效期） */
  tokenMaxAgeDays: number | null
  warnBeforeDays: number
}

/** 授权失效（同步被亚马逊以“授权已失效”拒绝）或按年龄推算即将失效；每个店铺最多一个命中。 */
export function buildAuthHits(rows: readonly FreshnessFailure[], live: ReadonlyMap<string, LiveConnection>, storeNames: ReadonlyMap<string, string>, params: AuthParams, now: Date): AlertHit[] {
  const hits = new Map<string, { urgency: number; hit: AlertHit }>()
  for (const row of rows) {
    if (row.lastErrorCode !== AUTH_EXPIRED || row.sellerAccountId === null || !stillFailing(row, live)) continue
    const store = row.storeName ?? storeNames.get(row.sellerAccountId) ?? '店铺'
    const sources = rows.filter(item => item.sellerAccountId === row.sellerAccountId && item.lastErrorCode === AUTH_EXPIRED).map(item => sourceLabelOf(item.sourceKey))
    hits.set(row.sellerAccountId, {
      urgency: 0,
      hit: {
        entityType: 'STORE',
        entityId: row.sellerAccountId,
        sellerAccountId: row.sellerAccountId,
        entityLabel: store,
        title: `${store} 的亚马逊授权已失效`,
        suggestedAction: '请到连接中心重新授权；授权恢复前该店铺的数据不会更新，写入开关也会被自动关闭',
        evidence: {
          storeName: store,
          state: 'EXPIRED',
          affectedSources: [...new Set(sources)],
          lastAttemptAt: row.lastAttemptAt.toISOString(),
          authorizedAt: live.get(row.sellerAccountId)?.authorizedAt?.toISOString() ?? null,
        },
      },
    })
  }
  if (params.tokenMaxAgeDays !== null) {
    for (const connection of live.values()) {
      if (!connection.authorizedAt || hits.has(connection.sellerAccountId)) continue
      const expiresAt = new Date(connection.authorizedAt.getTime() + params.tokenMaxAgeDays * DAY)
      const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY)
      if (daysLeft > params.warnBeforeDays) continue
      const store = storeNames.get(connection.sellerAccountId) ?? '店铺'
      hits.set(connection.sellerAccountId, {
        urgency: Math.max(0, daysLeft),
        hit: {
          entityType: 'STORE',
          entityId: connection.sellerAccountId,
          sellerAccountId: connection.sellerAccountId,
          entityLabel: store,
          title: daysLeft > 0 ? `${store} 的亚马逊授权约 ${daysLeft} 天后失效` : `${store} 的亚马逊授权已超过设定的最长年龄`,
          suggestedAction: '请到连接中心重新授权，避免同步中断',
          evidence: { storeName: store, state: 'EXPIRING', authorizedAt: connection.authorizedAt.toISOString(), expiresAt: expiresAt.toISOString(), daysLeft, tokenMaxAgeDays: params.tokenMaxAgeDays },
        },
      })
    }
  }
  return [...hits.values()].sort((a, b) => a.urgency - b.urgency).map(item => item.hit)
}

export const syncFailedEvaluator: AlertEvaluator = {
  type: 'system.sync-failed',
  async evaluate({ db, tenantId, rule, now }) {
    const scope = scopeFilter(rule)
    const rows = await db.dataFreshness.findMany({
      where: {
        tenantId,
        OR: [{ status: 'FAILED' }, { status: 'UNAUTHORIZED', lastErrorCode: { notIn: [AUTH_EXPIRED, ...EXPECTED_UNAUTHORIZED] } }],
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
      },
      include: { sellerAccount: { select: { displayName: true } } },
      take: READ_LIMIT,
    })
    return buildSyncFailedHits(rows.map(toFailure), await liveConnections(db, tenantId), now)
  },
}

export const authExpiringEvaluator: AlertEvaluator = {
  type: 'system.auth-expiring',
  async evaluate({ db, tenantId, rule, now }) {
    const scope = scopeFilter(rule)
    const params: AuthParams = {
      tokenMaxAgeDays: optionalNumberParam(rule, 'tokenMaxAgeDays', { min: 30, max: 3650 }),
      warnBeforeDays: numberParam(rule, 'warnBeforeDays', 30, { min: 1, max: 365 }),
    }
    const rows = await db.dataFreshness.findMany({
      where: { tenantId, status: 'UNAUTHORIZED', lastErrorCode: AUTH_EXPIRED, ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}) },
      include: { sellerAccount: { select: { displayName: true } } },
      take: READ_LIMIT,
    })
    const live = await liveConnections(db, tenantId)
    const stores = await db.sellerAccount.findMany({ where: { tenantId, ...(scope.stores ? { id: { in: scope.stores } } : {}) }, select: { id: true, displayName: true }, take: 1000 })
    const scopedLive = new Map([...live].filter(([storeId]) => scope.allows({ sellerAccountId: storeId })))
    return buildAuthHits(rows.map(toFailure), scopedLive, new Map(stores.map(store => [store.id, store.displayName])), params, now)
  },
}

interface FreshnessDbRow {
  sellerAccountId: string | null
  sourceKey: string
  status: string
  lastErrorCode: string | null
  lastAttemptAt: Date
  lastSuccessAt: Date | null
  sellerAccount: { displayName: string } | null
}

const toFailure = (row: FreshnessDbRow): FreshnessFailure => ({
  sellerAccountId: row.sellerAccountId,
  storeName: row.sellerAccount?.displayName ?? null,
  sourceKey: row.sourceKey,
  status: row.status,
  lastErrorCode: row.lastErrorCode,
  lastAttemptAt: row.lastAttemptAt,
  lastSuccessAt: row.lastSuccessAt,
})

/** 有在用亚马逊授权（已授权、有刷新令牌）的店铺。 */
async function liveConnections(db: Parameters<AlertEvaluator['evaluate']>[0]['db'], tenantId: string): Promise<Map<string, LiveConnection>> {
  const rows = await db.platformConnection.findMany({
    where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, sellerAccountId: { not: null } },
    select: { sellerAccountId: true, refreshTokenUpdatedAt: true },
    take: 1000,
  })
  const result = new Map<string, LiveConnection>()
  for (const row of rows) {
    if (!row.sellerAccountId) continue
    const previous = result.get(row.sellerAccountId)
    // 同一店铺有多条连接时，取最近一次授权
    if (!previous || (row.refreshTokenUpdatedAt && (!previous.authorizedAt || row.refreshTokenUpdatedAt > previous.authorizedAt)))
      result.set(row.sellerAccountId, { sellerAccountId: row.sellerAccountId, authorizedAt: row.refreshTokenUpdatedAt })
  }
  return result
}
