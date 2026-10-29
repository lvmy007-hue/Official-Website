import { Injectable } from '@nestjs/common'
import { CommentCreateBodySchema, CommentListQuerySchema, ENTITY_LABEL, entityDetailPath } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { NotifyService } from '../notifications'
import { EntityAccessService } from './entity-access.service'

const SORT = { field: 'createdAt', dir: 'desc' } as const

// 评论（P1-28-10）：随对象读权限查看，写入需要 collab.write；@ 到的成员收到站内通知。
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
    private readonly access: EntityAccessService,
    private readonly notify: NotifyService,
  ) {}

  async list(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = CommentListQuerySchema.parse(rawQuery)
    await this.access.assertReadable(context, query.entityType, query.entityId)
    const binding = bindingOf(context.tenantId, { entityType: query.entityType, entityId: query.entityId })
    const rows = await this.prisma.comment.findMany({
      where: { AND: [{ tenantId: context.tenantId, entityType: query.entityType, entityId: query.entityId }, this.cursor.after(query.cursor, SORT, binding) as Prisma.CommentWhereInput] },
      orderBy: this.cursor.orderBy(SORT),
      take: query.limit + 1,
    })
    const page = this.cursor.page(rows, { pageSize: query.limit, sort: SORT, binding })
    const mentionIds = page.items.flatMap(row => row.mentions)
    const names = await memberNames(this.prisma, context.tenantId, [...page.items.map(row => row.authorId), ...mentionIds])
    const [mine, watchers] = await Promise.all([
      this.prisma.watch.findFirst({ where: { tenantId: context.tenantId, userId: context.userId, entityType: query.entityType, entityId: query.entityId }, select: { id: true } }),
      this.prisma.watch.count({ where: { tenantId: context.tenantId, entityType: query.entityType, entityId: query.entityId } }),
    ])
    return {
      items: page.items.map(row => ({
        id: row.id,
        body: row.body,
        parentId: row.parentId,
        author: { id: row.authorId, name: nameOrFormer(names, row.authorId) },
        mentions: row.mentions.map(id => ({ id, name: nameOrFormer(names, id) })),
        createdAt: row.createdAt,
        mine: row.authorId === context.userId,
      })),
      pageInfo: page.pageInfo,
      watch: { watching: Boolean(mine), watchId: mine?.id ?? null, watchers },
    }
  }

  async create(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'collab.write')
    const body = CommentCreateBodySchema.parse(rawBody)
    await this.access.assertReadable(context, body.entityType, body.entityId)
    const mentions = [...new Set(body.mentions)]
    if (mentions.length > 0) {
      const members = await this.prisma.membership.findMany({ where: { tenantId: context.tenantId, status: 'ACTIVE', userId: { in: mentions } }, select: { userId: true }, take: mentions.length })
      if (members.length !== mentions.length) throw appError('VALIDATION_FAILED', '@ 的成员必须是企业的在职成员', { fieldErrors: { mentions: ['请选择企业内的在职成员'] } })
    }
    if (body.parentId) {
      const parent = await this.prisma.comment.findFirst({ where: { id: body.parentId, tenantId: context.tenantId, entityType: body.entityType, entityId: body.entityId }, select: { id: true } })
      if (!parent) throw appError('VALIDATION_FAILED', '要回复的评论不存在', { fieldErrors: { parentId: ['要回复的评论不存在'] } })
    }
    return this.prisma.$transaction(async tx => {
      const row = await tx.comment.create({
        data: { tenantId: context.tenantId, entityType: body.entityType, entityId: body.entityId, body: body.body, mentions, authorId: context.userId, parentId: body.parentId },
      })
      const targets = mentions.filter(id => id !== context.userId)
      if (targets.length > 0) {
        const name = (await memberNames(this.prisma, context.tenantId, [context.userId])).get(context.userId) ?? '同事'
        await this.notify.toUsers(
          context.tenantId,
          targets,
          {
            kind: 'MENTION',
            title: `${name} 在${ENTITY_LABEL[body.entityType] ?? '对象'}评论里提到了你`,
            body: body.body,
            link: entityDetailPath(body.entityType, body.entityId) ?? undefined,
            dedupKey: `mention:${row.id}`,
          },
          tx,
        )
      }
      return { id: row.id, createdAt: row.createdAt }
    })
  }
}
