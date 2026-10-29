import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  GRID_VIEW_TEAM_LIMIT,
  GRID_VIEW_USER_LIMIT,
  GridViewCreateBodySchema,
  GridViewListQuerySchema,
  GridViewUpdateBodySchema,
  viewConfigOf,
  sortViews,
  type GridViewItem,
  type GridViewKind,
  type GridViewListResponse,
  type GridViewScope,
} from '@nova/api-contracts'
import type { GridView, Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'

const BASE = 'view.manage'
const SHARE = 'grid.view.share'
const LABEL = '视图'
const LIST_CAP = 200
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'
const json = (value: unknown) => value as Prisma.InputJsonValue
const NAME_CONFLICT = '这个表格里已经有同名视图，或默认视图刚被别人改过，请换个名称或刷新后重试'

type Context = Awaited<ReturnType<ContextService['resolve']>>

// 表格视图（P6-03，freeze/api.md 16.2）：一个视图保存列显示、顺序、列宽、固定、排序、筛选、维度，分三级——
//   系统（只读，由迁移或系统任务写入）、团队共享（需要 grid.view.share 才能写）、我的（本人可写，基础权限 view.manage）。
// 规则：
//   - 个人视图只有本人看得到、改得了；别人的个人视图一律 404（不暴露存在）；团队视图人人可看，没有共享权限的人改它得到 403（带缺失的权限点）；
//   - 系统视图任何成员都不能改、删、设默认（409）；
//   - 默认视图三级：我的默认 → 团队默认 → 系统默认（pickDefaultView）。设默认时同一事务里取消同级原来的默认；设默认不改版本号（它是指针，不是内容）；
//   - 同表格同类型下个人视图最多 20 个、团队视图最多 30 个（合计 50）；同名 409；
//   - 修改带乐观锁版本，冲突 409；内部直连与支持访问没有个人账号，不能写。
@Injectable()
export class GridViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private toItem(row: GridView, names: ReadonlyMap<string, string>, context: Context): GridViewItem {
    const scope = row.scope as GridViewScope
    const mine = scope === 'USER' && row.ownerUserId === context.userId
    const creator = row.createdBy ?? row.ownerUserId
    return {
      id: row.id,
      gridId: row.gridId,
      kind: row.kind as GridViewKind,
      scope,
      name: row.name,
      config: viewConfigOf(row.config),
      isDefault: row.isDefault,
      version: row.version,
      mine,
      canEdit: mine || (scope === 'TEAM' && hasPermission(context.permissions, SHARE)),
      owner: creator ? { id: creator, name: nameOrFormer(names, creator) } : null,
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private async items(context: Context, rows: GridView[]): Promise<GridViewItem[]> {
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.createdBy ?? row.ownerUserId),
    )
    return sortViews(rows.map(row => this.toItem(row, names, context)))
  }

  private writable(context: Context) {
    if (context.accessMode === 'INTERNAL_DIRECT' || context.accessMode === 'SUPPORT') throw appError('INTERNAL_ACCESS_UNSUPPORTED', '内部访问与支持访问模式没有个人账号，不能保存表格视图')
  }

  async list(req: RequestWithContext, rawQuery: unknown): Promise<GridViewListResponse> {
    const context = await this.context.authorize(req, BASE)
    const query = GridViewListQuerySchema.parse(rawQuery)
    const rows = await this.prisma.gridView.findMany({
      where: { tenantId: context.tenantId, gridId: query.gridId, kind: query.kind, OR: [{ scope: 'USER', ownerUserId: context.userId }, { scope: { in: ['TEAM', 'SYSTEM'] } }] },
      orderBy: [{ scope: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: LIST_CAP,
    })
    return { items: await this.items(context, rows), canShare: hasPermission(context.permissions, SHARE), limits: { user: GRID_VIEW_USER_LIMIT, team: GRID_VIEW_TEAM_LIMIT } }
  }

  /** 同一组（个人：同一人；团队：同一表格同一类型）的范围条件，用来数条数与取消原默认。 */
  private groupWhere(context: Context, row: { gridId: string; kind: string; scope: string }): Prisma.GridViewWhereInput {
    const common = { tenantId: context.tenantId, gridId: row.gridId, kind: row.kind }
    return row.scope === 'USER' ? { ...common, scope: 'USER', ownerUserId: context.userId } : { ...common, scope: row.scope }
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<GridViewItem> {
    const context = await this.context.authorize(req, BASE)
    this.writable(context)
    const body = GridViewCreateBodySchema.parse(rawBody)
    if (body.scope === 'TEAM') this.context.require(context, SHARE)
    const group = this.groupWhere(context, body)
    const limit = body.scope === 'TEAM' ? GRID_VIEW_TEAM_LIMIT : GRID_VIEW_USER_LIMIT
    try {
      const row = await this.prisma.$transaction(async tx => {
        if ((await tx.gridView.count({ where: group })) >= limit) throw appError('CONFLICT', `每个表格最多保存 ${limit} 个${body.scope === 'TEAM' ? '团队共享' : '个人'}视图，请先删除不用的`)
        if (body.isDefault) await tx.gridView.updateMany({ where: { ...group, isDefault: true }, data: { isDefault: false } })
        return tx.gridView.create({
          data: {
            tenantId: context.tenantId,
            gridId: body.gridId,
            kind: body.kind,
            scope: body.scope,
            ownerUserId: body.scope === 'USER' ? context.userId : null,
            createdBy: context.userId,
            name: body.name,
            config: json(body.config),
            isDefault: body.isDefault,
          },
        })
      })
      return (await this.items(context, [row]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['视图名称已存在'] } })
      throw error
    }
  }

  /** 找到可以修改的视图：别人的个人视图 404，系统视图 409，没有共享权限的团队视图 403。 */
  private async editable(context: Context, id: string): Promise<GridView> {
    const row = await this.prisma.gridView.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!row || (row.scope === 'USER' && row.ownerUserId !== context.userId)) throw appError('RESOURCE_NOT_FOUND', `${LABEL}不存在`)
    if (row.scope === 'SYSTEM') throw appError('CONFLICT', '系统视图由平台预置，不能修改、删除或设为默认；可以另存为自己的视图')
    if (row.scope === 'TEAM') this.context.require(context, SHARE)
    return row
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<GridViewItem> {
    const context = await this.context.authorize(req, BASE)
    this.writable(context)
    const body = GridViewUpdateBodySchema.parse(rawBody)
    if (body.name === undefined && body.config === undefined) throw appError('VALIDATION_FAILED', '没有需要保存的修改')
    const current = await this.editable(context, id)
    const data: Prisma.GridViewUpdateManyMutationInput = {}
    if (body.name !== undefined) data.name = body.name
    if (body.config !== undefined) data.config = json(body.config)
    try {
      const row = await updateWithVersion(this.prisma.gridView, { id: current.id, tenantId: context.tenantId }, body.version, data, { label: LABEL })
      return (await this.items(context, [row]))[0]!
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', NAME_CONFLICT, { fieldErrors: { name: ['视图名称已存在'] } })
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string): Promise<{ id: string }> {
    const context = await this.context.authorize(req, BASE)
    this.writable(context)
    const current = await this.editable(context, id)
    await this.prisma.gridView.deleteMany({ where: { id: current.id, tenantId: context.tenantId } })
    return { id: current.id }
  }

  async setDefault(req: RequestWithContext, id: string): Promise<GridViewItem> {
    const context = await this.context.authorize(req, BASE)
    this.writable(context)
    const current = await this.editable(context, id)
    const row = await this.prisma.$transaction(async tx => {
      await tx.gridView.updateMany({ where: { ...this.groupWhere(context, current), isDefault: true, NOT: { id: current.id } }, data: { isDefault: false } })
      await tx.gridView.updateMany({ where: { id: current.id, tenantId: context.tenantId }, data: { isDefault: true } })
      return tx.gridView.findFirstOrThrow({ where: { id: current.id, tenantId: context.tenantId } })
    })
    return (await this.items(context, [row]))[0]!
  }
}
