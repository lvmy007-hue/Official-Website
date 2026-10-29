import type { ReactNode } from 'react'
import { alertParamSpecsOf, type AlertParamSpec, type AlertRuleScope, type AlertRuleStats } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'

// 预警规则页的文字写法（P5-01）：阈值、范围、质量统计。没有数据时写“尚无记录”或“不启用”，不拿 0 冒充。

const trim = (value: number) => String(Math.round(value * 10_000) / 10_000)

export function paramValueText(spec: AlertParamSpec, value: unknown): string {
  if (spec.kind === 'choices') {
    const picked = Array.isArray(value) ? spec.options.filter(option => value.includes(option.value)).map(option => option.label.replace(/（.*）/, '')) : []
    return picked.length > 0 ? picked.join('、') : '未设置'
  }
  if (value === null || value === undefined) return spec.kind === 'number' && spec.nullable ? '不启用' : '未设置'
  if (typeof value !== 'number') return '未设置'
  if (spec.kind === 'percent') return `${trim(value * 100)}%`
  return spec.unit ? `${trim(value)} ${spec.unit}` : trim(value)
}

/** 一组阈值的“名称 值”清单；该评估器没有可调项时返回空数组。 */
export const paramLines = (type: string, params: Record<string, unknown>): Array<{ label: string; value: string }> =>
  alertParamSpecsOf(type).map(spec => ({ label: spec.label, value: paramValueText(spec, params[spec.key]) }))

export interface ScopeNames {
  members: ReadonlyMap<string, string>
}

export function scopeText(scope: AlertRuleScope, names: ScopeNames): string {
  const parts: string[] = []
  if (scope.legalEntityIds?.length) parts.push(`${scope.legalEntityIds.length} 个主体`)
  if (scope.sellerAccountIds?.length) parts.push(`${scope.sellerAccountIds.length} 个店铺`)
  if (scope.categories?.length) parts.push(`${scope.categories.length} 个品类`)
  if (scope.skus?.length) parts.push(`${scope.skus.length} 个 SKU`)
  const range = parts.length > 0 ? `限定 ${parts.join('、')}` : '不限制（全部店铺与商品）'
  const extra: string[] = []
  if (scope.ownerId) extra.push(`负责人 ${names.members.get(scope.ownerId) ?? '已离开的成员'}`)
  if (scope.notifyUserIds?.length) extra.push(`通知 ${scope.notifyUserIds.length} 人`)
  if (scope.quiet) extra.push(`静默 ${scope.quiet.start}–${scope.quiet.end}`)
  return extra.length > 0 ? `${range}；${extra.join('；')}` : range
}

export function statsCells(stats: AlertRuleStats): { hits: ReactNode; rate: ReactNode; hours: ReactNode } {
  const none = <Muted>尚无记录</Muted>
  return {
    hits: (
      <span className="erp-num">
        {stats.hits}
        {stats.truncated ? '+' : ''}
      </span>
    ),
    rate:
      stats.falsePositiveRate === null ? (
        none
      ) : (
        <span className="erp-num">
          {trim(stats.falsePositiveRate * 100)}%（{stats.falsePositive}/{stats.handled}）
        </span>
      ),
    hours: stats.avgHandleHours === null ? none : <span className="erp-num">{stats.avgHandleHours} 小时</span>,
  }
}
