import { ECONOMICS_DATASET_PREVIEW, ECONOMICS_PREVIEW_FEE_TYPES, ECONOMICS_PREVIEW_QUERY_DAYS } from '@nova/api-contracts'
import type { RowOutcome } from '../streaming/batch'
import type { Row } from '../streaming/rows'
import type { ImportContext } from '../types'
import { count, dateOf, DATE_PATTERN, get, money, quote, unwrapRecord } from './json'
import { registerDataKioskDataset, type DataKioskDataset, type KioskScope } from './registry'

// 数据中心“官方费用预览”数据集（P2b-11，importers.md D-05）：economicsPreview 给出未来最多 120 天的费用预估，
// 区间内有亚马逊费用调整日时，官方把区间拆成调整前后两段，并给出单件费用的变化。
// 字段对照官方 schema（analytics_economics_2024_03_15.graphql，2026 年 10 月）：
//   economicsPreview(marketplaceIds, startDate, endDate, aggregateBy: { date: RANGE, productId: MSKU }, feeTypes) → EconomicsPreview
//   fees { feeTypeName charges { startDate endDate aggregatedDetail { totalAmount quantity amountPerUnit amountPerUnitDelta } } }
//   开始日期不得早于今天、结束日期不得晚于今天后 120 天；feeTypes 取官方枚举里的汇总类型。
// 未对照真实店铺核对结果行的实际形状：缺失字段一律当“官方没给”（null），不补 0。

const MARKETPLACE_ID = 'ATVPDKIKX0DER'

export function buildEconomicsPreviewQuery(params: Record<string, string>): string {
  const { startDate, endDate } = params
  if (!DATE_PATTERN.test(startDate ?? '') || !DATE_PATTERN.test(endDate ?? '')) throw new Error('ECONOMICS_PREVIEW_DATE_INVALID')
  const span = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (!(span >= 0) || span + 1 > ECONOMICS_PREVIEW_QUERY_DAYS) throw new Error('ECONOMICS_PREVIEW_DATE_INVALID')
  const amount = '{ amount currencyCode }'
  return `{ analytics_economics_2024_03_15 { economicsPreview(
    marketplaceIds: [${quote(MARKETPLACE_ID)}], startDate: ${quote(startDate)}, endDate: ${quote(endDate)}, aggregateBy: { date: RANGE, productId: MSKU },
    feeTypes: [${ECONOMICS_PREVIEW_FEE_TYPES.join(', ')}]
  ) { startDate endDate msku childAsin
      fees { feeTypeName charges { startDate endDate aggregatedDetail { totalAmount ${amount} quantity amountPerUnit ${amount} amountPerUnitDelta ${amount} } } }
  } } }`
}

export interface ParsedPreviewLine {
  msku: string
  asin: string | null
  feeType: string
  rangeStart: string
  rangeEnd: string
  estimatedAmount: number
  quantity: number | null
  amountPerUnit: number | null
  amountPerUnitDelta: number | null
  currency: string
}

/** 一行结果（一个 SKU）→ 若干行预览：每个费用类型下的每一段区间一行；没有金额的段无法使用，丢弃。 */
export function readPreviewLines(row: Row, fallback: { startDate: string; endDate: string }): ParsedPreviewLine[] {
  const item = unwrapRecord(row, 'analytics_economics_2024_03_15', 'economicsPreview')
  const msku = get(item, 'msku')
  if (typeof msku !== 'string' || msku.trim() === '') return []
  const asin = get(item, 'childAsin')
  const itemStart = dateOf(get(item, 'startDate')) ?? fallback.startDate
  const itemEnd = dateOf(get(item, 'endDate')) ?? fallback.endDate
  const lines = new Map<string, ParsedPreviewLine>()
  for (const fee of Array.isArray(get(item, 'fees')) ? (get(item, 'fees') as unknown[]) : []) {
    const feeType = get(fee, 'feeTypeName')
    if (typeof feeType !== 'string' || feeType === '') continue
    const charges = get(fee, 'charges')
    for (const charge of Array.isArray(charges) ? charges : []) {
      const total = money(get(charge, 'aggregatedDetail', 'totalAmount'))
      if (!total) continue
      const rangeStart = dateOf(get(charge, 'startDate')) ?? itemStart
      const rangeEnd = dateOf(get(charge, 'endDate')) ?? itemEnd
      lines.set(`${feeType}|${rangeStart}|${rangeEnd}`, {
        msku,
        asin: typeof asin === 'string' && asin !== '' ? asin : null,
        feeType,
        rangeStart,
        rangeEnd,
        estimatedAmount: total.amount,
        quantity: count(get(charge, 'aggregatedDetail', 'quantity')),
        amountPerUnit: money(get(charge, 'aggregatedDetail', 'amountPerUnit'))?.amount ?? null,
        amountPerUnitDelta: money(get(charge, 'aggregatedDetail', 'amountPerUnitDelta'))?.amount ?? null,
        currency: total.currency ?? 'USD',
      })
    }
  }
  return [...lines.values()]
}

async function handle(ctx: ImportContext, row: Row, scope: KioskScope, params: Record<string, string>): Promise<RowOutcome> {
  const lines = readPreviewLines(row, { startDate: params.startDate ?? '', endDate: params.endDate ?? '' })
  if (lines.length === 0) return 'skipped'
  const parsedQueried = new Date(params.queriedAt ?? '')
  const queriedAt = Number.isNaN(parsedQueried.getTime()) ? new Date() : parsedQueried
  for (const line of lines) {
    const rangeStart = new Date(`${line.rangeStart}T00:00:00Z`)
    const rangeEnd = new Date(`${line.rangeEnd}T00:00:00Z`)
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) continue
    const data = {
      asin: line.asin,
      estimatedAmount: line.estimatedAmount,
      quantity: line.quantity,
      amountPerUnit: line.amountPerUnit,
      amountPerUnitDelta: line.amountPerUnitDelta,
      currency: line.currency,
      queriedAt,
    }
    await ctx.prisma.economicsPreview.upsert({
      where: {
        tenantId_sellerAccountId_msku_feeType_rangeStart_rangeEnd: {
          tenantId: scope.tenantId,
          sellerAccountId: scope.sellerAccountId,
          msku: line.msku,
          feeType: line.feeType,
          rangeStart,
          rangeEnd,
        },
      },
      create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, msku: line.msku, feeType: line.feeType, rangeStart, rangeEnd, ...data },
      update: data,
    })
  }
  return 'imported'
}

export const economicsPreviewDataset: DataKioskDataset = {
  id: ECONOMICS_DATASET_PREVIEW,
  buildQuery: buildEconomicsPreviewQuery,
  handle,
  reportType: 'DATA_KIOSK_ECONOMICS_PREVIEW',
}

export function registerEconomicsPreview() {
  registerDataKioskDataset(economicsPreviewDataset)
}
