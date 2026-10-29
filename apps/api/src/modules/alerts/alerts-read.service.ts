import { Injectable } from '@nestjs/common'
import { ALERTS_HANDLE, ALERTS_READ, AlertBatchHandleBodySchema, AlertReadBodySchema, type AlertBatchHandleResponse, type AlertReadResponse } from '@nova/api-contracts'
import { unreadAlertWhere } from '../../platform/alert-unread'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { AlertsActionsService } from './alerts-actions.service'

// 预警的已读与批量处理（P6-15）。
// - 已读按用户记录（AlertRead），只改我自己的状态，不改预警的处理状态，也不影响别人；预警不在我的数据范围内按“不存在”处理（不泄露是否真有这条）。
// - 批量标记已处理：逐条按“关闭，结论已处理”执行（沿用单条关闭的全部校验、待办同步、时间线与审计），各条互不影响；
//   已被他人处理、不在范围内的记入 skipped 并说明原因，不让整批失败。一次最多 ALERT_BATCH_MAX 条（契约）。
//   审计由单条关闭逐条写入（ALERT_CLOSED，带预警编号与前后状态），所以拦截器不再补写批量级的通用审计。
@Injectable()
export class AlertsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly actions: AlertsActionsService,
  ) {}

  private unreadOf(tenantId: string, userId: string, scope: ResolvedScope) {
    return this.prisma.alertInstance.count({ where: { tenantId, ...storeWhere(scope), ...unreadAlertWhere(userId) } })
  }

  async markRead(req: RequestWithContext, rawBody: unknown): Promise<AlertReadResponse> {
    // 先鉴权再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_READ, {})
    const ids = [...new Set(AlertReadBodySchema.parse(rawBody).ids)]
    const visible = await this.prisma.alertInstance.findMany({ where: { tenantId: context.tenantId, id: { in: ids }, ...storeWhere(scope) }, select: { id: true }, take: ids.length })
    const found = new Set(visible.map(row => row.id))
    const already = await this.prisma.alertRead.findMany({ where: { tenantId: context.tenantId, userId: context.userId, alertId: { in: [...found] } }, select: { alertId: true }, take: ids.length })
    const done = new Set(already.map(row => row.alertId))
    const fresh = [...found].filter(id => !done.has(id))
    // 并发时同一条被两个请求同时标记：唯一键冲突直接跳过，不报错
    const created =
      fresh.length > 0 ? await this.prisma.alertRead.createMany({ data: fresh.map(alertId => ({ tenantId: context.tenantId, alertId, userId: context.userId })), skipDuplicates: true }) : { count: 0 }
    return { marked: created.count, missing: ids.filter(id => !found.has(id)), unreadCount: await this.unreadOf(context.tenantId, context.userId, scope) }
  }

  async batchHandle(req: RequestWithContext, rawBody: unknown): Promise<AlertBatchHandleResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_HANDLE, {})
    const body = AlertBatchHandleBodySchema.parse(rawBody)
    const skipped: AlertBatchHandleResponse['skipped'] = []
    let handled = 0
    for (const id of [...new Set(body.ids)]) {
      try {
        await this.actions.close(req, id, { conclusion: 'HANDLED', ...(body.note ? { note: body.note } : {}) })
        handled += 1
      } catch (error) {
        // 不存在（含不在范围内）与已被他人处理是预期内的跳过；其余错误（数据库、权限）照常抛出
        if (error instanceof AppError && (error.getStatus() === 404 || error.getStatus() === 409)) skipped.push({ id, reason: error.message })
        else throw error
      }
    }
    return { handled, skipped, unreadCount: await this.unreadOf(context.tenantId, context.userId, scope) }
  }
}
