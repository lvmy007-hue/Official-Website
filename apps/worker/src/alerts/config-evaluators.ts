import { FX_PROVIDERS, switchSpecOf } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam } from './params'

// 企业配置类预警评估器（P5-01，09 章 9.1 系统与账户域）：汇率获取失败、写入开关被自动关闭。
// 两类都是企业级对象（没有店铺、没有 SKU），所以规则范围里的店铺与 SKU 对它们不生效。
// 汇率获取与写入开关登记（recordSwitchOutcome）原本只在事件发生时发一条站内通知；这里把它们变成可追踪的预警（预警实例 + 待办），
// 状态恢复（汇率来源获取成功、开关被人工重新开启）后下一轮评估自动标记已恢复。原有的即时通知保留，不改。

export interface FxSourceRow {
  provider: string
  lastStatus: string | null
  lastErrorCode: string | null
  consecutiveFailures: number
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
}

const providerLabel = (provider: string) => (provider in FX_PROVIDERS ? FX_PROVIDERS[provider as keyof typeof FX_PROVIDERS].label : provider)

/** 主汇率来源最近一次获取失败且连续失败次数达到阈值：一个命中；备用来源失败不单独提醒。 */
export function buildFxHits(primary: FxSourceRow | null, minFailures: number, now: Date): AlertHit[] {
  if (!primary || primary.lastStatus !== 'FAILED' || primary.consecutiveFailures < minFailures) return []
  const label = providerLabel(primary.provider)
  return [
    {
      entityType: 'FX_SOURCE',
      entityId: 'PRIMARY',
      entityLabel: `主汇率来源 · ${label}`,
      title: `汇率已连续 ${primary.consecutiveFailures} 次获取失败`,
      suggestedAction: '当前沿用历史汇率，金额折算可能与当天实际汇率有偏差。请到汇率设置检查来源，或手工覆盖当天汇率',
      evidence: {
        provider: label,
        consecutiveFailures: primary.consecutiveFailures,
        failureThreshold: minFailures,
        errorCode: primary.lastErrorCode,
        lastAttemptAt: primary.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: primary.lastSuccessAt?.toISOString() ?? null,
        hoursSinceSuccess: primary.lastSuccessAt ? Math.round((now.getTime() - primary.lastSuccessAt.getTime()) / 3_600_000) : null,
      },
    },
  ]
}

export const fxFailedEvaluator: AlertEvaluator = {
  type: 'system.fx-failed',
  async evaluate({ db, tenantId, rule, now }) {
    const minFailures = numberParam(rule, 'minFailures', 3, { min: 1, max: 30 })
    const primary = await db.fxSourceConfig.findFirst({ where: { tenantId, role: 'PRIMARY' } })
    return buildFxHits(primary, minFailures, now)
  },
}

export interface ClosedSwitchRow {
  switchKey: string
  autoDisabledReason: string | null
  calls7d: number
  failures7d: number
  consecutiveFailures: number
  updatedAt: Date
}

/** 企业级写入开关处于“自动关闭”状态：每个开关一个命中（人工重新开启会清掉自动关闭原因，预警随之恢复）。 */
export function buildSwitchHits(rows: readonly ClosedSwitchRow[]): AlertHit[] {
  return rows
    .filter(row => row.autoDisabledReason)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .map(row => {
      const label = switchSpecOf(row.switchKey)?.label ?? row.switchKey
      return {
        entityType: 'INTEGRATION_SWITCH',
        entityId: row.switchKey,
        entityLabel: label,
        title: `写入开关“${label}”已被自动关闭`,
        suggestedAction: '该类写入已被拦下。请到“接口与写入开关”检查亚马逊连接与授权，确认没问题后重新开启',
        evidence: {
          switchLabel: label,
          autoDisabledReason: row.autoDisabledReason,
          calls7d: row.calls7d,
          failures7d: row.failures7d,
          consecutiveFailures: row.consecutiveFailures,
          closedAt: row.updatedAt.toISOString(),
        },
      }
    })
}

export const writeSwitchClosedEvaluator: AlertEvaluator = {
  type: 'system.write-switch-closed',
  async evaluate({ db, tenantId }) {
    const rows = await db.integrationSwitch.findMany({
      where: { tenantId, sellerAccountId: null, enabled: false, autoDisabledReason: { not: null } },
      select: { switchKey: true, autoDisabledReason: true, calls7d: true, failures7d: true, consecutiveFailures: true, updatedAt: true },
      orderBy: { switchKey: 'asc' },
      take: 200,
    })
    return buildSwitchHits(rows)
  },
}
