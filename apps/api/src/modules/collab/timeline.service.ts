import { Injectable } from '@nestjs/common'
import { OPERATION_CATEGORY_LABEL, OPERATION_SCOPE_ENTITY, OperationLogCreateBodySchema, OperationLogListQuerySchema } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { EntityAccessService } from './entity-access.service'

/** 手工记录的发生时间最多比当前晚这么久（时钟误差），再晚的是填错了 */
const FUTURE_TOLERANCE_MS = 5 * 60_000

// 运营日志（P1-28-9）：对象事件时间线在 P6-06 并入 modules/events（统一事件接口）；
// 运营日志是运营人员手工记录的动作，需要 collab.write。两者都随对象读权限。
@Injectable()
export class TimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly access: EntityAccessService,
  ) {}

  async logs(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = OperationLogListQuerySchema.parse(rawQuery)
    await this.access.assertScopeReadable(context, query.scope, query.scopeRef)
    const rows = await this.prisma.operationLog.findMany({
      where: {
        tenantId: context.tenantId,
        scope: query.scope,
        scopeRef: query.scopeRef,
        ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    })
    const truncated = rows.length > query.limit
    const items = rows.slice(0, query.limit)
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      items.map(row => row.authorId),
    )
    return {
      items: items.map(row => ({
        id: row.id,
        occurredAt: row.occurredAt,
        category: row.category,
        categoryLabel: OPERATION_CATEGORY_LABEL[row.category as keyof typeof OPERATION_CATEGORY_LABEL] ?? '其他',
        text: row.text,
        author: { id: row.authorId, name: nameOrFormer(names, row.authorId) },
        mine: row.authorId === context.userId,
      })),
      truncated,
    }
  }

  async createLog(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'collab.write')
    const body = OperationLogCreateBodySchema.parse(rawBody)
    await this.access.assertScopeReadable(context, body.scope, body.scopeRef)
    const occurredAt = new Date(body.occurredAt)
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw appError('VALIDATION_FAILED', '发生时间不能晚于现在', { fieldErrors: { occurredAt: ['发生时间不能晚于现在'] } })
    const row = await this.prisma.operationLog.create({
      data: {
        tenantId: context.tenantId,
        sellerAccountId: OPERATION_SCOPE_ENTITY[body.scope] === 'STORE' ? body.scopeRef : null,
        scope: body.scope,
        scopeRef: body.scopeRef,
        occurredAt,
        category: body.category,
        text: body.text,
        authorId: context.userId,
        attachmentIds: [],
      },
    })
    return { id: row.id }
  }
}
