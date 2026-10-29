import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'

// 采购、供应商、国内仓共用的小工具：日期与金额的文字表示、乐观锁与唯一键错误的统一翻译。

export const PO_READ = 'purchase.read'
export const PO_WRITE = 'purchase.order.write'
export const PO_APPROVE = 'purchase.order.approve'
export const PO_RECEIVE = 'purchase.receive'
export const PO_PAY = 'purchase.pay'
export const SUPPLIER_READ = 'supplier.read'
export const SUPPLIER_WRITE = 'supplier.write'
export const WAREHOUSE_READ = 'warehouse.read'
export const STOCK_COUNT_WRITE = 'warehouse.stockcount.write'
export const STOCK_COUNT_APPROVE = 'warehouse.stockcount.approve'

const DAY_MS = 86_400_000

export const dayText = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
export const isoText = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
export const parseDay = (text: string): Date => new Date(`${text}T00:00:00.000Z`)
/** 业务日期不能晚于“今天 + 1 天”（给时区留一天余量），防止录入未来日期。 */
export const assertNotFuture = (text: string, label: string, now: Date = new Date()) => {
  if (parseDay(text).getTime() > now.getTime() + DAY_MS) throw appError('VALIDATION_FAILED', `${label}不能晚于今天`, { fieldErrors: { [label]: ['不能晚于今天'] } })
}
export const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / DAY_MS)

/** 金额转文字：空值保持为空，不补 0。 */
export const moneyText = (value: Prisma.Decimal | number | string | null | undefined): string | null => (value === null || value === undefined ? null : value.toString())

export const ratioOf = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null)

/** 唯一键冲突（Prisma P2002）。 */
export const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

/** 状态不允许的操作：统一 409，并写明当前状态。 */
export const stateConflict = (message: string, status?: string) => appError('DATA_CONDITION_FAILED', message, status ? { details: { status } } : {})
