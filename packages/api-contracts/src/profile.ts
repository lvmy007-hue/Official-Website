// 个人账号与通知偏好（P5-11，09 章 9.15）。本文件不依赖 zod，前端可以直接引用；请求体校验在 profile-query.ts。
//
// 规则（CR-096 确认）：
// - 通知按“业务域 × 严重级别”选择是否接收，关掉的组合不写入消息中心；
// - 个人免打扰时段按企业本地时区计算；时段内收到的通知不进入提醒（顶栏未读数不计），不逐条补发；
// - 严重级别的通知与待办超时升级通知不受免打扰限制（仍受上面的“是否接收”开关控制）；
// - 时段结束后发一条汇总，按业务域列出条数，并链接到对应的筛选结果。

import type { Density } from './shell-prefs.js'

export const NOTIFY_DOMAINS = ['INVENTORY', 'FINANCE', 'AFTER_SALES', 'ADS', 'PRODUCT', 'WORK', 'SYSTEM'] as const
export type NotifyDomain = (typeof NOTIFY_DOMAINS)[number]

export const NOTIFY_DOMAIN_LABEL: Record<NotifyDomain, string> = {
  INVENTORY: '库存',
  FINANCE: '财务',
  AFTER_SALES: '售后',
  ADS: '广告',
  PRODUCT: '商品',
  WORK: '待办与协作',
  SYSTEM: '系统与数据',
}

/** 每个业务域包含哪些通知（页面上直接展示，让人知道关掉会少收到什么）。 */
export const NOTIFY_DOMAIN_HINT: Record<NotifyDomain, string> = {
  INVENTORY: '断货、冗余、库龄、低库存费、库存滞留与入仓差异预警',
  FINANCE: '结算差异、费用多收、赔付期限预警',
  AFTER_SALES: '退货率异常、负面评论主题上升预警',
  ADS: '广告超预算、投放异常预警，以及广告自动规则的建议与结果',
  PRODUCT: '商品、刊登、定价、竞品与评价预警，以及定价规则的建议与结果',
  WORK: '指派给你的待办、评论里的 @ 提及、你发起的导出完成或失败',
  SYSTEM: '同步失败、授权即将失效、写入开关变化、汇率获取失败、推送中断等系统提示',
}

export const NOTIFY_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const
export type NotifySeverity = (typeof NOTIFY_SEVERITIES)[number]
export const NOTIFY_SEVERITY_LABEL: Record<NotifySeverity, string> = { INFO: '提示', WARNING: '警告', CRITICAL: '严重' }

/** 待办超时升级通知：不受免打扰限制，与严重级别同等对待。 */
export const ESCALATION_KINDS: readonly string[] = ['WORK_OVERDUE', 'WORK_ESCALATED']

/** 免打扰结束后发出的汇总通知类型。 */
export const DND_SUMMARY_KIND = 'DND_SUMMARY'

/** 通知的业务域：优先用发送方给的业务域（预警规则自带），否则按通知类型推断；认不出的归“系统与数据”。 */
export function notificationDomainOf(kind: string, hint?: string | null): NotifyDomain {
  if (hint && (NOTIFY_DOMAINS as readonly string[]).includes(hint)) return hint as NotifyDomain
  if (kind === 'WORK_ASSIGNED' || kind === 'MENTION' || kind.startsWith('WORK_') || kind.startsWith('EXPORT_')) return 'WORK'
  if (kind === 'PRICING') return 'PRODUCT'
  if (kind === 'ADVERTISING' || kind === 'ADS_RULE') return 'ADS'
  return 'SYSTEM'
}

export interface DndWindow {
  enabled: boolean
  /** 开始与结束，企业本地时区的 HH:MM；开始晚于结束表示跨午夜。 */
  start: string
  end: string
}

export interface NotifyPrefs {
  domains: Record<NotifyDomain, Record<NotifySeverity, boolean>>
  dnd: DndWindow
}

export const DEFAULT_DND: DndWindow = { enabled: false, start: '22:00', end: '08:00' }

export const defaultNotifyPrefs = (): NotifyPrefs => ({
  domains: Object.fromEntries(NOTIFY_DOMAINS.map(domain => [domain, { INFO: true, WARNING: true, CRITICAL: true }])) as NotifyPrefs['domains'],
  dnd: { ...DEFAULT_DND },
})

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
export const isClockTime = (value: unknown): value is string => typeof value === 'string' && TIME_PATTERN.test(value)

/** 把库里的值还原成完整偏好：缺的键用默认（全部接收、免打扰关闭），坏值也按默认处理。 */
export function notifyPrefsOf(raw: unknown): NotifyPrefs {
  const prefs = defaultNotifyPrefs()
  if (!raw || typeof raw !== 'object') return prefs
  const { domains, dnd } = raw as { domains?: unknown; dnd?: unknown }
  if (domains && typeof domains === 'object') {
    for (const domain of NOTIFY_DOMAINS) {
      const row = (domains as Record<string, unknown>)[domain]
      if (!row || typeof row !== 'object') continue
      for (const severity of NOTIFY_SEVERITIES) {
        const value = (row as Record<string, unknown>)[severity]
        if (typeof value === 'boolean') prefs.domains[domain][severity] = value
      }
    }
  }
  if (dnd && typeof dnd === 'object') {
    const { enabled, start, end } = dnd as Record<string, unknown>
    prefs.dnd = {
      enabled: enabled === true,
      start: isClockTime(start) ? start : DEFAULT_DND.start,
      end: isClockTime(end) ? end : DEFAULT_DND.end,
    }
    if (prefs.dnd.start === prefs.dnd.end) prefs.dnd = { ...DEFAULT_DND, enabled: prefs.dnd.enabled }
  }
  return prefs
}

const DEFAULT_ZONE = 'Asia/Shanghai'
const minutesOf = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))

function minutesInZone(now: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const pick = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0)
  return pick('hour') * 60 + pick('minute')
}

/** 此刻是否处在免打扰时段（企业本地时区；时区无效回退到北京时间）。 */
export function inDndWindow(now: Date, zone: string | null | undefined, dnd: DndWindow): boolean {
  if (!dnd.enabled) return false
  let minutes: number
  try {
    minutes = minutesInZone(now, zone || DEFAULT_ZONE)
  } catch {
    minutes = minutesInZone(now, DEFAULT_ZONE)
  }
  const start = minutesOf(dnd.start)
  const end = minutesOf(dnd.end)
  if (start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** DELIVER 正常送达；SILENCE 写入消息中心但不提醒（免打扰期间，结束后合并成汇总）；SKIP 不写入（对应的“业务域 × 级别”已关闭）。 */
export type DeliveryDecision = 'DELIVER' | 'SILENCE' | 'SKIP'

export interface DeliveryInput {
  kind: string
  domain?: string | null
  severity: string
}

export function decideDelivery(prefs: NotifyPrefs, input: DeliveryInput, now: Date, zone: string | null | undefined): DeliveryDecision {
  const domain = notificationDomainOf(input.kind, input.domain)
  const severity = (NOTIFY_SEVERITIES as readonly string[]).includes(input.severity) ? (input.severity as NotifySeverity) : 'INFO'
  if (!prefs.domains[domain][severity]) return 'SKIP'
  if (severity === 'CRITICAL' || ESCALATION_KINDS.includes(input.kind)) return 'DELIVER'
  return inDndWindow(now, zone, prefs.dnd) ? 'SILENCE' : 'DELIVER'
}

/** 一批收件人的送达判断：没有偏好记录的人按默认（全部接收、免打扰关闭）。发送方只负责读出偏好行与企业时区，判断规则只在这里。 */
export function deliveryVerdicts(
  userIds: readonly string[],
  rows: ReadonlyArray<{ userId: string; notifyJson: unknown }>,
  input: DeliveryInput,
  now: Date,
  zone: string | null | undefined,
): Map<string, DeliveryDecision> {
  const byUser = new Map(rows.map(row => [row.userId, notifyPrefsOf(row.notifyJson)]))
  const fallback = defaultNotifyPrefs()
  return new Map(userIds.map(userId => [userId, decideDelivery(byUser.get(userId) ?? fallback, input, now, zone)]))
}

/** 汇总通知的正文：按业务域列出条数（只列有条数的），顺序固定。 */
export function dndSummaryBody(counts: Partial<Record<string, number>>): string {
  const parts = NOTIFY_DOMAINS.filter(domain => (counts[domain] ?? 0) > 0).map(domain => `${NOTIFY_DOMAIN_LABEL[domain]} ${counts[domain]} 条`)
  const other = counts.OTHER ?? 0
  if (other > 0) parts.push(`其他 ${other} 条`)
  return parts.length > 0 ? `免打扰期间没有逐条提醒：${parts.join('、')}。` : '免打扰期间没有新的通知。'
}

/** 汇总通知的链接：只有一个业务域时直接带上筛选，多个时看全部免打扰期间的通知。 */
export function dndSummaryLink(counts: Partial<Record<string, number>>): string {
  const domains = Object.keys(counts).filter(key => (counts[key] ?? 0) > 0)
  const only = domains.length === 1 && (NOTIFY_DOMAINS as readonly string[]).includes(domains[0] as string) ? `&domain=${domains[0]}` : ''
  return `/app/my/notifications?silenced=true${only}`
}

export interface PreferencesResponse {
  notify: NotifyPrefs
  /** P6-01：侧边导航收藏的路由模板（按添加顺序，最多 FAVORITES_MAX 个）。 */
  favorites: string[]
  /** P6-01：界面密度。 */
  density: Density
  /** 乐观锁版本；还没保存过为 0。 */
  version: number
  updatedAt: string | null
  /** 免打扰按这个时区计算（企业本地时区）。 */
  zone: string
}

export interface ProfileUpdateResult {
  displayName: string
}
