import { Injectable } from '@nestjs/common'
import {
  InventoryListQuerySchema,
  availableInventoryOf,
  describeBusinessRule,
  splitBatchTerms,
  type InventoryListResponse,
  type InventoryPolicyResponse,
  type InventorySummaryResponse,
  POLICY_NOT_CONFIGURED_NOTE,
  ScopeQuerySchema,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { inventoryFreshness } from './inventory-freshness'
import { InventoryLoaderService } from './inventory-loader.service'
import { InventoryPolicyService } from './inventory-policy.service'
import { buildSummary, inTab, matchesTerms, matchesText, sortRows } from './inventory-summary'

const PERMISSION = 'inventory.read'
const FEE_MONTHS = 6

/** 当月之前的 N 个自然月（含上月），旧的在前，格式 YYYY-MM-01。 */
export function previousMonths(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  return Array.from({ length: count }, (_, index) => {
    const offset = count - index
    const total = year * 12 + (month - 1) - offset
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
  })
}

// 库存健康（06 章 6.1）：列表（7 个页签）与顶部指标卡、图表。风险等级由规则引擎按当前生效的补货策略版本算出，
// 范围内库存记录一次读入内存后筛选、排序、分页（上限见 INVENTORY_LOAD_LIMIT，超出时 truncated=true）。
@Injectable()
export class InventoryHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  private async loadAll(tenantId: string, scope: ResolvedScope) {
    const today = await this.policies.todayOf(tenantId)
    const policy = await this.policies.currentOf(tenantId, today)
    const { items, truncated } = await this.loader.load({ tenantId, scope, today, policy })
    return { today, policy, rows: items.map(item => item.row), truncated }
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<InventoryListResponse> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    const query = InventoryListQuerySchema.parse(rawQuery)
    const { policy, rows, truncated } = await this.loadAll(context.tenantId, scope)
    const tab = query.tab ?? 'all'
    const terms = new Set((splitBatchTerms(query.qs) ?? []).map(term => term.toLowerCase()))
    const filtered = rows.filter(row => inTab(row, tab) && matchesText(row, query.q) && matchesTerms(row, terms) && (!query.risk || row.assessment.risk === query.risk))
    const sorted = sortRows(filtered, query.sort)
    const start = (query.page - 1) * query.pageSize
    // 可用库存按企业业务口径里勾选的组成项相加（P6-31）
    const rules = (await loadActiveMetrics(this.prisma, context.tenantId)).rules
    const rule = rules.config.availableInventory
    const items = sorted.slice(start, start + query.pageSize).map(row => ({
      ...row,
      quantity: {
        ...row.quantity,
        available: availableInventoryOf(rule, {
          sellable: row.quantity.sellable,
          reserved: row.quantity.reserved,
          inboundWorking: row.quantity.inboundWorking,
          inboundShipped: row.quantity.inboundShipped,
          inboundReceiving: row.quantity.inboundReceiving,
        }),
      },
    }))
    return {
      items,
      availableInventory: { ...rules.ref, text: describeBusinessRule('availableInventory', rule) },
      page: query.page,
      pageSize: query.pageSize,
      total: sorted.length,
      tab,
      policyState: policy ? 'OK' : 'NOT_CONNECTED',
      policyNote: policy ? null : POLICY_NOT_CONFIGURED_NOTE,
      truncated,
      freshness: await inventoryFreshness(this.prisma, context.tenantId, scope),
    }
  }

  async summary(req: RequestWithContext, rawQuery: Record<string, string>): Promise<InventorySummaryResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    ScopeQuerySchema.parse(rawQuery)
    const { today, policy, rows, truncated } = await this.loadAll(context.tenantId, scope)
    const stores = await this.prisma.sellerAccount.findMany({
      where: { tenantId: context.tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true, displayName: true },
      take: 500,
    })
    const months = previousMonths(today, FEE_MONTHS)
    const fees = await this.prisma.storageFeeRecord.groupBy({
      by: ['chargeMonth', 'feeKind'],
      where: { tenantId: context.tenantId, ...storeWhere(scope), chargeMonth: { gte: new Date(`${months[0]}T00:00:00Z`) }, feeKind: { in: ['STORAGE', 'OVERAGE', 'LONGTERM'] } },
      _sum: { amount: true },
    })
    const feeMonths = months.map(month => {
      const sumOf = (kind: string) =>
        fees.filter(row => row.chargeMonth.toISOString().slice(0, 10) === month && row.feeKind === kind).reduce((total, row) => total + Number(row._sum.amount?.toString() ?? 0), 0)
      return { month: month.slice(0, 7), storage: round2(sumOf('STORAGE')), overage: round2(sumOf('OVERAGE')), longTerm: round2(sumOf('LONGTERM')) }
    })
    return {
      ...buildSummary(rows, { policyVersion: policy?.versionNo ?? null, truncated, stores: new Map(stores.map(store => [store.id, store.displayName])), feeMonths }),
      freshness: await inventoryFreshness(this.prisma, context.tenantId, scope),
    }
  }

  rules(req: RequestWithContext): Promise<InventoryPolicyResponse> {
    return this.policies.read(req)
  }
}

const round2 = (value: number) => Math.round(value * 100) / 100
