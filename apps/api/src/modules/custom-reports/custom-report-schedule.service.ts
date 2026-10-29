import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { isReportDue, type ReportSchedule } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { permissionsOfRole, roleInclude } from '../auth'
import { CustomReportService } from './custom-report.service'

// 定时生成留在 API 进程：worker 镜像没有 API 的依赖注入，不能再写一套查询。
// 测试环境不启动。多个实例用版本号抢占同一小时，避免重复入队。时间按 UTC。

@Injectable()
export class CustomReportScheduleService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly system: SystemPrismaService,
    private readonly reports: CustomReportService,
  ) {}

  onModuleInit() {
    if (process.env.APP_MODE === 'test') return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 60_000)
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick(now = new Date()) {
    const rows = await this.system.customReport.findMany({ where: { schedule: { not: Prisma.DbNull } }, orderBy: { updatedAt: 'asc' }, take: 50 })
    for (const row of rows) {
      const schedule = readSchedule(row.schedule)
      if (!schedule || !isReportDue(schedule, now)) continue
      const claimed = await this.system.customReport.updateMany({
        where: { id: row.id, version: row.version },
        data: { schedule: { ...schedule, lastRunAt: now.toISOString() }, version: { increment: 1 } },
      })
      if (claimed.count === 0) continue
      // 失败不重试（本小时已被抢占），但把原因写回定时设置，页面能看到。
      const error = await this.fire(row.tenantId, row.ownerId, row.id).then(
        () => null,
        (cause: unknown) => (cause instanceof Error ? cause.message : '定时生成失败').slice(0, 200),
      )
      await this.system.customReport.updateMany({ where: { id: row.id, version: row.version + 1 }, data: { schedule: { ...schedule, lastRunAt: now.toISOString(), lastError: error } } })
    }
  }

  private async fire(tenantId: string, ownerId: string, reportId: string) {
    const membership = await this.system.membership.findFirst({ where: { tenantId, userId: ownerId, status: 'ACTIVE' }, include: roleInclude })
    if (!membership) throw new Error('报表所有人已不是企业有效成员')
    const req = {
      apiContext: {
        userId: ownerId,
        sessionId: 'custom-report-schedule',
        tenantId,
        membershipId: membership.id,
        permissions: permissionsOfRole(membership.role),
        accessMode: 'NORMAL' as const,
        lifecycleStatus: 'ACTIVE' as const,
      },
      params: {},
      header: () => undefined,
      headers: {},
    } as unknown as RequestWithContext
    await runWithTenant(tenantId, () => this.reports.run(req, reportId, {}, {}, { forceExport: true }))
  }
}

function readSchedule(value: unknown): ReportSchedule | null {
  if (!value || typeof value !== 'object') return null
  const row = value as ReportSchedule
  if ((row.frequency !== 'DAILY' && row.frequency !== 'WEEKLY') || typeof row.hour !== 'number') return null
  return row
}
