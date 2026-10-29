// 预警规则的通知设置与自定义指标规则（P6-16，16 章第 9 节、08 第 4.2 节）。本文件只放类型、常量与纯函数，**不引入 zod**，前端与 worker 都从这里取。
// - 通知频率：立即、每小时汇总、每日汇总；严重级别的预警一律立即通知（不被汇总拖延）；
// - 静默时段结束后补发一条汇总（静默期内产生的预警并入同一批）；
// - 多级升级：未确认（状态仍是“新”）超过各级时限，依次通知待办负责人、规则的通知对象、预警管理员；
// - 自定义指标规则（评估器类型 `CUSTOM_METRIC`）：条件来自 P6-07 的 `ConditionGroups`，按店铺逐个判断。

/** 自定义指标规则的评估器类型；它不在预置规则目录里（目录只放系统预置的 27 条，模板页由目录生成）。 */
export const CUSTOM_METRIC_TYPE = 'CUSTOM_METRIC'
/** 一次评估或试算最多判断的店铺数；超出的不评估（评估结果里标注截断）。 */
export const CUSTOM_METRIC_MAX_STORES = 200
/** 试算（预览）最多判断的店铺数与回看天数。 */
export const ALERT_PREVIEW_MAX_STORES = 100
export const ALERT_PREVIEW_DAYS = 7

export const ALERT_NOTIFY_FREQUENCIES = ['IMMEDIATE', 'HOURLY', 'DAILY'] as const
export type AlertNotifyFrequency = (typeof ALERT_NOTIFY_FREQUENCIES)[number]
export const ALERT_NOTIFY_FREQUENCY_LABEL: Readonly<Record<AlertNotifyFrequency, string>> = { IMMEDIATE: '立即通知', HOURLY: '每小时汇总', DAILY: '每日汇总' }
export const isNotifyFrequency = (value: unknown): value is AlertNotifyFrequency => typeof value === 'string' && (ALERT_NOTIFY_FREQUENCIES as readonly string[]).includes(value)

export const ALERT_ESCALATION_MAX_LEVELS = 3
export const ALERT_ESCALATION_MIN_MINUTES = 5
export const ALERT_ESCALATION_MAX_MINUTES = 43_200
/** 第 1、2、3 级各通知谁（顺序固定）。 */
export const ALERT_ESCALATION_TARGET_LABEL: readonly string[] = ['待办负责人', '规则的通知对象', '预警管理员']

/** 一级升级：预警从首次触发起，超过这么多分钟仍是“新”（没人确认）就升级。 */
export interface AlertEscalationLevel {
  afterMinutes: number
}

export type EscalationCheck = { ok: true; levels: AlertEscalationLevel[] } | { ok: false; message: string }

/** 校验升级设置：最多 3 级，时限是整数分钟，越往后越长（严格递增）；空数组表示不升级。 */
export function checkEscalation(value: unknown): EscalationCheck {
  if (value === null || value === undefined) return { ok: true, levels: [] }
  if (!Array.isArray(value)) return { ok: false, message: '升级设置要是一个列表' }
  if (value.length > ALERT_ESCALATION_MAX_LEVELS) return { ok: false, message: `升级最多 ${ALERT_ESCALATION_MAX_LEVELS} 级` }
  const levels: AlertEscalationLevel[] = []
  for (const [index, item] of value.entries()) {
    const minutes = item && typeof item === 'object' ? (item as { afterMinutes?: unknown }).afterMinutes : undefined
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < ALERT_ESCALATION_MIN_MINUTES || minutes > ALERT_ESCALATION_MAX_MINUTES)
      return { ok: false, message: `第 ${index + 1} 级的时限要在 ${ALERT_ESCALATION_MIN_MINUTES} 到 ${ALERT_ESCALATION_MAX_MINUTES} 分钟之间（整数）` }
    if (index > 0 && minutes <= levels[index - 1].afterMinutes) return { ok: false, message: `第 ${index + 1} 级的时限必须比第 ${index} 级更长` }
    levels.push({ afterMinutes: minutes })
  }
  return { ok: true, levels }
}

/** 读取库里存的升级设置；格式不对按“不升级”处理。 */
export function readEscalation(value: unknown): AlertEscalationLevel[] {
  const checked = checkEscalation(value)
  return checked.ok ? checked.levels : []
}

export function escalationMinutesText(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

/** 一句话说明升级链，例如“超过 1 小时未确认通知待办负责人；超过 4 小时通知规则的通知对象”。 */
export function describeEscalation(levels: readonly AlertEscalationLevel[]): string {
  if (levels.length === 0) return '不升级'
  return levels.map((level, index) => `${index === 0 ? '超过' : '再超过'} ${escalationMinutesText(level.afterMinutes)}未确认通知${ALERT_ESCALATION_TARGET_LABEL[index]}`).join('；')
}

/** 汇总通知的标题与正文（worker 发送，文字统一在这里，测试与界面说明共用）。 */
export function digestTitle(ruleName: string, count: number, kind: 'FREQUENCY' | 'QUIET'): string {
  return kind === 'QUIET' ? `静默期间的预警汇总：${ruleName}（${count} 个对象）` : `预警汇总：${ruleName}（${count} 个对象）`
}

export function digestBody(labels: readonly string[], total: number): string {
  const shown = labels.slice(0, 5).join('、')
  return total > labels.slice(0, 5).length ? `${shown} 等 ${total} 个对象，点击查看预警中心里这条规则的预警` : `${shown}，点击查看预警中心里这条规则的预警`
}

export const digestLink = (ruleId: string) => `/app/alerts?ruleId=${encodeURIComponent(ruleId)}`

/** 自定义指标规则的业务域（预置域里选最接近的，用于通知偏好）：取第一个条件的指标所属域。 */
export const CUSTOM_METRIC_DOMAIN_OF: Readonly<Record<string, string>> = { sales: 'PRODUCT', ads: 'ADS', inventory: 'INVENTORY', profit: 'FINANCE', aftersales: 'AFTER_SALES' }
