import { Injectable } from '@nestjs/common'
import {
  BRIDGE_DEFS,
  BUSINESS_RULE_IMPACT,
  BUSINESS_RULE_KEYS,
  BUSINESS_RULE_LABEL,
  BUSINESS_RULES_WRITE,
  DEFAULT_BUSINESS_RULES,
  FINANCE_POLICY_WRITE,
  FORMULA_KEYS,
  INVENTORY_COMPONENTS,
  INVENTORY_COMPONENT_LABEL,
  METRIC_VERSION_LIMITS,
  METRIC_VERSION_READ,
  MULTI_SITE_TODAY_LABEL,
  MULTI_SITE_TODAY_MODES,
  MetricVersionListQuerySchema,
  NET_SALES_DEDUCTIONS,
  NET_SALES_DEDUCTION_LABEL,
  PROFIT_FORMULA_READ,
  WEEK_START_DAYS,
  WEEK_START_LABEL,
  describeBusinessRule,
  describeFormula,
  formulaTags,
  readBusinessRuleValue,
  type BusinessRuleCard,
  type BusinessRuleKey,
  type BusinessRulesResponse,
  type MetricKind,
  type MetricVersionList,
  type ProfitFormulaResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { dateText } from '../overview'
import { cleanConfig, nameKeysOf, VERSION_SELECT, viewOf } from './metric-versions-common'

const FORMULA_NOTE =
  '毛利润和毛利率按这张表实时计算，不改变净利润与利润率；修改要提交审批（沿用财务口径审批，发起人与审批人不能是同一人），审批通过后立即成为新的口径版本。已关账月份的快照记录当时的版本，不会被改写。'
const RULES_NOTE = '每项口径修改后形成新的口径版本，提交后由另一位有“修改财务口径”权限的成员审批；审批通过后全站读取同一个生效版本。已关账月份的快照记录当时的版本，不会被改写。'

const TEXT_OPTIONS: Readonly<Record<BusinessRuleKey, { options: Array<{ value: string; label: string }>; multiple: boolean }>> = {
  netSales: { options: NET_SALES_DEDUCTIONS.map(value => ({ value, label: NET_SALES_DEDUCTION_LABEL[value] })), multiple: true },
  availableInventory: { options: INVENTORY_COMPONENTS.map(value => ({ value, label: INVENTORY_COMPONENT_LABEL[value] })), multiple: true },
  weekStart: { options: WEEK_START_DAYS.map(value => ({ value, label: WEEK_START_LABEL[value] })), multiple: false },
  multiSiteToday: { options: MULTI_SITE_TODAY_MODES.map(value => ({ value, label: MULTI_SITE_TODAY_LABEL[value] })), multiple: false },
}

// 口径版本的读取（P6-31）：利润公式页、业务口径页、口径版本列表。
@Injectable()
export class MetricVersionsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private async snapshot(tenantId: string, kind: MetricKind, userId: string) {
    const [pendingRow, historyRows, latest] = await Promise.all([
      this.prisma.metricVersion.findFirst({ where: { tenantId, kind, status: 'PENDING_APPROVAL' }, select: VERSION_SELECT }),
      this.prisma.metricVersion.findMany({
        where: { tenantId, kind, status: { in: ['ACTIVE', 'RETIRED'] } },
        orderBy: { versionNo: 'desc' },
        take: METRIC_VERSION_LIMITS.historyMax,
        select: VERSION_SELECT,
      }),
      this.prisma.metricVersion.findFirst({ where: { tenantId, kind }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } }),
    ])
    const names = await memberNames(this.prisma, tenantId, [...historyRows.flatMap(row => nameKeysOf([row])), ...(pendingRow ? nameKeysOf([pendingRow]) : [])])
    return {
      pending: pendingRow ? viewOf(pendingRow, names, userId) : null,
      pendingRow,
      history: historyRows.map(row => viewOf(row, names, userId)),
      latestVersionNo: latest?.versionNo ?? 0,
    }
  }

  async formula(req: RequestWithContext): Promise<ProfitFormulaResponse> {
    const context = await this.context.authorize(req, PROFIT_FORMULA_READ)
    const tenantId = context.tenantId
    const [active, state] = await Promise.all([loadActiveMetrics(this.prisma, tenantId), this.snapshot(tenantId, 'PROFIT_FORMULA', context.userId)])
    const { config, ref, effectiveFrom } = active.formula
    const canWrite = hasPermission(context.permissions, FINANCE_POLICY_WRITE)
    return {
      current: { ...ref, config, tags: formulaTags(config), texts: describeFormula(config), effectiveFrom: effectiveFrom ? dateText(effectiveFrom) : null },
      pending: state.pending,
      rows: FORMULA_KEYS.map(key => ({
        key,
        label: BRIDGE_DEFS[key].label,
        direction: BRIDGE_DEFS[key].direction,
        inGross: config.gross.includes(key),
        inDenominator: config.denominator.includes(key),
      })),
      latestVersionNo: state.latestVersionNo,
      history: state.history,
      canWrite,
      canApprove: canWrite,
      writeBlockedReason: canWrite ? null : '提交与审批利润公式需要 finance.policy.write 权限（修改财务口径）',
      note: FORMULA_NOTE,
    }
  }

  async rules(req: RequestWithContext): Promise<BusinessRulesResponse> {
    const context = await this.context.authorize(req, METRIC_VERSION_READ)
    const tenantId = context.tenantId
    const [active, state] = await Promise.all([loadActiveMetrics(this.prisma, tenantId), this.snapshot(tenantId, 'BUSINESS_RULES', context.userId)])
    const pendingConfig = state.pendingRow ? cleanConfig(state.pendingRow.config) : null
    const cards: BusinessRuleCard[] = BUSINESS_RULE_KEYS.map(key => {
      const value = active.rules.config[key]
      const pendingRaw = pendingConfig && typeof pendingConfig === 'object' ? (pendingConfig as Record<string, unknown>)[key] : undefined
      const pendingValue = pendingRaw === undefined ? null : readBusinessRuleValue(key, pendingRaw)
      const changed = pendingValue !== null && JSON.stringify(pendingValue) !== JSON.stringify(value)
      return {
        key,
        label: BUSINESS_RULE_LABEL[key],
        value,
        valueText: describeBusinessRule(key, value),
        defaultText: describeBusinessRule(key, DEFAULT_BUSINESS_RULES[key]),
        impact: BUSINESS_RULE_IMPACT[key],
        ...TEXT_OPTIONS[key],
        pendingValue: changed ? pendingValue : null,
      }
    })
    const canWrite = hasPermission(context.permissions, BUSINESS_RULES_WRITE)
    return {
      current: { ...active.rules.ref, effectiveFrom: active.rules.effectiveFrom ? dateText(active.rules.effectiveFrom) : null },
      cards,
      pending: state.pending,
      latestVersionNo: state.latestVersionNo,
      history: state.history,
      canWrite,
      canApprove: hasPermission(context.permissions, FINANCE_POLICY_WRITE),
      writeBlockedReason: canWrite ? null : '修改业务口径需要 settings.business.write 权限',
      note: RULES_NOTE,
    }
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<MetricVersionList> {
    const context = await this.context.authorize(req, METRIC_VERSION_READ)
    const query = MetricVersionListQuerySchema.parse(rawQuery)
    const where = { tenantId: context.tenantId, ...(query.kind ? { kind: query.kind } : {}) }
    const [rows, total] = await Promise.all([
      this.prisma.metricVersion.findMany({ where, orderBy: [{ createdAt: 'desc' }, { versionNo: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: VERSION_SELECT }),
      this.prisma.metricVersion.count({ where }),
    ])
    const names = await memberNames(this.prisma, context.tenantId, nameKeysOf(rows))
    return { items: rows.map(row => viewOf(row, names, context.userId)), page: query.page, pageSize: query.pageSize, total }
  }
}
