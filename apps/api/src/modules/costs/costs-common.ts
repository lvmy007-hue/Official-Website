import { COST_FUTURE_DAYS, type CostLite, type CostSource, type CostStatus } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { addDays, dateText, todayIn, validZone } from '../overview'

// 商品成本各服务共用的小工具（P2b-14）：成本版本的选择列、行转换、企业时区的“今天”、已关账期间的检查。

export const COST_SELECT = {
  id: true,
  sku: true,
  versionNo: true,
  effectiveFrom: true,
  currency: true,
  unitProductCost: true,
  unitFirstMileCost: true,
  unitDutyCost: true,
  unitOtherCost: true,
  source: true,
  status: true,
  sourceDocId: true,
  note: true,
  version: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  activatedBy: true,
  activatedAt: true,
  replacedById: true,
  replacedAt: true,
} satisfies Prisma.CostVersionSelect
export type CostRecord = Prisma.CostVersionGetPayload<{ select: typeof COST_SELECT }>

/** 既能传 PrismaService，也能传事务里的 tx。 */
export type Db = Prisma.TransactionClient | PrismaService

const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

/** 计算用的精简版本；quantity 是入库批次件数（没有为 null，按价格版本处理）。 */
export function liteOf(row: CostRecord, quantity: number | null = null): CostLite {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    source: row.source as CostSource,
    effectiveFrom: dateText(row.effectiveFrom),
    currency: row.currency,
    product: num(row.unitProductCost),
    firstMile: num(row.unitFirstMileCost),
    duty: num(row.unitDutyCost),
    other: num(row.unitOtherCost),
    quantity,
  }
}

export const statusOf = (value: string): CostStatus => (value === 'ACTIVE' || value === 'REPLACED' ? value : 'DRAFT')

/** 企业口径时区的今天。 */
export async function tenantToday(prisma: Db, tenantId: string, now: Date = new Date()): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const zone = validZone(tenant?.timezone)
  return todayIn(zone, now)
}

export const asDay = (day: string) => new Date(`${day}T00:00:00Z`)

/** 生效日期不能晚于今天太多：给下一次涨价预先登记，但不能写成很远的未来。 */
export function futureLimit(today: string): string {
  return addDays(today, COST_FUTURE_DAYS)
}

export interface ClosedPeriod {
  storeName: string
  month: string
  start: string
  end: string
  status: string
}

/** 企业里所有关账中与已关账的期间（成本版本没有店铺归属，任何店铺的关账期间都算）。 */
export async function loadClosedPeriods(prisma: Db, tenantId: string): Promise<ClosedPeriod[]> {
  const rows = await prisma.accountingPeriod.findMany({
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

/** 日期落在哪个关账期间里；没有为 null。 */
export const closedPeriodOf = (periods: readonly ClosedPeriod[], day: string): ClosedPeriod | null => periods.find(period => period.start <= day && day <= period.end) ?? null

export const closedMessage = (day: string, period: ClosedPeriod): string =>
  `生效日 ${day} 落在${period.status === 'CLOSED' ? '已关账' : '关账中'}的期间（${period.storeName} ${period.month}），成本不能在这个日期上生效或变动；请先重新开账，或把生效日改到未关账的日期`

/** 状态不允许的操作：统一 409，并写明原因。 */
export const stateConflict = (message: string) => appError('DATA_CONDITION_FAILED', message)

export const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

/** 取下一个版本号（同一个 SKU 内递增）。 */
export async function nextVersionNo(tx: Db, tenantId: string, sku: string): Promise<number> {
  const latest = await tx.costVersion.findFirst({ where: { tenantId, sku }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
  return (latest?.versionNo ?? 0) + 1
}
