import type { OrderRefundState } from './orders.js'
import {
  RETURN_DISPOSITION_CODES,
  RETURN_DISPOSITION_LABEL,
  RETURN_RECEIPT_LABEL,
  RETURN_REIMBURSEMENT_LABEL,
  type ReturnBucket,
  type ReturnDispositionGroup,
  type ReturnDispositionView,
  type ReturnReceiptState,
  type ReturnReimbursementView,
  type ReturnTrendPoint,
} from './returns.js'

// 退货页的纯计算（P2b-02）：处置分组、退款后是否收到退货、赔付状态、退货率与时间分桶。接口与测试共用，不依赖任何运行时。
// 口径假设（没有真实店铺数据核对，见 CR-040）：处置原值按官方文档列出的 8 个值归并；赔付状态里报告处理状态含 reimbursed 视为亚马逊已自动赔付。

const DAY_MS = 86_400_000

// ---- 处置 ----

/** 处置视图：原值优先取报告的详细处置，没有时回退到旧导入器写在 disposition 列的值。 */
export function returnDispositionView(detailed: string | null | undefined, stored?: string | null): ReturnDispositionView {
  const raw = (detailed ?? stored ?? '').trim()
  if (!raw) return { group: 'UNKNOWN', label: RETURN_DISPOSITION_LABEL.UNKNOWN, sellable: null, raw: null }
  const group: ReturnDispositionGroup = RETURN_DISPOSITION_CODES[raw.toUpperCase()] ?? 'OTHER'
  return { group, label: RETURN_DISPOSITION_LABEL[group], sellable: group === 'SELLABLE' ? true : group === 'OTHER' ? null : false, raw }
}

/** 某个处置分组对应的报告原值（用来筛选）；没有固定取值的分组返回空数组。 */
export function dispositionCodesOf(group: ReturnDispositionGroup): string[] {
  return Object.entries(RETURN_DISPOSITION_CODES)
    .filter(([, value]) => value === group)
    .map(([code]) => code)
}

// ---- 退款与收货先后 ----

const timeOf = (value: string | Date) => (value instanceof Date ? value.getTime() : Date.parse(value))

/**
 * 退款与收货的先后：没有任何财务交易说不清（待财务交易）；有交易但没有退款类交易是无退款；
 * 有退款时，第一笔退款早于（或同时于）收到退货的时间是“退款后已收到”，否则是“收到退货后才退款”。
 */
export function returnReceiptState(refund: { state: OrderRefundState }, firstRefundAt: string | Date | null, returnDate: string | Date): { state: ReturnReceiptState; label: string } {
  let state: ReturnReceiptState
  if (refund.state === 'PENDING_DATA') state = 'PENDING_DATA'
  else if (refund.state === 'NONE' || !firstRefundAt) state = 'NO_REFUND'
  else state = timeOf(firstRefundAt) <= timeOf(returnDate) ? 'RECEIVED_AFTER_REFUND' : 'REFUNDED_AFTER_RECEIPT'
  return { state, label: RETURN_RECEIPT_LABEL[state] }
}

// ---- 赔付 ----

/**
 * 赔付状态：报告处理状态写明已赔付（Reimbursed）时是亚马逊已赔付；已关联赔付案件的显示已建案件；
 * 其余看赔付列：默认 NOT_REVIEWED 是尚未核查（赔付中心 P2b-03 上线后由 7 条规则自动识别），其他值原样视为处理中。
 */
export function returnReimbursementView(input: {
  reimbursementStatus: string | null | undefined
  reportStatus: string | null | undefined
  reimbursementCaseId: string | null | undefined
}): ReturnReimbursementView {
  const caseId = input.reimbursementCaseId ?? null
  let state: ReturnReimbursementView['state']
  if (input.reportStatus && /reimburs/i.test(input.reportStatus)) state = 'AMAZON_REIMBURSED'
  else if (caseId) state = 'CASE_LINKED'
  else if (!input.reimbursementStatus || input.reimbursementStatus === 'NOT_REVIEWED') state = 'NOT_REVIEWED'
  else state = 'OTHER'
  return { state, label: RETURN_REIMBURSEMENT_LABEL[state], caseId }
}

// ---- 退货率与分桶 ----

/** 退货率 = 退货件数 ÷ 销售件数；销售件数没有（尚未汇总）或为 0 时没有意义，返回 null，不返回 0。 */
export function returnRate(returned: number, sold: number | null | undefined): number | null {
  if (sold === null || sold === undefined || sold <= 0) return null
  return Math.round((returned / sold) * 10_000) / 10_000
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayText = (value: number) => new Date(value).toISOString().slice(0, 10)

/** 时间范围不超过 120 天按周看，更长按月看。 */
export function chooseBucket(from: string, to: string): ReturnBucket {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1 <= 120 ? 'WEEK' : 'MONTH'
}

/** 日期所在桶的起始日：周为周一，月为 1 日。 */
export function bucketStart(day: string, bucket: ReturnBucket): string {
  if (bucket === 'MONTH') return `${day.slice(0, 7)}-01`
  const weekday = new Date(dayMs(day)).getUTCDay()
  return dayText(dayMs(day) - ((weekday + 6) % 7) * DAY_MS)
}

/** 范围内全部桶的起始日（含首尾，按时间升序），没有数据的桶也会出现，趋势图才不会漏掉空周。 */
export function bucketsOf(from: string, to: string, bucket: ReturnBucket): string[] {
  const result: string[] = []
  let cursor = bucketStart(from, bucket)
  const last = bucketStart(to, bucket)
  while (cursor <= last && result.length < 400) {
    result.push(cursor)
    cursor = bucket === 'MONTH' ? bucketStart(dayText(dayMs(cursor) + 32 * DAY_MS), 'MONTH') : dayText(dayMs(cursor) + 7 * DAY_MS)
  }
  return result
}

/**
 * 趋势点：每个桶的退货件数与销售件数。soldByDay 为 null 表示完全没有销售汇总（销售件数、退货率都为空）；
 * 有汇总但某桶没有行时销售件数同样为空（不是 0）。
 */
export function trendOf(input: { from: string; to: string; bucket: ReturnBucket; returnedByDay: ReadonlyMap<string, number>; soldByDay: ReadonlyMap<string, number> | null }): ReturnTrendPoint[] {
  const returned = new Map<string, number>()
  const sold = new Map<string, number>()
  for (const [day, units] of input.returnedByDay) {
    const key = bucketStart(day, input.bucket)
    returned.set(key, (returned.get(key) ?? 0) + units)
  }
  if (input.soldByDay) {
    for (const [day, units] of input.soldByDay) {
      const key = bucketStart(day, input.bucket)
      sold.set(key, (sold.get(key) ?? 0) + units)
    }
  }
  return bucketsOf(input.from, input.to, input.bucket).map(bucket => {
    const returnedUnits = returned.get(bucket) ?? 0
    const soldUnits = input.soldByDay ? (sold.get(bucket) ?? null) : null
    return { bucket, returnedUnits, soldUnits, rate: returnRate(returnedUnits, soldUnits) }
  })
}

/** 退款入账至今的整天数（不足一天为 0）。 */
export function daysSince(at: string | Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - timeOf(at)) / DAY_MS))
}

/** 报告原因列为空时的归并键。 */
export const UNSPECIFIED_REASON = 'UNSPECIFIED'
export const normalizeReason = (reason: string | null | undefined) => (reason && reason.trim() ? reason.trim() : UNSPECIFIED_REASON)
