import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'

// 头程物流共用的小工具：权限名、日期与金额的文字表示、唯一键错误与跨租户引用的统一翻译。

export const FM_READ = 'firstmile.read'
export const FM_WRITE = 'firstmile.write'
export const POLICY_WRITE = 'replenishment.policy.write'

const DAY_MS = 86_400_000

export const dayText = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
export const isoText = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
export const parseDay = (text: string): Date => new Date(`${text}T00:00:00.000Z`)
export const todayText = (now: Date = new Date()): string => now.toISOString().slice(0, 10)
export const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / DAY_MS)

/** 金额转文字：空值保持为空，不补 0。 */
export const moneyText = (value: Prisma.Decimal | number | string | null | undefined): string | null => (value === null || value === undefined ? null : value.toString())

/** 唯一键冲突（Prisma P2002）。 */
export const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

/** 状态不允许的操作：统一 409，并写明原因。 */
export const stateConflict = (message: string) => appError('DATA_CONDITION_FAILED', message)

/** 业务日期不能晚于“今天 + 1 天”（给时区留一天余量）。 */
export function assertNotFuture(text: string, label: string, field: string, now: Date = new Date()) {
  if (parseDay(text).getTime() > now.getTime() + DAY_MS) throw appError('VALIDATION_FAILED', `${label}不能晚于今天`, { fieldErrors: { [field]: [`${label}不能晚于今天`] } })
}
