import { SUPPORT_BODY_MAX, type SupportDirection } from '@nova/api-contracts'

// 卖家支持接口响应解析（Support API v2025-02-01，I-20）：纯函数，不访问数据库与网络。
// 字段按官方模型：案件 Case.{caseId, status, subject, primaryEmail, ccEmails, appointments, createdDate, lastUpdatedDate, resolvedDate, lastOutboundDate}，
// 沟通 Contact.{contactId, channel, createdDate, emailContent | phoneContent | chatContent}。
// 不读取、不保存主邮箱、抄送邮箱与预约里的电话号码（个人信息，页面用不到）；附件只取名称（下载链接 15 分钟失效）。
// 必填字段缺失的行整行跳过并计数，不猜、不补默认值。

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
function when(value: unknown): Date | null {
  const raw = text(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
const SUBJECT_MAX = 500
const NAME_MAX = 200

export interface ParsedAppointment {
  appointmentId: string
  status: string
  earliestAt: string
  latestAt: string
  answeringParty: string | null
}

export interface ParsedCase {
  caseId: string
  subject: string
  status: string
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
  lastOutboundAt: Date | null
  appointments: ParsedAppointment[]
}

function appointmentOf(raw: unknown): ParsedAppointment | null {
  const item = record(raw)
  const timing = record(item?.callbackTiming)
  const appointmentId = text(item?.appointmentId)
  const earliest = when(timing?.earliestCallbackTime)
  const latest = when(timing?.latestCallbackTime)
  const status = text(item?.status)
  if (!item || !appointmentId || !earliest || !latest || !status) return null
  return { appointmentId, status, earliestAt: earliest.toISOString(), latestAt: latest.toISOString(), answeringParty: text(item.answeringParty) }
}

export function parseCases(body: unknown): { cases: ParsedCase[]; skipped: number; nextToken: string | null } {
  const root = record(body)
  const cases: ParsedCase[] = []
  let skipped = 0
  for (const raw of list(root?.cases)) {
    const item = record(raw)
    const caseId = text(item?.caseId)
    const status = text(item?.status)
    const createdAt = when(item?.createdDate)
    const updatedAt = when(item?.lastUpdatedDate)
    if (!item || !caseId || !status || !createdAt || !updatedAt) {
      skipped += 1
      continue
    }
    cases.push({
      caseId,
      status: status.toUpperCase(),
      subject: (text(item.subject) ?? '（无主题）').slice(0, SUBJECT_MAX),
      createdAt,
      updatedAt,
      resolvedAt: when(item.resolvedDate),
      lastOutboundAt: when(item.lastOutboundDate),
      appointments: list(item.appointments).flatMap(entry => appointmentOf(entry) ?? []),
    })
  }
  return { cases, skipped, nextToken: text(root?.nextToken) }
}

export interface ParsedContact {
  contactId: string
  channel: string
  direction: SupportDirection
  senderName: string | null
  body: string
  attachments: string[]
  occurredAt: Date
}

const names = (value: unknown): string[] =>
  list(value).flatMap(entry => {
    const name = text(record(entry)?.name)
    return name ? [name.slice(0, NAME_MAX)] : []
  })
const clip = (value: string | null): string => (value ?? '').slice(0, SUPPORT_BODY_MAX)

/** 邮件：按发送方角色判断方向；电话备注与聊天记录没有发送方，方向标“未标明”。 */
function contentOf(item: Loose, channel: string): { direction: SupportDirection; senderName: string | null; body: string; attachments: string[] } | null {
  if (channel === 'EMAIL') {
    const email = record(item.emailContent)
    if (!email) return null
    const sender = record(email.sender)
    const role = text(sender?.role)
    return {
      direction: role === 'AMAZON' ? 'FROM_AMAZON' : role === 'SELLING_PARTNER' ? 'FROM_SELLER' : 'UNKNOWN',
      senderName: (text(sender?.displayName) ?? '').slice(0, NAME_MAX) || null,
      body: clip(text(email.message)),
      attachments: names(email.attachments),
    }
  }
  if (channel === 'PHONE') {
    const phone = record(item.phoneContent)
    return { direction: 'UNKNOWN', senderName: null, body: clip(text(phone?.callNotes)), attachments: [] }
  }
  if (channel === 'CHAT') {
    const chat = record(item.chatContent)
    // 优先用官方给的整段可读文字；没有时拼接聊天事件里的消息
    const events = list(chat?.events).map(record)
    const joined = events.flatMap(event => (event && text(event.message) ? [`${text(record(event.participant)?.displayName) ?? ''}：${text(event.message)}`] : [])).join('\n')
    return { direction: 'UNKNOWN', senderName: null, body: clip(text(chat?.transcript) ?? (joined || null)), attachments: events.flatMap(event => names(event?.attachments)) }
  }
  // 以后亚马逊新增渠道：保留这条沟通（只留时间与渠道），正文为空
  return { direction: 'UNKNOWN', senderName: null, body: '', attachments: [] }
}

export function parseContacts(body: unknown): { contacts: ParsedContact[]; skipped: number; nextToken: string | null } {
  const root = record(body)
  const contacts: ParsedContact[] = []
  let skipped = 0
  for (const raw of list(root?.contacts)) {
    const item = record(raw)
    const contactId = text(item?.contactId)
    const channel = text(item?.channel)?.toUpperCase()
    const occurredAt = when(item?.createdDate)
    const content = item && channel ? contentOf(item, channel) : null
    if (!item || !contactId || !channel || !occurredAt || !content) {
      skipped += 1
      continue
    }
    contacts.push({ contactId, channel, occurredAt, ...content })
  }
  return { contacts, skipped, nextToken: text(root?.nextToken) }
}
