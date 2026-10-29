import { Injectable } from '@nestjs/common'
import {
  ASIN360_CATEGORY_THEMES_NOTE,
  ASIN360_REIMBURSEMENT_LIMIT,
  ASIN360_REIMBURSEMENT_PERMISSION,
  ASIN360_RETURN_RECENT_LIMIT,
  ASIN360_RETURN_RULES,
  CASE_STATUS_LABEL,
  OPPORTUNITY_RULE_LABEL,
  OPPORTUNITY_STATUS_LABEL,
  RETURNS_FRESHNESS_KEY,
  RETURNS_PERMISSION,
  RETURN_DEFAULT_DAYS,
  RETURN_DISPOSITION_LABEL,
  ScopeSearchSchema,
  UNSPECIFIED_REASON,
  chooseBucket,
  normalizeReason,
  returnDispositionView,
  returnReasonLabel,
  returnRate,
  trendOf,
  type Asin360ReimbursementItem,
  type Asin360ReturnDispositionRow,
  type Asin360ReturnsResponse,
  type CaseStatus,
  type OpportunityRule,
  type OpportunityStatus,
  type ReturnDispositionGroup,
  type ReturnReasonRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { addDays, asDate, dateText, localDate, todayIn, validZone, zonedDayStart } from '../overview'
import { ProductAccessService } from './product-access.service'

const ROW_CAP = 20_000
const GROUP_CAP = 500
const TOP_REASONS = 15
const BASIS =
  '退货按店铺 × ASIN 统计（同一 ASIN 的多个 SKU 合在一起，与销售汇总口径一致）。退货率 = 退货件数（按退货日期） ÷ 销售件数（经营日汇总，按下单日），两者落在同一个时间桶里；' +
  '退货总是晚于销售，新上架或销量变化大的商品，短期退货率会偏离真实水平。销售件数没有汇总时显示“尚无记录”，不显示 0%。'
const NO_DATA_NOTE = '所选日期范围内这个商品尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）'
const RESTRICTED_NOTE = '没有赔付读取权限（reimbursements.read），不显示关联赔付'
const NO_REIMBURSEMENT_NOTE = '这个商品在退货相关的赔付规则（退款后没收到退货、退货被处置为损坏）下没有识别出机会；赔付扫描每 3 小时运行一次，没有记录不代表不能赔付'

const reasonLabelOf = (reason: string) => (reason === UNSPECIFIED_REASON ? '未提供原因' : (returnReasonLabel(reason) ?? reason))
const share = (units: number, total: number) => (total > 0 ? Math.round((units / total) * 10_000) / 10_000 : 0)
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

// ASIN 360“退货”页签（P2b-17，05 章 5.2 第 6 页签）：退货率趋势、原因分布、处置状态、最近退货、关联赔付。
// 口径沿用退货页（P2b-02）：退货明细来自客户退货报告 R-26，销售件数来自经营日汇总；所有数字都收窄到这个商品所在的店铺 × ASIN。
@Injectable()
export class ProductReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async returns(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360ReturnsResponse> {
    const { context, scope, product } = await this.access.resolve(req, id, RETURNS_PERMISSION)
    const query = ScopeSearchSchema.parse(rawQuery)
    const { tenantId } = context
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? todayIn(zone, now)
    const from = query.from ?? addDays(to, 1 - RETURN_DEFAULT_DAYS)
    const bucket = chooseBucket(from, to)
    const own = { tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin }
    const where = { ...own, returnDate: { gte: zonedDayStart(from, zone), lt: zonedDayStart(addDays(to, 1), zone) } }

    const [total, reasonGroups, dispositionGroups, detail, recent, soldDaily, freshness, reimbursements] = await Promise.all([
      this.prisma.fbaReturnCase.aggregate({ where, _sum: { quantity: true } }),
      this.prisma.fbaReturnCase.groupBy({ by: ['reason'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_CAP }),
      this.prisma.fbaReturnCase.groupBy({ by: ['disposition', 'detailedDisposition'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_CAP }),
      this.prisma.fbaReturnCase.findMany({ where, select: { returnDate: true, quantity: true }, orderBy: { returnDate: 'desc' }, take: ROW_CAP }),
      this.prisma.fbaReturnCase.findMany({
        where,
        select: { id: true, returnDate: true, amazonOrderId: true, sellerSku: true, quantity: true, reason: true, disposition: true, detailedDisposition: true },
        orderBy: [{ returnDate: 'desc' }, { id: 'asc' }],
        take: ASIN360_RETURN_RECENT_LIMIT,
      }),
      this.prisma.asinDailySummary.groupBy({
        by: ['summaryDate'],
        where: { tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin, summaryDate: { gte: asDate(from), lte: asDate(to) } },
        _sum: { units: true },
        orderBy: { summaryDate: 'asc' },
        take: 1200,
      }),
      sourceFreshness(this.prisma, tenantId, scope, [RETURNS_FRESHNESS_KEY, 'finance.transactions'], now),
      hasPermission(context.permissions, ASIN360_REIMBURSEMENT_PERMISSION) ? this.reimbursements(tenantId, product.sellerAccountId, product.asin) : Promise.resolve(null),
    ])

    const returnedUnits = total._sum.quantity ?? 0
    const soldByDay = soldDaily.length > 0 ? new Map(soldDaily.map(row => [dateText(row.summaryDate), row._sum.units ?? 0])) : null
    const soldTotal = soldByDay ? [...soldByDay.values()].reduce((sum, units) => sum + units, 0) : null
    const returnedByDay = new Map<string, number>()
    for (const row of detail) {
      const day = localDate(row.returnDate, zone)
      returnedByDay.set(day, (returnedByDay.get(day) ?? 0) + row.quantity)
    }
    const mergedReasons = new Map<string, number>()
    for (const group of reasonGroups) mergedReasons.set(normalizeReason(group.reason), (mergedReasons.get(normalizeReason(group.reason)) ?? 0) + (group._sum.quantity ?? 0))
    const reasons: ReturnReasonRow[] = [...mergedReasons.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, TOP_REASONS)
      .map(([reason, units]) => ({ reason, label: reasonLabelOf(reason), units, share: share(units, returnedUnits) }))
    const byGroup = new Map<ReturnDispositionGroup, number>()
    for (const group of dispositionGroups) {
      const view = returnDispositionView(group.detailedDisposition, group.disposition)
      byGroup.set(view.group, (byGroup.get(view.group) ?? 0) + (group._sum.quantity ?? 0))
    }
    const dispositions: Asin360ReturnDispositionRow[] = [...byGroup.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([group, units]) => ({ group, label: RETURN_DISPOSITION_LABEL[group], units, share: share(units, returnedUnits) }))

    const empty = returnedUnits === 0 && detail.length === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      range: { from, to, defaulted },
      bucket,
      totals: { returnedUnits, soldUnits: soldTotal, rate: returnRate(returnedUnits, soldTotal) },
      trend: empty ? [] : trendOf({ from, to, bucket, returnedByDay, soldByDay }),
      reasons,
      dispositions,
      recent: recent.map(row => ({
        id: row.id,
        returnDate: row.returnDate.toISOString(),
        amazonOrderId: row.amazonOrderId,
        sku: row.sellerSku,
        quantity: row.quantity,
        reasonLabel: row.reason ? (returnReasonLabel(row.reason) ?? row.reason) : null,
        disposition: returnDispositionView(row.detailedDisposition, row.disposition),
      })),
      reimbursements: reimbursements ?? { state: 'RESTRICTED', note: RESTRICTED_NOTE, items: [] },
      categoryThemes: { state: 'NOT_CONNECTED', note: ASIN360_CATEGORY_THEMES_NOTE },
      truncated: detail.length >= ROW_CAP,
      basis: BASIS,
      freshness,
    }
  }

  /** 关联赔付：这个 ASIN 下各 SKU 的退货类赔付机会（退款后没收到退货、退货被处置为损坏），带已立的案件。 */
  private async reimbursements(tenantId: string, sellerAccountId: string, asin: string): Promise<Asin360ReturnsResponse['reimbursements']> {
    const siblings = await this.prisma.fbaProduct.findMany({ where: { tenantId, sellerAccountId, asin }, select: { sellerSku: true }, orderBy: { sellerSku: 'asc' }, take: 200 })
    const skus = siblings.map(item => item.sellerSku)
    const rows =
      skus.length === 0
        ? []
        : await this.prisma.reimbursementOpportunity.findMany({
            where: { tenantId, sellerAccountId, sku: { in: skus }, ruleCode: { in: [...ASIN360_RETURN_RULES] } },
            select: {
              id: true,
              ruleCode: true,
              status: true,
              estimatedAmount: true,
              currency: true,
              deadlineAt: true,
              qty: true,
              cases: { select: { id: true, caseNo: true, status: true, receivedAmount: true }, take: 1 },
            },
            orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }],
            take: ASIN360_REIMBURSEMENT_LIMIT,
          })
    const items = rows.map((row): Asin360ReimbursementItem => {
      const rule = row.ruleCode as OpportunityRule
      const status = row.status as OpportunityStatus
      const linked = row.cases[0] ?? null
      return {
        id: row.id,
        ruleCode: rule,
        ruleLabel: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode,
        status: row.status,
        statusLabel: OPPORTUNITY_STATUS_LABEL[status] ?? row.status,
        estimatedAmount: num(row.estimatedAmount),
        currency: row.currency,
        deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString().slice(0, 10) : null,
        qty: row.qty,
        caseId: linked?.id ?? null,
        caseNo: linked?.caseNo ?? null,
        caseStatusLabel: linked ? (CASE_STATUS_LABEL[linked.status as CaseStatus] ?? linked.status) : null,
        receivedAmount: linked ? num(linked.receivedAmount) : null,
      }
    })
    return items.length === 0 ? { state: 'NO_DATA', note: NO_REIMBURSEMENT_NOTE, items } : { state: 'OK', note: null, items }
  }
}
