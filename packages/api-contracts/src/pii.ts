// 个人信息统一出口（P6-14，16 章第 6 节，08 第 4.3 节）。零 zod：前端与后台任务可以直接引用；带 zod 的请求体在 pii-query.ts。
//
// 规则只有一条：所有个人信息字段（姓名、地址、电话、邮箱、自由文本备注）的明文，只能经 POST /pii/reveal 返回。
// 其他接口一律只返回“有没有、含哪几类、能不能看”，不返回内容，也不返回密文。

/** 可以查看明文的对象类型：订单的买家信息、退货的买家备注、支持案件的沟通内容。 */
export const PII_OBJECT_TYPES = ['ORDER', 'RETURN', 'SUPPORT_CONTACT'] as const
export type PiiObjectType = (typeof PII_OBJECT_TYPES)[number]

export const PII_OBJECT_LABEL: Readonly<Record<PiiObjectType, string>> = {
  ORDER: '订单买家信息',
  RETURN: '退货买家备注',
  SUPPORT_CONTACT: '支持案件沟通内容',
}

/** 订单买家信息的字段（与加密保存的内容同名）。 */
export const ORDER_PII_FIELDS = ['buyerName', 'buyerEmail', 'buyerPhone', 'addressLine1', 'city', 'state', 'postalCode', 'country'] as const
/** 退货买家备注的字段名。 */
export const RETURN_PII_FIELDS = ['customerComments'] as const
/** 支持案件沟通内容的字段名（正文）。 */
export const SUPPORT_PII_FIELDS = ['body'] as const

/** 每种对象允许请求的字段。请求里出现表外字段返回 422。 */
export const PII_REVEAL_FIELDS: Readonly<Record<PiiObjectType, readonly string[]>> = {
  ORDER: ORDER_PII_FIELDS,
  RETURN: RETURN_PII_FIELDS,
  SUPPORT_CONTACT: SUPPORT_PII_FIELDS,
}

/** 一次请求最多取几个字段。 */
export const PII_REVEAL_FIELDS_MAX = 8
/** 理由的长度范围。 */
export const PII_REASON_MIN = 2
export const PII_REASON_MAX = 500
/** 对象编号的写法（系统编号或亚马逊订单号、案件编号）。 */
export const PII_OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 查看明文的审计动作与对象类型：成功与被拒绝的请求都用这一个动作（旧的订单动作 ORDER_BUYER_PII_VIEWED 只在历史记录里出现）。 */
export const PII_REVEAL_ACTION = 'PII_REVEALED'
export const PII_REVEAL_AUDIT_RESOURCE = 'PiiObject'
/** 字段权限：全站个人信息明文的唯一权限点（沿用“查看买家信息”）。 */
export const PII_REVEAL_PERMISSION = 'field.buyer'
/** 明文显示多少秒后自动隐藏（前端在组件状态里计时，不进请求缓存）。 */
export const PII_REVEAL_AUTO_HIDE_SECONDS = 60

/** 能给出明文的状态：OK 有内容；EXPIRED 已过保留期被清除；NOT_SYNCED 从来没有（没同步、没权限同步、对方没填）。 */
export type PiiRevealState = 'OK' | 'EXPIRED' | 'NOT_SYNCED'

export interface PiiRevealResponse {
  objectType: PiiObjectType
  objectId: string
  state: PiiRevealState
  /** 字段名 → 明文；没有内容的字段为 null；state 不是 OK 时为空对象。 */
  values: Record<string, string | null>
  /** 明文展示的截止时间（服务端给出，前端到点自动隐藏）；没有内容可展示时为 null。 */
  expiresAt: string | null
  /** 内容在系统里还会保留到什么时候（超过后由后台任务清除）；没有保留期的内容（支持案件）为 null。 */
  retainedUntil: string | null
  note: string | null
}

/** 买家备注在详情里的状态：NONE 没有留言；AVAILABLE 有（需要查看明文）；EXPIRED 已过保留期被清除。 */
export const COMMENT_STATES = ['NONE', 'AVAILABLE', 'EXPIRED'] as const
export type CommentState = (typeof COMMENT_STATES)[number]

export interface CommentView {
  state: CommentState
  /** 自动识别出的个人信息类别（电话、邮箱、地址）；识别只看模式，没识别出来不代表没有个人信息。 */
  kinds: PiiKind[]
  /** 保留期截止；没有内容时为 null。 */
  retainedUntil: string | null
}

// ---- 自由文本里的个人信息识别与掩码 ----

export const PII_KINDS = ['PHONE', 'EMAIL', 'ADDRESS'] as const
export type PiiKind = (typeof PII_KINDS)[number]

export const PII_KIND_LABEL: Readonly<Record<PiiKind, string>> = { PHONE: '电话', EMAIL: '邮箱', ADDRESS: '地址' }

// 街道词：全称不区分大小写；缩写与 Way 只认首字母大写（避免把 “2 items for Dr” 这类普通句子当成地址）。
const STREET_FULL = 'Street|Avenue|Road|Boulevard|Lane|Drive|Court|Place|Highway|Terrace|Circle|Parkway'
const STREET_SHORT = 'St|Ave|Rd|Blvd|Ln|Dr|Ct|Pl|Hwy|Pkwy|Way'
const UNIT = String.raw`(?:[,\s]+(?:Apt|Suite|Ste|Unit|#)\s*[\w-]+)?`

// 故意做得保守：订单号（3-7-7 位数字）、货件编号、物流单号、ASIN 不会被当成电话。
const PATTERNS: ReadonlyArray<{ kind: PiiKind; source: string; flags: string }> = [
  { kind: 'EMAIL', source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`, flags: 'g' },
  // 中国大陆手机号：1 开头 11 位，可带 +86 与分隔
  { kind: 'PHONE', source: String.raw`(?<![\d-])(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?![\d-])`, flags: 'g' },
  // 北美电话：(415) 555-0132、415-555-0132、415.555.0132、+1 415 555 0132（要求两处分隔，纯 10 位数字不算）
  { kind: 'PHONE', source: String.raw`(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]\d{4}(?![\d-])`, flags: 'g' },
  // 国际号码：+ 开头，国家码加三到五段数字
  { kind: 'PHONE', source: String.raw`(?<![\w+])\+\d{1,3}(?:[ -]?\d{2,4}){3,5}(?![\d-])`, flags: 'g' },
  // 英文街道地址：门牌号 + 街名 + 街道词（可带公寓、套房）
  { kind: 'ADDRESS', source: String.raw`\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:${STREET_FULL})\b\.?${UNIT}`, flags: 'gi' },
  // 缩写形式要求街名每个词首字母大写（123 Main St），“2 items for Dr”这类小写词的普通句子不算
  { kind: 'ADDRESS', source: String.raw`\b\d{1,6}\s+(?:[A-Z0-9][A-Za-z0-9.'-]*\s+){1,4}(?:${STREET_SHORT})\b\.?${UNIT}`, flags: 'g' },
  { kind: 'ADDRESS', source: String.raw`\bP\.?\s?O\.?\s+Box\s+\d+`, flags: 'gi' },
  // 美国“州缩写 + 邮编”
  { kind: 'ADDRESS', source: String.raw`\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b`, flags: 'g' },
  // 中文地址：省市区县 + 路街巷镇乡村 + 门牌
  { kind: 'ADDRESS', source: String.raw`[\u4e00-\u9fa5]{1,12}(?:省|市|区|县)[\u4e00-\u9fa5\d]{0,16}(?:路|街|道|巷|弄|镇|乡|村)[\u4e00-\u9fa5\d-]{0,12}(?:号|栋|幢|室|楼|单元)?`, flags: 'g' },
]

const MASK_TEXT: Readonly<Record<PiiKind, string>> = { PHONE: '[电话已隐藏]', EMAIL: '[邮箱已隐藏]', ADDRESS: '[地址已隐藏]' }

export interface MaskedText {
  /** 掩码后的文字（没识别出任何个人信息时与原文相同）。 */
  text: string
  kinds: PiiKind[]
  masked: boolean
}

/** 只识别、不改写：返回出现了哪几类（按 PII_KINDS 的顺序）。 */
export function detectPiiKinds(value: string | null | undefined): PiiKind[] {
  if (!value) return []
  const found = new Set<PiiKind>()
  for (const pattern of PATTERNS) if (new RegExp(pattern.source, pattern.flags).test(value)) found.add(pattern.kind)
  return PII_KINDS.filter(kind => found.has(kind))
}

/** 识别并掩码自由文本里的电话、邮箱、地址。先掩邮箱，再电话，最后地址，避免互相切碎。 */
export function maskFreeText(value: string | null | undefined): MaskedText {
  if (!value) return { text: value ?? '', kinds: [], masked: false }
  let text = value
  const found = new Set<PiiKind>()
  for (const pattern of PATTERNS) {
    text = text.replace(new RegExp(pattern.source, pattern.flags), () => {
      found.add(pattern.kind)
      return MASK_TEXT[pattern.kind]
    })
  }
  const kinds = PII_KINDS.filter(kind => found.has(kind))
  return { text, kinds, masked: kinds.length > 0 }
}

/** 把类别列表存成一个短字符串（数据库里的 customerCommentsKinds），读出时过滤掉未知值。 */
export const kindsToText = (kinds: readonly PiiKind[]): string => kinds.join(',')
export const kindsFromText = (value: string | null | undefined): PiiKind[] => {
  const parts = new Set((value ?? '').split(',').map(part => part.trim()))
  return PII_KINDS.filter(kind => parts.has(kind))
}
