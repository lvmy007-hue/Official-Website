// 任务优先级（12.3）：用户触发 > 推送增量 > 定时 > 历史回补。数字越小越先执行，与 BullMQ 的 priority 语义一致。

export const PRIORITY = {
  USER_TRIGGERED: 1,
  PUSH_INCREMENT: 2,
  SCHEDULED: 3,
  BACKFILL: 4,
} as const

export type PriorityName = keyof typeof PRIORITY

export function isPriority(value: number): boolean {
  return Number.isInteger(value) && value >= PRIORITY.USER_TRIGGERED && value <= PRIORITY.BACKFILL
}

/** 同步任务的来源 → 优先级。手动触发最高；历史回补最低，不得挤占日常增量。 */
export function priorityForTrigger(trigger: string | null | undefined): number {
  switch (trigger) {
    case 'manual':
    case 'user':
      return PRIORITY.USER_TRIGGERED
    case 'push':
    case 'notification':
    case 'incremental':
      return PRIORITY.PUSH_INCREMENT
    case 'backfill':
    case 'history':
      return PRIORITY.BACKFILL
    default:
      return PRIORITY.SCHEDULED
  }
}
