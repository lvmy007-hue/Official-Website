import {
  ALLOCATION_BASES,
  ALLOCATION_BASIS_LABEL,
  FX_RATE_RULES,
  FX_RATE_RULE_LABEL,
  INVENTORY_COSTINGS,
  INVENTORY_COSTING_LABEL,
  INVENTORY_COSTING_SETTING,
  POLICY_KEY_LABEL,
  PROFIT_BASES,
  PROFIT_BASIS_LABEL,
  defaultPolicyWith,
  inventoryMethodOf,
  type PolicyCurrent,
  type PolicyFieldInfo,
  type PolicyKey,
  type PolicyStatus,
  type PolicyValues,
  type PolicyVersionView,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { dateText, todayIn, validZone } from '../overview'

// 财务口径各服务共用的小工具（P2b-15）：版本行的选择列与转换、当前口径、企业时区的今天、关账中与已关账的期间。

export const POLICY_SELECT = {
  id: true,
  versionNo: true,
  effectiveFrom: true,
  revenueRecognition: true,
  inventoryCostMethod: true,
  fxRateRule: true,
  adsAllocationMode: true,
  storeFeeAllocation: true,
  status: true,
  reason: true,
  version: true,
  createdBy: true,
  createdAt: true,
  decidedBy: true,
  decidedAt: true,
  decisionComment: true,
  replacedAt: true,
} satisfies Prisma.FinancePolicyVersionSelect
export type PolicyRecord = Prisma.FinancePolicyVersionGetPayload<{ select: typeof POLICY_SELECT }>

/** 既能传 PrismaService，也能传事务里的 tx。 */
export type Db = Prisma.TransactionClient | PrismaService

/** 数据库有检查约束，取值一定合法；这里只是把文本收窄成契约里的类型。 */
export const valuesOf = (row: PolicyRecord): PolicyValues => ({
  revenueRecognition: row.revenueRecognition as PolicyValues['revenueRecognition'],
  inventoryCostMethod: row.inventoryCostMethod as PolicyValues['inventoryCostMethod'],
  fxRateRule: row.fxRateRule as PolicyValues['fxRateRule'],
  adsAllocationMode: row.adsAllocationMode as PolicyValues['adsAllocationMode'],
  storeFeeAllocation: row.storeFeeAllocation as PolicyValues['storeFeeAllocation'],
})

export function viewOf(row: PolicyRecord, names: ReadonlyMap<string, string>, userId: string): PolicyVersionView {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status as PolicyStatus,
    effectiveFrom: dateText(row.effectiveFrom),
    ...valuesOf(row),
    reason: row.reason,
    version: row.version,
    createdBy: row.createdBy,
    createdByName: nameOrFormer(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: row.decidedBy ? nameOrFormer(names, row.decidedBy) : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionComment: row.decisionComment,
    withdrawn: row.status === 'REJECTED' && row.decidedBy === row.createdBy,
    mine: row.createdBy === userId,
    replacedAt: row.replacedAt ? row.replacedAt.toISOString() : null,
  }
}

/** 当前口径：最新的生效版本；没有就用系统默认口径，存货计价沿用企业设置里已有的值（早先手工写入的）。 */
export async function currentOf(db: Db, tenantId: string): Promise<PolicyCurrent> {
  const active = await db.financePolicyVersion.findFirst({ where: { tenantId, status: 'ACTIVE' }, orderBy: { versionNo: 'desc' }, select: POLICY_SELECT })
  if (active) return { source: 'VERSION', versionNo: active.versionNo, effectiveFrom: dateText(active.effectiveFrom), values: valuesOf(active), inventoryMethodValid: true }
  const setting = await db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: INVENTORY_COSTING_SETTING }, select: { valueJson: true } })
  const raw = setting?.valueJson
  const method = inventoryMethodOf(raw)
  return { source: 'DEFAULT', versionNo: 0, effectiveFrom: null, values: defaultPolicyWith(method ?? undefined), inventoryMethodValid: method !== null || raw === undefined || raw === null }
}

export async function tenantToday(db: Db, tenantId: string, now: Date = new Date()): Promise<string> {
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  return todayIn(validZone(tenant?.timezone), now)
}

export interface FrozenPeriod {
  storeName: string
  month: string
  start: string
  end: string
  status: string
}

/** 企业里所有关账中与已关账的期间：这些期间的利润日表不再重算，口径变化影响不到它们。 */
export async function loadFrozenPeriods(db: Db, tenantId: string): Promise<FrozenPeriod[]> {
  const rows = await db.accountingPeriod.findMany({
    where: { tenantId, status: { in: ['CLOSING', 'CLOSED'] } },
    select: { periodStart: true, periodEnd: true, status: true, sellerAccount: { select: { displayName: true } } },
    orderBy: { periodStart: 'desc' },
    take: 1000,
  })
  return rows.map(row => ({
    storeName: row.sellerAccount.displayName,
    month: dateText(row.periodStart).slice(0, 7),
    start: dateText(row.periodStart),
    end: dateText(row.periodEnd),
    status: row.status,
  }))
}

export const frozenPeriodOf = (periods: readonly FrozenPeriod[], day: string): FrozenPeriod | null => periods.find(period => period.start <= day && day <= period.end) ?? null

export const frozenMessage = (day: string, period: FrozenPeriod): string =>
  `生效日 ${day} 落在${period.status === 'CLOSED' ? '已关账' : '关账中'}的期间（${period.storeName} ${period.month}），已关账期间的数字不能被口径改变；请先重新开账，或把生效日改到未关账的日期`

export const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

const options = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) => values.map(value => ({ value, label: labels[value] }))

/** 每项口径的说明与使用情况：只有存货计价已被计算使用，其余登记在版本里，页面如实写“尚未使用”。 */
export function fieldInfos(): PolicyFieldInfo[] {
  const base = (key: PolicyKey) => ({ key, label: POLICY_KEY_LABEL[key] })
  return [
    {
      ...base('revenueRecognition'),
      description: '利润按哪一天确认收入：下单口径（订单创建日）、发货口径（订单发货日）、结算释放口径（财务交易已释放的入账日）。三种口径的利润日表都在计算。',
      consumer: 'RECORDED',
      consumerNote: '这里登记企业的正式口径；利润页仍可随时切换三种口径查看，默认口径暂未跟随本设置。',
      editable: true,
      options: options(PROFIT_BASES, PROFIT_BASIS_LABEL),
    },
    {
      ...base('inventoryCostMethod'),
      description: '销售成本怎么从入库批次里取：先进先出、移动加权平均、月末加权平均。',
      consumer: 'WIRED',
      consumerNote: '审批通过后写入企业设置，利润日表重算（最长 6 小时）与商品成本页的库存成本估算按它计价；已关账与关账中的期间不重算。',
      editable: true,
      options: options(INVENTORY_COSTINGS, INVENTORY_COSTING_LABEL),
    },
    {
      ...base('fxRateRule'),
      description: '成本与费用折美元用哪一天的汇率。目前只有一种规则，登记在版本里，以后增加规则时旧版本仍可复现。',
      consumer: 'WIRED',
      consumerNote: '利润计算已按这条规则折算；汇率来源与手工覆盖在“汇率”页管理。',
      editable: false,
      options: options(FX_RATE_RULES, FX_RATE_RULE_LABEL),
    },
    {
      ...base('adsAllocationMode'),
      description: '先按广告商品报表归属到 ASIN，剩余的账户级广告花费按销售额（默认）或销量分摊到商品。',
      consumer: 'WIRED',
      consumerNote: '利润日表重算（最长 6 小时）时按它分摊广告：每一天用当天生效的版本；已关账与关账中的期间不重算。广告商品报表没有覆盖的花费才按这条规则分摊。',
      editable: true,
      options: options(ALLOCATION_BASES, ALLOCATION_BASIS_LABEL),
    },
    {
      ...base('storeFeeAllocation'),
      description: '没有 SKU 的店铺级费用（例如订阅费）按销售额（默认）或销量分摊到商品。',
      consumer: 'WIRED',
      consumerNote:
        '店铺级费用的分摊已接入利润日表：在“费用分摊规则”页按费用项逐项配置（销售额、销量、货件签收量、移除订单、手动比例），按月生效，重算（最长 6 小时）后分摊到 SKU；已关账的期间不重算。这里登记的企业默认依据不会自动套给没有规则的费用项，它们仍留在店铺级行。',
      editable: true,
      options: options(ALLOCATION_BASES, ALLOCATION_BASIS_LABEL),
    },
  ]
}
