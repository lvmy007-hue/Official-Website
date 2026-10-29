import { FRESHNESS_STATUS_LABEL, type FreshnessViewStatus } from './freshness.js'
import {
  CHECK_ACKNOWLEDGEABLE,
  CHECK_KEYS,
  CHECK_LABEL,
  PERIOD_ADS_TOLERANCE,
  PERIOD_COST_COVERAGE_MIN,
  PERIOD_DETAIL_LIMIT,
  PERIOD_STATUS_LABEL,
  type AcknowledgeableKey,
  type CheckAcknowledgement,
  type CheckBaseState,
  type CheckItem,
  type CheckKey,
  type CheckState,
  type PeriodActions,
  type PeriodChecklist,
  type PeriodStatus,
} from './periods.js'

// 期间关账的纯函数（P2b-13）：自然月窗口、六个检查项的判定、检查清单合并（含确认放行）、检查后的状态、可用动作。
// 全部不碰数据库与时钟（时间由调用方传入），API 与测试共用。日期都是 YYYY-MM-DD 文本。

const DAY_MS = 86_400_000
const round2 = (value: number) => Math.round(value * 100) / 100
const percent = (value: number) => `${(Math.round(value * 1000) / 10).toFixed(1)}%`
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** 自然月 YYYY-MM 的起止日；格式不对返回 null。 */
export function monthPeriodOf(month: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const index = Number(match[2]) - 1
  return { start: dayOf(Date.UTC(year, index, 1)), end: dayOf(Date.UTC(year, index + 1, 1) - DAY_MS) }
}

/** 期间起始日所在月份（YYYY-MM）。 */
export const monthOfStart = (start: string) => start.slice(0, 7)

/** 期间必须已经结束（结束日早于企业时区的今天）才能创建与关账。 */
export const periodEnded = (end: string, today: string) => end < today

/** 从今天往前数，最早允许创建的月份（含）；用来挡掉年份写错的期间。 */
export function earliestMonth(today: string, years: number): string {
  const year = Number(today.slice(0, 4)) - years
  return `${String(year).padStart(4, '0')}-${today.slice(5, 7)}`
}

// ---- 检查项判定 ----

export interface CheckEval {
  baseState: CheckBaseState
  summary: string
  details: string[]
  value: number | null
}

const cap = (lines: readonly string[]) => (lines.length > PERIOD_DETAIL_LIMIT ? [...lines.slice(0, PERIOD_DETAIL_LIMIT), `……另有 ${lines.length - PERIOD_DETAIL_LIMIT} 条`] : [...lines])

export interface SyncFact {
  key: string
  label: string
  /** 同步记录的状态；没有记录为 null。 */
  status: string | null
  /** 数据覆盖到的时间（dataThrough，没有则最近成功时间）。 */
  coveredThrough: Date | null
}

/** 各数据域同步完整：订单与财务交易都要有同步记录、状态没出故障、数据覆盖到期间结束之后。periodEndAt 是期间结束日次日零点（企业时区）对应的时刻。 */
export function evaluateSync(facts: readonly SyncFact[], periodEndAt: Date): CheckEval {
  const problems: string[] = []
  for (const fact of facts) {
    if (fact.status === null) problems.push(`${fact.label}：尚无同步记录`)
    else if (['FAILED', 'UNAUTHORIZED', 'WAITING_DEPENDENCY', 'NOT_CONNECTED'].includes(fact.status)) {
      problems.push(`${fact.label}：同步${FRESHNESS_STATUS_LABEL[fact.status as FreshnessViewStatus] ?? fact.status}`)
    } else if (fact.status !== 'NOT_APPLICABLE' && (fact.coveredThrough === null || fact.coveredThrough.getTime() < periodEndAt.getTime())) {
      problems.push(`${fact.label}：数据只同步到 ${fact.coveredThrough ? fact.coveredThrough.toISOString().slice(0, 16).replace('T', ' ') + '（UTC）' : '尚无记录'}，没有覆盖到期间结束`)
    }
  }
  return problems.length === 0
    ? { baseState: 'PASS', summary: `${facts.map(fact => fact.label).join('、')}都已同步到期间结束之后`, details: [], value: 0 }
    : { baseState: 'FAIL', summary: `${problems.length} 个数据来源没有同步完整`, details: cap(problems), value: problems.length }
}

export interface SettlementFact {
  externalSettlementId: string
  /** 结算周期结束日（企业时区的日历日）；没有为 null。 */
  endDate: string | null
  /** 结算报告里的明细条数；0 表示报告还没到。 */
  txnCount: number
}

/** 结算已到：至少一张结算单覆盖到期间结束日，且覆盖本期间的每张结算单的报告都已到达。 */
export function evaluateSettlements(rows: readonly SettlementFact[], periodEnd: string): CheckEval {
  if (rows.length === 0) {
    return { baseState: 'FAIL', summary: '没有任何结算单覆盖这段期间', details: ['结算报告在结算周期结束后才由亚马逊生成，同步任务每日检索一次；期间最后一个结算周期结束前不能关账'], value: 1 }
  }
  const problems: string[] = []
  const latest = rows.reduce<string | null>((max, row) => (row.endDate && (max === null || row.endDate > max) ? row.endDate : max), null)
  if (latest === null || latest < periodEnd) problems.push(`覆盖本期间的结算单最晚只到 ${latest ?? '（没有结束日）'}，期间最后几天所在的结算周期还没有结束`)
  for (const row of rows) if (row.txnCount <= 0) problems.push(`结算单 ${row.externalSettlementId}：结算报告尚未到达`)
  return problems.length === 0
    ? { baseState: 'PASS', summary: `${rows.length} 张结算单覆盖整个期间，结算报告都已到达`, details: [], value: 0 }
    : { baseState: 'FAIL', summary: `${problems.length} 个结算问题`, details: cap(problems), value: problems.length }
}

export interface CostFact {
  /** 期间内利润日表（下单口径、SKU 行）的行数。 */
  rows: number
  units: number
  costedUnits: number
}

/** 成本覆盖率达标：已计成本件数 ÷ 销售件数 ≥ 达标线；利润日表一行都没有算未通过（还没派生）；没有销售件数无需成本。 */
export function evaluateCostCoverage(fact: CostFact, min = PERIOD_COST_COVERAGE_MIN): CheckEval {
  if (fact.rows === 0) {
    return {
      baseState: 'FAIL',
      summary: '利润日表在这段期间内没有数据',
      details: ['订单与财务交易同步完成后会自动派生利润日表（每 6 小时重算近 45 天）；这个店铺这段期间若确实没有任何交易则无法关账'],
      value: null,
    }
  }
  if (fact.units <= 0) return { baseState: 'PASS', summary: '期间内没有销售件数，无需成本', details: [], value: null }
  const coverage = fact.costedUnits / fact.units
  const line = `成本覆盖率 ${percent(coverage)}（已计成本 ${fact.costedUnits} / 销售 ${fact.units} 件），达标线 ${percent(min)}`
  return coverage >= min
    ? { baseState: 'PASS', summary: line, details: [], value: Math.round(coverage * 10000) / 10000 }
    : { baseState: 'FAIL', summary: line, details: ['缺成本的商品到利润分析的“成本覆盖”页签查看，补成本版本生效后重新检查'], value: Math.round(coverage * 10000) / 10000 }
}

export interface FxFact {
  /** 期间内带“汇率缺失”标记的利润日表行数（任一口径）。 */
  missingRows: number
  /** 期间内带“汇率沿用前值”标记的行数（只提示，不挡关账）。 */
  fallbackRows: number
  /** 期间内成本用到的非美元币种。 */
  currencies: readonly string[]
  /** 各币种在期间内没有任何汇率记录的日期。 */
  missingDays: ReadonlyArray<{ currency: string; days: readonly string[] }>
}

/** 汇率齐全：没有缺失汇率的利润行，且成本用到的每个外币每天都有汇率记录。沿用前值只提示。 */
export function evaluateFx(fact: FxFact): CheckEval {
  const problems: string[] = []
  if (fact.missingRows > 0) problems.push(`${fact.missingRows} 行利润日表因汇率缺失没有折算成本`)
  for (const item of fact.missingDays) {
    if (item.days.length > 0) problems.push(`${item.currency}：${item.days.length} 天没有汇率（${item.days.slice(0, 5).join('、')}${item.days.length > 5 ? ' 等' : ''}）`)
  }
  const info = fact.fallbackRows > 0 ? [`另有 ${fact.fallbackRows} 行使用了沿用前值的汇率（只提示，不影响通过）`] : []
  if (problems.length > 0) return { baseState: 'FAIL', summary: `汇率不齐全：${problems.length} 个问题`, details: cap([...problems, ...info]), value: problems.length }
  const summary = fact.currencies.length === 0 ? '期间内成本没有用到外币汇率' : `${fact.currencies.join('、')} 的汇率每天都有记录`
  return { baseState: 'PASS', summary, details: info, value: 0 }
}

export interface AdsFact {
  /** 期间内利润日表（下单口径）的行数。 */
  rows: number
  /** 其中广告已分摊到 SKU 的行数。 */
  allocatedRows: number
  /** 仍未分摊的广告花费合计（店铺级行）；没有为 null。 */
  unallocated: number | null
}

/** 广告分摊完成：期间内没有任何分摊结果（没有绑定广告账户或没有广告花费记录）时“尚未接入”（只能确认放行）；有结果时要求未分摊的花费为零。 */
export function evaluateAds(fact: AdsFact): CheckEval {
  if (fact.allocatedRows === 0) {
    return {
      baseState: 'NOT_CONNECTED',
      summary: '广告分摊尚未接入：期间内没有广告花费记录（广告账户没有绑定该店铺，或还没有同步到花费），无从分摊',
      details: ['绑定广告账户并同步到花费后，利润日表重算会按规则分摊；在此之前，关账只能由有权限的人确认放行（写明原因，留痕）'],
      value: null,
    }
  }
  const left = round2(fact.unallocated ?? 0)
  if (left > PERIOD_ADS_TOLERANCE) {
    return { baseState: 'FAIL', summary: `仍有 ${left.toFixed(2)} 美元的广告花费没有分摊`, details: ['完成广告分摊后重新检查；确实无法分摊的可以确认放行并写明原因'], value: left }
  }
  return { baseState: 'PASS', summary: '广告花费已全部分摊', details: [], value: 0 }
}

export interface ReconFact {
  open: number
  /** 未处理异常金额的绝对值合计。 */
  absTotal: number | null
}

/** 对账异常已处理或已确认：期间内结算核对的未处理异常为零；有异常的可以确认放行（写明原因）。 */
export function evaluateRecon(fact: ReconFact): CheckEval {
  if (fact.open <= 0) return { baseState: 'PASS', summary: '没有未处理的对账异常', details: [], value: 0 }
  return {
    baseState: 'FAIL',
    summary: `${fact.open} 条对账异常待处理${fact.absTotal === null ? '' : `（金额绝对值合计 ${round2(fact.absTotal).toFixed(2)}）`}`,
    details: ['到结算交易页的“三方核对”处理后重新检查；确认可以接受的差异可以确认放行并写明原因'],
    value: fact.open,
  }
}

// ---- 检查清单 ----

export interface AcknowledgeRequest {
  key: AcknowledgeableKey
  note: string
}

/** 这次请求里想确认放行、但这一项本来就通过了的检查项（应当拒绝，免得留下没有意义的确认记录）。 */
export function needlessAcknowledgements(evals: Record<CheckKey, CheckEval>, requests: readonly AcknowledgeRequest[]): CheckKey[] {
  return requests.filter(request => evals[request.key].baseState === 'PASS').map(request => request.key)
}

/**
 * 合并六个检查项的判定与确认放行：本次请求里的确认记下来；没有请求但上一次的确认仍然有效（这一项仍没通过，且数字没变）就沿用；
 * 通过的项不带确认。passed = 每一项都是通过或已确认放行。
 */
export function buildChecklist(evals: Record<CheckKey, CheckEval>, previous: PeriodChecklist | null, requests: readonly AcknowledgeRequest[], userId: string, now: Date): PeriodChecklist {
  const items = CHECK_KEYS.map((key): CheckItem => {
    const evaluated = evals[key]
    const acknowledgeable = (CHECK_ACKNOWLEDGEABLE as readonly string[]).includes(key)
    let acknowledgement: CheckAcknowledgement | null = null
    if (acknowledgeable && evaluated.baseState !== 'PASS') {
      const request = requests.find(item => item.key === key)
      const before = previous?.items.find(item => item.key === key)?.acknowledgement ?? null
      if (request) acknowledgement = { by: userId, at: now.toISOString(), note: request.note, value: evaluated.value }
      else if (before && before.value === evaluated.value) acknowledgement = before
    }
    const state: CheckState = evaluated.baseState === 'PASS' ? 'PASS' : acknowledgement ? 'ACKNOWLEDGED' : evaluated.baseState
    return { key, label: CHECK_LABEL[key], state, baseState: evaluated.baseState, summary: evaluated.summary, details: evaluated.details, value: evaluated.value, acknowledgeable, acknowledgement }
  })
  return { checkedAt: now.toISOString(), passed: items.every(item => item.state === 'PASS' || item.state === 'ACKNOWLEDGED'), items }
}

/** 检查之后的状态：通过进入关账中；没通过回到开放（关过账、重开过的回到重新开账）。 */
export const statusAfterCheck = (passed: boolean, closeCount: number): PeriodStatus => (passed ? 'CLOSING' : closeCount > 0 ? 'REOPENED' : 'OPEN')

/** 审批被驳回后的状态：回到开放（重开过的回到重新开账）。 */
export const statusAfterReject = (closeCount: number): PeriodStatus => (closeCount > 0 ? 'REOPENED' : 'OPEN')

// ---- 可用动作 ----

export interface ActionInput {
  status: PeriodStatus
  approvalDecision: string | null
  /** 最近一次通过检查的人（发起关账的人）。 */
  checkedBy: string | null
  userId: string
  canClose: boolean
  canReopen: boolean
}

const yes = { allowed: true, reason: null } as const
const no = (reason: string) => ({ allowed: false, reason })

/** 各动作当前是否可用及不可用的原因；服务端执行前用同一套规则再判断一次。 */
export function periodActionsOf(input: ActionInput): PeriodActions {
  const { status } = input
  const closeDenied = input.canClose ? null : '缺少权限：finance.period.close，请联系企业管理员开通'
  const check = closeDenied ? no(closeDenied) : status === 'CLOSED' ? no('已关账的期间不能再检查，需要先重新开账') : yes
  const approve = closeDenied
    ? no(closeDenied)
    : status !== 'CLOSING'
      ? no('只有“关账中”的期间可以审批：先通过完整性检查')
      : input.approvalDecision === 'APPROVED'
        ? no('已审批通过，可以锁定')
        : input.checkedBy !== null && input.checkedBy === input.userId
          ? no('发起这次关账检查的人不能审批，请换一位有关账权限的成员')
          : yes
  const close = closeDenied ? no(closeDenied) : status !== 'CLOSING' ? no('只有“关账中”且已审批通过的期间可以锁定') : input.approvalDecision !== 'APPROVED' ? no('锁定之前必须先审批通过') : yes
  const reopen = input.canReopen
    ? status === 'CLOSED'
      ? yes
      : no(`只有已关账的期间可以重新开账（当前：${PERIOD_STATUS_LABEL[status]}）`)
    : no('缺少权限：finance.period.reopen，重新开账只有管理员可以操作')
  return { check, approve, close, reopen }
}
