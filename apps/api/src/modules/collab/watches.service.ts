import { Injectable } from '@nestjs/common'
import { WATCH_LIMIT, WatchBodySchema } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { EntityAccessService } from './entity-access.service'

// 关注（P1-28-10）：只能关注自己能看到的对象；取消关注只能取消本人的关注。
@Injectable()
export class WatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly access: EntityAccessService,
  ) {}

  async add(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'collab.write')
    const body = WatchBodySchema.parse(rawBody)
    await this.access.assertReadable(context, body.entityType, body.entityId)
    const key = { userId: context.userId, entityType: body.entityType, entityId: body.entityId }
    const existing = await this.prisma.watch.findFirst({ where: { tenantId: context.tenantId, ...key }, select: { id: true } })
    if (existing) return { id: existing.id, created: false }
    const count = await this.prisma.watch.count({ where: { tenantId: context.tenantId, userId: context.userId } })
    if (count >= WATCH_LIMIT) throw appError('CONFLICT', `最多关注 ${WATCH_LIMIT} 个对象，请先取消一些不再关心的关注`)
    const row = await this.prisma.watch.create({ data: { tenantId: context.tenantId, ...key } })
    return { id: row.id, created: true }
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, 'collab.write')
    const result = await this.prisma.watch.deleteMany({ where: { id, tenantId: context.tenantId, userId: context.userId } })
    if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '关注记录不存在')
    return { id }
  }
}
