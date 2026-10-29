import { ALERT_UNREAD_STATUSES } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'

// 预警“未读”的统一口径（P6-15）：预警列表、顶栏铃铛、批量标记已读都用同一条件，避免两处数字对不上。
// 只算待处理（新预警、处理中）的预警：已处理、已忽略、已恢复的预警不再提醒；已读按用户记录在 AlertRead 里，与处理状态互不影响。

/** 我还没读的待处理预警；调用方再叠加企业与数据范围条件。 */
export const unreadAlertWhere = (userId: string): Prisma.AlertInstanceWhereInput => ({
  status: { in: [...ALERT_UNREAD_STATUSES] },
  reads: { none: { userId } },
})

/** 我已读的预警（不限处理状态）。 */
export const readAlertWhere = (userId: string): Prisma.AlertInstanceWhereInput => ({ reads: { some: { userId } } })
