import {
  FEE_AUDIT_DIMENSION_TOLERANCE,
  FEE_AUDIT_EVIDENCE_LIMIT,
  maxSideDelta,
  roundMoney,
  sortedSides,
  volumeRatio,
  type FeeAuditBasis,
  type FeeAuditDims,
  type FeeAuditEvidenceLine,
  type FeeAuditKind,
  type SizeCm,
} from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 费用核查的公共部分（P2b-06）：扫描上下文、每个核查对象的结果结构、尺寸对比、证据明细汇总。
// 每类核查一个文件，只负责“算出每个对象的应收、实收与多收明细”；写入、清理与赔付机会标记走 write.ts。

export type AuditDb = Pick<
  PrismaClient,
  'fbaFeeEvent' | 'orderItem' | 'feeBaseline' | 'fbaProduct' | 'storageFeeRecord' | 'fbaFinancialTransaction' | 'fbaInboundShipment' | 'placementOption' | 'reimbursementOpportunity' | 'feeAudit'
>

export interface AuditContext {
  db: AuditDb
  tenantId: string
  now: Date
  /** 核查日：当天零点（UTC）。 */
  today: Date
  /** 费用事件窗口起点。 */
  since: Date
}

/** 一个核查对象的结果（一个 SKU，或入仓配置费的一个入仓计划）。金额都是正数（费用的绝对值）。 */
export interface AuditSubject {
  sellerAccountId: string
  subjectKey: string
  sku: string | null
  asin: string | null
  shipmentRef: string | null
  currency: string
  expected: number
  actual: number
  overcharge: number
  occurrences: number
  checkedCount: number
  firstSeenAt: Date | null
  lastSeenAt: Date | null
  basis: FeeAuditBasis
}

export interface AuditResult {
  kind: FeeAuditKind
  subjects: AuditSubject[]
  /** 读取数据触到上限：这一轮不清理本类里没再出现的旧结果。 */
  truncated: boolean
}

/** 单类核查读取的行数上限。 */
export const AUDIT_LIMIT = 20_000
export const DAY_MS = 86_400_000
/** 基准快照超过这个天数没有更新就不再使用（报告可能已经停止同步），避免拿过期的基准判定多收。 */
export const BASELINE_MAX_AGE_DAYS = 7

export const startOfDay = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
export const shiftDays = (value: Date, days: number) => new Date(startOfDay(value).getTime() + days * DAY_MS)
export const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

type BaselineDims = {
  lengthCm: { toString(): string } | null
  widthCm: { toString(): string } | null
  heightCm: { toString(): string } | null
  weightKg: { toString(): string } | null
  sizeTier: string | null
  prevSizeTier: string | null
}
type ProductDims = {
  sizeTier: string | null
  packageLengthCm: { toString(): string } | null
  packageWidthCm: { toString(): string } | null
  packageHeightCm: { toString(): string } | null
  packageWeightKg: { toString(): string } | null
}

const sizeOf = (a: unknown, b: unknown, c: unknown): SizeCm | null => sortedSides(num(a as never), num(b as never), num(c as never))

/** 亚马逊测量值与我方登记值的对比；两边都没有数据返回 null。 */
export function buildDims(baseline: BaselineDims | null | undefined, product: ProductDims | null | undefined): FeeAuditDims | null {
  const amazon = baseline ? sizeOf(baseline.lengthCm, baseline.widthCm, baseline.heightCm) : null
  const ours = product ? sizeOf(product.packageLengthCm, product.packageWidthCm, product.packageHeightCm) : null
  if (!amazon && !ours && !baseline?.sizeTier && !product?.sizeTier) return null
  return {
    amazon: amazon ? { ...amazon, weightKg: num(baseline?.weightKg) } : null,
    ours: ours ? { ...ours, weightKg: num(product?.packageWeightKg) } : null,
    volumeRatio: volumeRatio(amazon, ours),
    maxSideDelta: maxSideDelta(amazon, ours),
    tierAmazon: baseline?.sizeTier ?? null,
    tierOurs: product?.sizeTier ?? null,
    tierPrevious: baseline?.prevSizeTier ?? null,
  }
}

/** 尺寸不一致的提示文字（依据里写出，不下结论）。 */
export function dimsNote(dims: FeeAuditDims | null): string | null {
  if (!dims) return null
  const parts: string[] = []
  if (dims.maxSideDelta !== null && dims.maxSideDelta > FEE_AUDIT_DIMENSION_TOLERANCE) parts.push(`亚马逊测量尺寸与我方登记尺寸最多相差 ${Math.round(dims.maxSideDelta * 100)}%`)
  if (dims.volumeRatio !== null && dims.volumeRatio > 1 + FEE_AUDIT_DIMENSION_TOLERANCE) parts.push(`亚马逊测量体积是我方登记体积的 ${dims.volumeRatio.toFixed(2)} 倍`)
  if (dims.tierAmazon && dims.tierPrevious && dims.tierAmazon !== dims.tierPrevious) parts.push(`尺寸分段由“${dims.tierPrevious}”变为“${dims.tierAmazon}”`)
  if (dims.tierAmazon && dims.tierOurs && dims.tierAmazon.toLowerCase() !== dims.tierOurs.toLowerCase()) parts.push(`亚马逊尺寸分段“${dims.tierAmazon}”与商品记录的“${dims.tierOurs}”不同`)
  return parts.length > 0 ? parts.join('；') : null
}

export interface LineAccumulator {
  expected: number
  actual: number
  overcharge: number
  occurrences: number
  checked: number
  first: Date | null
  last: Date | null
  lines: FeeAuditEvidenceLine[]
}

export const emptyAccumulator = (): LineAccumulator => ({ expected: 0, actual: 0, overcharge: 0, occurrences: 0, checked: 0, first: null, last: null, lines: [] })

/** 累加一行核对：多收的行记入发生次数、累计差额与明细证据。 */
export function addLine(acc: LineAccumulator, line: { at: Date | null; ref: string | null; label: string; quantity: number | null; expected: number; actual: number; overcharge: number }) {
  acc.expected += line.expected
  acc.actual += line.actual
  acc.checked += 1
  if (line.overcharge <= 0) return
  acc.overcharge += line.overcharge
  acc.occurrences += 1
  if (line.at) {
    if (!acc.first || line.at < acc.first) acc.first = line.at
    if (!acc.last || line.at > acc.last) acc.last = line.at
  }
  acc.lines.push({
    at: line.at?.toISOString() ?? null,
    ref: line.ref,
    label: line.label,
    quantity: line.quantity,
    expected: roundMoney(line.expected),
    actual: roundMoney(line.actual),
    diff: roundMoney(line.overcharge),
  })
}

/** 明细证据按多收金额从大到小留前 N 条。 */
export const topLines = (lines: FeeAuditEvidenceLine[]) => [...lines].sort((a, b) => b.diff - a.diff).slice(0, FEE_AUDIT_EVIDENCE_LIMIT)

export function subjectOf(
  identity: Pick<AuditSubject, 'sellerAccountId' | 'subjectKey' | 'sku' | 'asin' | 'shipmentRef' | 'currency'>,
  acc: LineAccumulator,
  basis: Omit<FeeAuditBasis, 'lines'>,
): AuditSubject {
  return {
    ...identity,
    expected: roundMoney(acc.expected),
    actual: roundMoney(acc.actual),
    overcharge: roundMoney(acc.overcharge),
    occurrences: acc.occurrences,
    checkedCount: acc.checked,
    firstSeenAt: acc.first,
    lastSeenAt: acc.last,
    basis: { ...basis, lines: topLines(acc.lines) },
  }
}

const keyOf = (sellerAccountId: string, sku: string) => `${sellerAccountId}|${sku}`
export { keyOf as skuKeyOf }

/** 每个店铺每个 SKU 最近一份基准快照（只取最近 BASELINE_MAX_AGE_DAYS 天内的，要求 field 列有值）。 */
export async function latestBaselines(ctx: AuditContext, field: 'expectedFulfillmentFee' | 'expectedReferralFee' | 'lengthCm') {
  const rows = await ctx.db.feeBaseline.findMany({
    where: { tenantId: ctx.tenantId, snapshotDate: { gte: shiftDays(ctx.today, -BASELINE_MAX_AGE_DAYS) }, [field]: { not: null } },
    orderBy: { snapshotDate: 'desc' },
    take: AUDIT_LIMIT + 1,
  })
  const truncated = rows.length > AUDIT_LIMIT
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows.slice(0, AUDIT_LIMIT)) {
    const key = keyOf(row.sellerAccountId, row.sku)
    if (!latest.has(key)) latest.set(key, row)
  }
  return { latest, truncated }
}

/** 这些 SKU 的商品记录（我方登记的包装尺寸与尺寸分段）。 */
export async function loadProducts(ctx: AuditContext, skus: readonly string[]) {
  const out = new Map<string, Awaited<ReturnType<AuditDb['fbaProduct']['findMany']>>[number]>()
  for (const part of chunked([...new Set(skus)], 500)) {
    const rows = await ctx.db.fbaProduct.findMany({ where: { tenantId: ctx.tenantId, sellerSku: { in: part } }, take: 5000 })
    for (const row of rows) out.set(keyOf(row.sellerAccountId, row.sellerSku), row)
  }
  return out
}
