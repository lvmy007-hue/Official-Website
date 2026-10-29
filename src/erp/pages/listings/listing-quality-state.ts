import { LISTING_QUALITY_WRITE, type ListingQualityTab, type ListingWriteStatus } from '@nova/api-contracts'
import type { GuardInput } from '../../components'

// 刊登质量页的筛选与动作守卫（P4-10）。

export interface QualityFilters {
  severity?: string
  status?: string
  impact?: string
}

export const PAGE_SIZES = [20, 50, 100] as const

/** 只有问题类页签有严重程度、状态、影响筛选；其余页签没有。 */
export const FILTERED_TABS: ReadonlySet<ListingQualityTab> = new Set<ListingQualityTab>(['issues', 'suppressed', 'missing'])

/** 把服务端判断的写入通道状态转成动作守卫的输入：卡在连接或开关时写明原因并给出前往处理的入口。 */
export function guardOf(status: ListingWriteStatus | undefined): GuardInput {
  if (!status || status.allowed || status.step === 'PERMISSION' || !status.step) return { permission: LISTING_QUALITY_WRITE }
  const fix = status.remedyPath ? { label: status.step === 'SWITCH' ? '前往开启' : '前往连接中心', href: status.remedyPath } : undefined
  return {
    permission: LISTING_QUALITY_WRITE,
    ...(status.step === 'CONNECTION' ? { connection: { ok: false, reason: status.reason ?? undefined, fix } } : {}),
    ...(status.step === 'SWITCH' ? { writeSwitch: { enabled: false, fix } } : {}),
  }
}

/** 各页签的空状态说明（服务端没有给 note 时使用）。 */
export const EMPTY_TEXT = '当前条件下没有记录'

export const SEVERITY_COLOR: Record<string, string> = { ERROR: 'red', WARNING: 'gold' }
