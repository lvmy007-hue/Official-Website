import { appendSyncEvent, syncResultStatsOf, type SyncTimelineStage } from '@nova/api-contracts'
import { Prisma, type PrismaClient } from '@prisma/client'

// 同步任务的过程记录（P5-06）：时间线（开始、等待重试、等待报告、完成、失败、取消）与写入统计，同步中心的任务详情读它们。
// 记录是辅助信息：写不进去（连接抖动、测试替身没有对应方法）不能让同步任务失败，所以这里的错误一律吞掉。

type Db = Pick<PrismaClient, 'syncJob'>

/** 追加一个事件到时间线（先读后写）；用于失败、重试等不在主流程更新里的路径。 */
export async function recordSyncEvent(prisma: Db, jobId: string, stage: SyncTimelineStage, text?: string, now: Date = new Date()): Promise<void> {
  try {
    const row = await prisma.syncJob.findUnique({ where: { id: jobId }, select: { timelineJson: true } })
    if (!row) return
    await prisma.syncJob.update({ where: { id: jobId }, data: { timelineJson: timelineOf(row.timelineJson, stage, text, now) } })
  } catch {
    // 记录失败不影响同步任务本身
  }
}

/** 在已有时间线上追加事件，返回可以直接写进 JSON 列的值（主流程更新时随状态一起写，省一次读写）。 */
export const timelineOf = (current: unknown, stage: SyncTimelineStage, text?: string, now: Date = new Date()): Prisma.InputJsonValue =>
  appendSyncEvent(current, stage, text, now) as unknown as Prisma.InputJsonValue

/** 同步器返回值里的数字统计，写进 JSON 列；没有数字时写 DbNull（不是空对象，页面据此写“尚无统计”）。 */
export function resultJsonOf(result: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const stats = syncResultStatsOf(result)
  return stats ? (stats as unknown as Prisma.InputJsonValue) : Prisma.DbNull
}
