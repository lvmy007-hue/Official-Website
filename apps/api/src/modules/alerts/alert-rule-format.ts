import { alertParamSpecsOf, type AlertParamSpec } from '@nova/api-contracts'

// 规则阈值的文字描述（预警详情“触发时的阈值”、规则版本对比用）：按可调项登记的中文名、单位与取值说明展示。

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

/** 一组阈值的“名称 + 值”清单；只列该评估器类型登记过的项（旧数据里多余的键忽略）。 */
export function describeParams(type: string, params: unknown): Array<{ label: string; value: string }> {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  return alertParamSpecsOf(type).map(spec => ({ label: spec.label, value: paramValueText(spec, source[spec.key]) }))
}

/** 规则行与版本快照里的 conditionJson → { type, params }（格式不对返回空对象）。 */
export function readCondition(value: unknown): { type: string; params: Record<string, unknown> } {
  const condition = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const params = condition.params && typeof condition.params === 'object' && !Array.isArray(condition.params) ? (condition.params as Record<string, unknown>) : {}
  return { type: typeof condition.type === 'string' ? condition.type : '', params }
}

/** 规则版本快照里除阈值外的设置（P5-01 起每个版本带全部设置；更早的版本只有 type 与 params，缺的项为 null）。 */
export interface RuleSnapshot {
  type: string
  params: Record<string, unknown>
  severity: string | null
  cooldownMinutes: number | null
  enabled: boolean | null
  scope: Record<string, unknown> | null
}

export function readSnapshot(value: unknown): RuleSnapshot {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const scope = raw.scope && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? (raw.scope as Record<string, unknown>) : null
  return {
    ...readCondition(value),
    severity: typeof raw.severity === 'string' ? raw.severity : null,
    cooldownMinutes: typeof raw.cooldownMinutes === 'number' ? raw.cooldownMinutes : null,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
    scope,
  }
}
