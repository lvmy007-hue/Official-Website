import { Injectable } from '@nestjs/common'
import {
  ASIN360_PREVIEW_LIMIT,
  ECONOMICS_COMPARE_FRESHNESS_KEYS,
  ECONOMICS_OURS_CURRENCY,
  ECONOMICS_PREVIEW_FRESHNESS_KEYS,
  ECONOMICS_PREVIEW_STALE_DAYS,
  compareDays,
  summarizeCompare,
  type Asin360PreviewResponse,
  type ComparedRow,
  type EconomicsCompareRow,
  type EconomicsCompareSummary,
  type InventoryFreshness,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { dateText } from '../overview'
import { compareText } from './economics-page'
import { loadCompare } from './economics-load'
import { PREVIEW_NO_DATA_NOTE, PREVIEW_STALE_NOTE, previewHorizon, previewNotes, previewRowOf, sortPreviewRows, summarizePreview } from './economics-preview-view'

const TRUNCATED_NOTE = '这个商品的费用预览行数超过读取上限，列表不完整'
const MISSING_SKU_NOTE = (day: string) => `官方最近一次费用预览（${day}）里没有这个 SKU：可能这个商品没有被查询覆盖，或还不在官方的费用预览范围内；没有记录时不估算，也不显示成 0`

export interface SkuTarget {
  tenantId: string
  scope: ResolvedScope
  sellerAccountId: string
  storeName: string
  sku: string
}

export interface SkuCompare {
  rows: EconomicsCompareRow[]
  summary: Omit<EconomicsCompareSummary, 'ads'>
  coverage: { from: string; to: string } | null
  truncated: boolean
  freshness: InventoryFreshness
}

// 一个商品（店铺 × SKU）的官方经济数据：双源核对与费用预览（P2b-17，供 ASIN 360 的“利润与成本”页签）。
// 取数与口径沿用 P2b-11（loadCompare、compareDays、previewRowOf），这里只是收窄到一个商品；权限与范围由调用方（商品准入）先检查。
@Injectable()
export class EconomicsSkuService {
  constructor(private readonly prisma: PrismaService) {}

  async compare(target: SkuTarget, input: { basis: string; from: string; to: string; now?: Date }): Promise<SkuCompare> {
    const { tenantId, scope, sellerAccountId, storeName, sku } = target
    const [loaded, freshness] = await Promise.all([
      loadCompare(this.prisma, { tenantId, scope, basis: input.basis, from: input.from, to: input.to, only: { sellerAccountId, sku } }),
      sourceFreshness(this.prisma, tenantId, scope, ECONOMICS_COMPARE_FRESHNESS_KEYS, input.now ?? new Date()),
    ])
    const all: ComparedRow[] = compareDays(loaded.candidates, { withCost: true })
    // 日期新的在前，同一天按键稳定排序
    const sorted = [...all].sort((a, b) => (a.date === b.date ? compareText(a.key, b.key) : compareText(b.date, a.date)))
    return {
      rows: sorted.map(row => ({ ...row, storeName })),
      summary: summarizeCompare(sorted),
      coverage: loaded.coverage,
      truncated: loaded.truncated,
      freshness,
    }
  }

  async preview(target: SkuTarget, now = new Date()): Promise<Asin360PreviewResponse> {
    const { tenantId, scope, sellerAccountId, storeName, sku } = target
    const since = new Date(now.getTime() - ECONOMICS_PREVIEW_STALE_DAYS * 86_400_000)
    const [latest, anyRow, freshness] = await Promise.all([
      this.prisma.economicsPreview.aggregate({ where: { tenantId, sellerAccountId, queriedAt: { gte: since } }, _max: { queriedAt: true } }),
      this.prisma.economicsPreview.findFirst({ where: { tenantId, sellerAccountId }, select: { id: true } }),
      sourceFreshness(this.prisma, tenantId, scope, ECONOMICS_PREVIEW_FRESHNESS_KEYS, now),
    ])
    const queriedAt = latest._max.queriedAt
    const rows = queriedAt
      ? await this.prisma.economicsPreview.findMany({
          where: { tenantId, sellerAccountId, msku: sku, queriedAt },
          orderBy: [{ feeType: 'asc' }, { rangeStart: 'asc' }],
          take: ASIN360_PREVIEW_LIMIT + 1,
        })
      : []
    const truncated = rows.length > ASIN360_PREVIEW_LIMIT
    const items = sortPreviewRows(rows.slice(0, ASIN360_PREVIEW_LIMIT).map(row => previewRowOf(row, storeName)))
    const empty = items.length === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: !empty ? null : !queriedAt ? (anyRow ? PREVIEW_STALE_NOTE : PREVIEW_NO_DATA_NOTE) : MISSING_SKU_NOTE(dateText(queriedAt)),
      currency: ECONOMICS_OURS_CURRENCY,
      queriedAt: queriedAt ? queriedAt.toISOString() : null,
      horizon: previewHorizon(items),
      summary: summarizePreview(items),
      items,
      notes: previewNotes(items, truncated, TRUNCATED_NOTE),
      freshness,
    }
  }
}
