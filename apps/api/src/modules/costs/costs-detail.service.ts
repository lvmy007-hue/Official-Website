import { Injectable } from '@nestjs/common'
import { COST_TIMELINE_LIMIT, CostCompareQuerySchema, compareVersions, daysBetween, pricingOf, type CostCompareResponse, type CostDetailResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { CostsAccessService, type CostAccess } from './costs-access.service'
import { COST_SELECT, loadClosedPeriods, tenantToday } from './costs-common'
import { loadRates, rateOf } from './costs-fx'
import { EMPTY_SUMMARY, rowOf } from './costs-row'
import { compositionOf, fxOf, valuationOf } from './costs-valuation'
import { liteWith, loadExtras, viewsOf } from './costs-version-view'

// 商品成本详情与版本对比（05 章 5.9）：版本时间线、来源、成本构成、按企业计价方法估算的库存成本。
// SKU 不在成员的数据范围内与不存在一样返回 404，不泄露它存在。

const COST_NOTES = [
  '成本版本按 SKU 记在企业层面（采购没有店铺归属）；草稿不参与利润，确认生效后才计价。',
  '同一成本项只要有入库批次（采购收货、头程分摊），利润就只按批次计价，手工与导入的价格版本不再参与；时间线里会标出被压过的版本。',
  '折合美元用今天的汇率估算，利润计价用的是销售当天的汇率，两者可以不同。',
  '关税目前只在这里记录与折算，利润分析暂未单列关税。',
  '已关账期间的利润不受成本变更影响：成本在已关账或关账中的日期上不能生效；要调整先重新开账。',
]

@Injectable()
export class CostsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CostsAccessService,
  ) {}

  private async visible(access: CostAccess, sku: string) {
    if (!(await this.access.skuVisible(access, sku))) throw appError('RESOURCE_NOT_FOUND', '没有这个 SKU，或不在你的数据范围内')
  }

  async detail(req: RequestWithContext, sku: string, now: Date = new Date()): Promise<CostDetailResponse> {
    const access = await this.access.read(req, {})
    const { tenantId, scope } = access
    await this.visible(access, sku)
    const today = await tenantToday(this.prisma, tenantId, now)
    const [rows, product, closed] = await Promise.all([
      this.prisma.costVersion.findMany({ where: { tenantId, sku }, select: COST_SELECT, orderBy: { versionNo: 'desc' }, take: COST_TIMELINE_LIMIT + 1 }),
      this.prisma.fbaProduct.findFirst({ where: { tenantId, sellerSku: sku, ...storeWhere(scope) }, select: { title: true, asin: true }, orderBy: { updatedAt: 'desc' } }),
      loadClosedPeriods(this.prisma, tenantId),
    ])
    const truncated = rows.length > COST_TIMELINE_LIMIT
    const shown = rows.slice(0, COST_TIMELINE_LIMIT)
    const extras = await loadExtras(this.prisma, tenantId, shown)
    const lites = shown.map(row => liteWith(row, extras))
    const currencies = new Set(lites.map(lite => lite.currency))
    const rates = await loadRates(this.prisma, tenantId, currencies, today)
    const actives = lites.filter(lite => lite.status === 'ACTIVE')
    const productFrom = actives.filter(lite => lite.product !== null && lite.effectiveFrom <= today).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]?.effectiveFrom ?? null
    const summary = {
      ...EMPTY_SUMMARY,
      activeCount: actives.length,
      draftCount: lites.filter(lite => lite.status === 'DRAFT').length,
      productEffectiveFrom: productFrom,
      lastChangedAt: shown.reduce<Date | null>((latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest), null),
    }
    const row = rowOf({ sku, title: product?.title ?? null, asin: product?.asin ?? null, versions: lites, summary, rates, today })
    const valuation = await valuationOf(this.prisma, { tenantId, scope, sku, actives, rates, today })
    return {
      sku,
      title: row.title,
      asin: row.asin,
      today,
      row,
      versions: viewsOf(shown, extras, closed),
      versionsTruncated: truncated,
      composition: compositionOf(row.parts),
      pricing: pricingOf(lites).basis,
      valuation,
      fx: fxOf(rates, row.parts),
      canWrite: access.canWrite,
      notes: COST_NOTES,
    }
  }

  async compare(req: RequestWithContext, sku: string, rawQuery: Record<string, string>, now: Date = new Date()): Promise<CostCompareResponse> {
    const access = await this.access.read(req, {})
    const query = CostCompareQuerySchema.parse(rawQuery)
    await this.visible(access, sku)
    const { tenantId } = access
    const found = await this.prisma.costVersion.findMany({ where: { tenantId, sku, id: { in: [query.a, query.b] } }, select: COST_SELECT, take: 2 })
    const first = found.find(item => item.id === query.a)
    const second = found.find(item => item.id === query.b)
    if (!first || !second) throw appError('RESOURCE_NOT_FOUND', '要对比的版本不存在，或不属于这个 SKU')
    const today = await tenantToday(this.prisma, tenantId, now)
    const extras = await loadExtras(this.prisma, tenantId, found)
    const [a, b] = [liteWith(first, extras), liteWith(second, extras)]
    const rates = await loadRates(this.prisma, tenantId, new Set([a.currency, b.currency]), today)
    const closed = await loadClosedPeriods(this.prisma, tenantId)
    const [viewA, viewB] = viewsOf([first, second], extras, closed)
    return {
      sku,
      a: viewA as NonNullable<typeof viewA>,
      b: viewB as NonNullable<typeof viewB>,
      rows: compareVersions(a, b, code => rateOf(rates, code)),
      sameCurrency: a.currency === b.currency,
      effectiveDays: daysBetween(a.effectiveFrom, b.effectiveFrom),
    }
  }
}
