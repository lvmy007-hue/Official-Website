import { Injectable } from '@nestjs/common'
import { SAVED_VIEW_LIMIT, SavedViewCreateBodySchema, SavedViewListQuerySchema, SavedViewUpdateBodySchema } from '@nova/api-contracts'
import type { Prisma, SavedView } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

const LABEL = '视图'
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'
const json = (value: unknown) => value as Prisma.InputJsonValue

// 保存视图（P1-28-7）：个人视图只有本人可见和修改；共享视图企业成员都能使用，但只有创建人能改；
// 每人每页最多一个默认视图，设为默认时同一事务里取消原来的默认；视图保存的是筛选、列与排序，不保存数据。
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private toItem(row: SavedView, names: ReadonlyMap<string, string>, userId: string) {
    return {
      id: row.id,
      pageKey: row.pageKey,
      name: row.name,
      filter: row.filterJson,
      columns: row.columnsJson,
      sort: row.sortJson,
      shared: row.shared,
      isDefault: row.isDefault,
      mine: row.ownerId === userId,
      owner: { id: row.ownerId, name: nameOrFormer(names, row.ownerId) },
      version: row.version,
      updatedAt: row.updatedAt,
    }
  }

  async list(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = SavedViewListQuerySchema.parse(rawQuery)
    const rows = await this.prisma.savedView.findMany({
      where: { tenantId: context.tenantId, pageKey: query.pageKey, OR: [{ ownerId: context.userId }, { shared: true }] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.ownerId),
    )
    return { items: rows.map(row => this.toItem(row, names, context.userId)), limit: SAVED_VIEW_LIMIT }
  }

  async create(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.resolve(req)
    const body = SavedViewCreateBodySchema.parse(rawBody)
    const owned = await this.prisma.savedView.count({ where: { tenantId: context.tenantId, ownerId: context.userId, pageKey: body.pageKey } })
    if (owned >= SAVED_VIEW_LIMIT) throw appError('CONFLICT', `每个页面最多保存 ${SAVED_VIEW_LIMIT} 个视图，请先删除不用的`)
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.isDefault) await tx.savedView.updateMany({ where: { tenantId: context.tenantId, ownerId: context.userId, pageKey: body.pageKey, isDefault: true }, data: { isDefault: false } })
        return tx.savedView.create({
          data: {
            tenantId: context.tenantId,
            pageKey: body.pageKey,
            name: body.name,
            filterJson: json(body.filterJson),
            columnsJson: json(body.columnsJson),
            sortJson: json(body.sortJson),
            ownerId: context.userId,
            shared: body.shared,
            isDefault: body.isDefault,
          },
        })
      })
      return this.toItem(row, await memberNames(this.prisma, context.tenantId, [context.userId]), context.userId)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '你已经有一个同名的视图，请换一个名称', { fieldErrors: { name: ['视图名称已存在'] } })
      throw error
    }
  }

  private async ownView(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.savedView.findFirst({ where: { id, tenantId } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '视图不存在')
    if (row.ownerId !== userId) throw appError('TENANT_ACCESS_DENIED', '只有视图的创建人可以修改或删除它')
    return row
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.resolve(req)
    const body = SavedViewUpdateBodySchema.parse(rawBody)
    const current = await this.ownView(context.tenantId, context.userId, id)
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name
    if (body.filterJson !== undefined) data.filterJson = json(body.filterJson)
    if (body.columnsJson !== undefined) data.columnsJson = json(body.columnsJson)
    if (body.sortJson !== undefined) data.sortJson = json(body.sortJson)
    if (body.shared !== undefined) data.shared = body.shared
    if (body.isDefault !== undefined) data.isDefault = body.isDefault
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.isDefault)
          await tx.savedView.updateMany({ where: { tenantId: context.tenantId, ownerId: context.userId, pageKey: current.pageKey, isDefault: true, NOT: { id } }, data: { isDefault: false } })
        return updateWithVersion(tx.savedView, { id, tenantId: context.tenantId, ownerId: context.userId }, body.version, data, { label: LABEL })
      })
      return this.toItem(row, await memberNames(this.prisma, context.tenantId, [context.userId]), context.userId)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '你已经有一个同名的视图，请换一个名称', { fieldErrors: { name: ['视图名称已存在'] } })
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.resolve(req)
    await this.ownView(context.tenantId, context.userId, id)
    await this.prisma.savedView.deleteMany({ where: { id, tenantId: context.tenantId, ownerId: context.userId } })
    return { id }
  }
}
