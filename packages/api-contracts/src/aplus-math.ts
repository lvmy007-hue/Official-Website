import {
  APLUS_ADVICE_BASIS,
  APLUS_COMPARE_BASIS,
  APLUS_LIMITS,
  type AplusActions,
  type AplusActionState,
  type AplusCompare,
  type AplusCompareSide,
  type AplusRejection,
  type AplusStatus,
} from './aplus.js'

// A+ 内容的纯计算（P4-14）：状态映射、动作可用性、修复建议、发布前后对照。没有 zod，前后端与 worker 共用。

/** 亚马逊的内容状态 → 我方状态；已批准且有上线时间记为已发布；不认识的状态返回 null（同步时保持原状态不覆盖）。 */
export function aplusStatusOf(amazonStatus: string | null | undefined, published: boolean): AplusStatus | null {
  switch ((amazonStatus ?? '').toUpperCase()) {
    case 'DRAFT':
      return 'DRAFT'
    case 'SUBMITTED':
      return 'SUBMITTED'
    case 'APPROVED':
      return published ? 'PUBLISHED' : 'APPROVED'
    case 'REJECTED':
      return 'REJECTED'
    default:
      return null
  }
}

const ADVICE_RULES: Array<{ pattern: RegExp; advice: string }> = [
  {
    pattern: /\b(claim|claims|guarantee|best|#1|number one|cure|cures|clinical|proven)\b|最好|第一|保证|治愈/i,
    advice: '去掉绝对化、比较性或功效类的说法（例如“最好”“第一”“治愈”），改用可以验证的事实描述',
  },
  { pattern: /\b(price|prices|sale|discount|free shipping|coupon|% off|shipping)\b|价格|折扣|促销|包邮|免运费/i, advice: '删掉价格、促销、折扣与运费相关的文字，这些内容不允许出现在 A+ 里' },
  { pattern: /\b(review|reviews|rating|ratings|stars?|customer feedback)\b|评论|评价|星级/i, advice: '删掉对客户评论、星级或评分的引用' },
  { pattern: /\b(competitor|competitors|compare|comparison|other brands?)\b|竞品|对比其他/i, advice: '删掉与其他品牌或竞品的比较，只介绍自己的商品' },
  {
    pattern: /\b(image|images|picture|pictures|photo|photos|resolution|blurry|low quality|logo|watermark)\b|图片|图像|模糊|水印/i,
    advice: '检查图片：分辨率要够、不能模糊或带水印，图片里不能有价格、促销或联系方式，并且要与商品相符',
  },
  { pattern: /\b(typo|spelling|grammar|capitali[sz]ation|punctuation)\b|错别字|语法|拼写/i, advice: '检查拼写、语法、大小写与标点' },
  { pattern: /\b(trademark|copyright|brand name|infring\w*)\b|商标|版权|侵权/i, advice: '检查商标与版权：不要使用你没有授权的品牌名、标志或图片' },
  { pattern: /\b(contact|email|e-mail|phone|website|url|http)\b|联系方式|电话|邮箱|网址/i, advice: '删掉联系方式、网址与外部链接' },
  { pattern: /\b(asin|asins|relat\w*|associat\w*|not match|mismatch)\b|关联|不符|不匹配/i, advice: '核对关联的 ASIN：内容必须与每个关联的商品相符，把不相符的 ASIN 移除' },
]

/** 拒绝原文 → 修复建议（关键词规则，通用提示，不是亚马逊的官方意见）；没有原文返回空。 */
export function aplusFixAdvice(reason: string | null | undefined): string[] {
  const text = (reason ?? '').trim()
  if (!text) return []
  const out = ADVICE_RULES.filter(rule => rule.pattern.test(text)).map(rule => rule.advice)
  return out.length > 0 ? out : ['对照拒绝原文逐项修改后重新提交；原文没有指向具体问题时，请到卖家后台查看审核详情']
}

export function aplusRejectionOf(status: AplusStatus, reason: string | null): AplusRejection | null {
  if (status !== 'REJECTED') return null
  return { reason: reason && reason.trim() ? reason : null, advice: aplusFixAdvice(reason), adviceBasis: APLUS_ADVICE_BASIS }
}

const yes: AplusActionState = { allowed: true, reason: null }
const no = (reason: string): AplusActionState => ({ allowed: false, reason })

/**
 * 动作可用性（页面按钮与服务端校验共用同一套判断，写入开关与权限另算）：
 * 编辑只给草稿与被拒的内容；已批准、已发布的内容请到卖家后台另建版本。关联 ASIN 在审核中以外都可以；提交审核要求至少关联一个 ASIN（我方的规则）。
 */
export function aplusActionsOf(input: { status: AplusStatus; hasKey: boolean; busy: boolean; asinCount: number; editable: boolean; editNote: string | null; createFailed?: boolean }): AplusActions {
  const { status } = input
  const base = (): AplusActionState | null =>
    !input.hasKey ? no('这份内容在亚马逊还没有创建成功，请等待创建完成或在“写入记录”里查看失败原因') : input.busy ? no('有一个写入正在处理，请等它完成后再操作') : null
  const blocked = base()
  // 创建失败的草稿（亚马逊那边还没有）允许再保存一次，保存会重新发起创建
  const retryCreate = !input.hasKey && !input.busy && input.createFailed === true
  const edit =
    (retryCreate ? yes : blocked) ??
    (status !== 'DRAFT' && status !== 'REJECTED'
      ? no('只有草稿和被拒的内容可以修改；已提交、已批准或已发布的内容请到卖家后台处理')
      : !input.editable
        ? no(input.editNote ?? '这份内容包含编辑器不支持的模块，只能预览')
        : yes)
  const associate = blocked ?? (status === 'SUBMITTED' ? no('审核中不能修改关联的 ASIN') : yes)
  const submit = blocked ?? (status !== 'DRAFT' && status !== 'REJECTED' ? no('只有草稿和被拒的内容可以提交审核') : input.asinCount <= 0 ? no('提交审核前至少要关联一个 ASIN') : yes)
  return { edit, associate, submit }
}

// ---- 发布前后对照 ----

const DAY_MS = 86_400_000
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS)
const dayText = (value: number) => new Date(value * DAY_MS).toISOString().slice(0, 10)

export interface AplusCompareWindows {
  before: { from: string; to: string; days: number }
  after: { from: string; to: string; days: number }
}
/** 前后窗口：发布日（UTC 日期）当天不计入；发布后的窗口到“昨天”为止（今天的数据还不完整）。 */
export function aplusCompareWindows(publishedAt: string, now: Date): AplusCompareWindows {
  const pub = dayNumber(publishedAt.slice(0, 10))
  const yesterday = Math.floor(now.getTime() / DAY_MS) - 1
  const afterTo = Math.min(pub + APLUS_LIMITS.compareDays, yesterday)
  return {
    before: { from: dayText(pub - APLUS_LIMITS.compareDays), to: dayText(pub - 1), days: APLUS_LIMITS.compareDays },
    after: { from: dayText(pub + 1), to: dayText(afterTo), days: Math.max(0, afterTo - pub) },
  }
}

export interface AplusDailyPoint {
  date: string
  sessions: number | null
  units: number | null
}

const sideOf = (window: { from: string; to: string; days: number }, daily: readonly AplusDailyPoint[]): AplusCompareSide => {
  const rows = daily.filter(item => item.date >= window.from && item.date <= window.to && item.sessions !== null)
  const sessions = rows.length > 0 ? rows.reduce((sum, item) => sum + (item.sessions ?? 0), 0) : null
  const withUnits = rows.filter(item => item.units !== null)
  const units = withUnits.length > 0 ? withUnits.reduce((sum, item) => sum + (item.units ?? 0), 0) : null
  return { ...window, daysWithData: rows.length, sessions, units, conversion: sessions && sessions > 0 && units !== null ? units / sessions : null }
}

export interface AplusCompareInput {
  status: AplusStatus
  publishedAt: string | null
  asinCount: number
  now: Date
  /** 关联 ASIN 按日合计的会话与订购件数；没有同步过销售与流量传 null；无权限传 'RESTRICTED'。 */
  daily: readonly AplusDailyPoint[] | null | 'RESTRICTED'
}

/** 发布前后转化率对照（口径见 APLUS_COMPARE_BASIS）。每种不能给结论的情形都写明原因，不给估算值。 */
export function aplusCompareOf(input: AplusCompareInput): AplusCompare {
  const empty = (state: AplusCompare['state'], note: string): AplusCompare => ({
    state,
    note,
    publishedAt: input.publishedAt,
    before: null,
    after: null,
    delta: null,
    relative: null,
    asinCount: input.asinCount,
    basis: APLUS_COMPARE_BASIS,
  })
  if (!input.publishedAt) {
    return input.status === 'APPROVED' || input.status === 'PUBLISHED'
      ? empty('NO_PUBLISH_TIME', '内容已批准，但发布记录里还没有查到上线时间，无法划分发布前后')
      : empty('NOT_PUBLISHED', '内容还没有发布，发布后才能对比前后转化率')
  }
  if (input.daily === 'RESTRICTED') return empty('RESTRICTED', '查看销售与流量需要“分析”相关权限，你没有这个权限')
  if (input.daily === null) return empty('NOT_CONNECTED', '这些 ASIN 还没有同步到销售与流量数据（需要数据中心或业务报告），暂时无法对比')
  const windows = aplusCompareWindows(input.publishedAt, input.now)
  if (windows.after.days < APLUS_LIMITS.compareMinAfterDays) return empty('TOO_RECENT', `发布后只有 ${windows.after.days} 天的完整数据，至少需要 ${APLUS_LIMITS.compareMinAfterDays} 天才对比`)
  const before = sideOf(windows.before, input.daily)
  const after = sideOf(windows.after, input.daily)
  const base = { publishedAt: input.publishedAt, before, after, asinCount: input.asinCount, basis: APLUS_COMPARE_BASIS }
  const thin = (side: AplusCompareSide) => side.sessions === null || side.sessions < APLUS_LIMITS.compareMinSessions
  if (thin(before) || thin(after)) {
    const which = thin(before) && thin(after) ? '发布前后' : thin(before) ? '发布前' : '发布后'
    return { ...base, state: 'INSUFFICIENT_DATA', note: `${which}的会话不足 ${APLUS_LIMITS.compareMinSessions}（或没有数据），样本太小不给结论`, delta: null, relative: null }
  }
  if (before.conversion === null || after.conversion === null) return { ...base, state: 'INSUFFICIENT_DATA', note: '缺少订购件数，无法计算转化率', delta: null, relative: null }
  return { ...base, state: 'OK', note: null, delta: after.conversion - before.conversion, relative: before.conversion > 0 ? after.conversion / before.conversion - 1 : null }
}
